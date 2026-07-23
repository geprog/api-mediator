import type {
  ApprovedMappingListResponse,
  ApprovedMappingTransitionResponse,
  ErrorResponse,
} from "@mediator/contracts";
import type { ApprovedMapping } from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "../../app-errors.js";
import {
  TEST_OPERATOR,
  TEST_OPERATOR_ACCOUNTS,
  TEST_OPERATOR_ALICE,
  TEST_VIEWER,
  injectAs,
} from "../../testing/auth.testkit.js";
import { LocalAccountsAuthProvider, installAuthentication } from "../auth/index.js";
import { registerErrorHandler } from "../errors.js";
import {
  registerApprovedMappingRoutes,
  type ApprovedMappingReader,
  type ApprovedMappingSuspensionMutator,
} from "./approved-mappings.routes.js";

/**
 * Route tests for the SL-10 `ApprovedMapping` lifecycle surface, driven with
 * `fastify.inject()` through the **real** operator-auth path (OA-1/OA-2) and an in-memory
 * double for the suspension service. They assert the HTTP contract — the role gate, the
 * delegation with the authenticated actor, and how the service's transition errors surface —
 * while the transition invariants themselves are the service's own tests.
 */

const MAPPING = "77777777-7777-4777-8777-777777777777";
const SOURCE_APP = "11111111-1111-4111-8111-111111111111";
const TARGET_APP = "22222222-2222-4222-8222-222222222222";

function mapping(overrides: Partial<ApprovedMapping> = {}): ApprovedMapping {
  return {
    id: MAPPING,
    sourceSpecId: "spec-source",
    targetSpecId: "spec-target",
    sourceAppId: SOURCE_APP,
    targetAppId: TARGET_APP,
    variant: "peer-peer",
    approvedBy: "reviewer:alice",
    approvedAt: new Date("2026-07-20T00:00:00.000Z"),
    status: "active",
    ...overrides,
  };
}

/** Records every transition call so the tests can assert the actor attribution (OA-3). */
class FakeSuspension implements ApprovedMappingSuspensionMutator {
  public readonly calls: { op: "suspend" | "resume"; mappingId: string; actor: string }[] = [];
  public error: Error | undefined;

  public constructor(private readonly result: ApprovedMapping = mapping()) {}

  public suspend(mappingId: string, actor: string): Promise<ApprovedMapping> {
    this.calls.push({ op: "suspend", mappingId, actor });
    return this.error !== undefined
      ? Promise.reject(this.error)
      : Promise.resolve({ ...this.result, status: "suspended" });
  }

  public resume(mappingId: string, actor: string): Promise<ApprovedMapping> {
    this.calls.push({ op: "resume", mappingId, actor });
    return this.error !== undefined
      ? Promise.reject(this.error)
      : Promise.resolve({ ...this.result, status: "active" });
  }
}

class FakeReader implements ApprovedMappingReader {
  public rows: ApprovedMapping[] = [];
  public listAll(): Promise<ApprovedMapping[]> {
    return Promise.resolve(this.rows);
  }
}

function buildApp(
  suspension: ApprovedMappingSuspensionMutator,
  reader: ApprovedMappingReader,
): FastifyInstance {
  const app = Fastify();
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
    registerApprovedMappingRoutes(instance, suspension, reader);
    return Promise.resolve();
  });
  registerErrorHandler(app);
  return app;
}

describe("GET /api/approved-mappings (SL-10 read)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("lists every mapping with its current status (viewer allowed)", async () => {
    const reader = new FakeReader();
    reader.rows = [mapping(), mapping({ id: "other", status: "suspended" })];
    app = buildApp(new FakeSuspension(), reader);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "GET",
      url: "/api/approved-mappings",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ApprovedMappingListResponse>();
    expect(body.mappings.map((entry) => entry.status)).toEqual(["active", "suspended"]);
    // Metadata only — no credential material, no IR payload, no reviewed field content.
    expect(response.body).not.toMatch(/secret|password|credential|rawdocument|payload/i);
  });
});

describe("POST /api/approved-mappings/:id/suspend (SL-10.1)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("suspends an active mapping and attributes it to the authenticated operator (OA-3)", async () => {
    const suspension = new FakeSuspension();
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR_ALICE, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/suspend`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ApprovedMappingTransitionResponse>().mapping.status).toBe("suspended");
    // The actor is the AUTHENTICATED identity, never a client-supplied value.
    expect(suspension.calls).toEqual([
      { op: "suspend", mappingId: MAPPING, actor: TEST_OPERATOR_ALICE.username },
    ]);
  });

  it("forbids a viewer (403) and never reaches the service (OA-2)", async () => {
    const suspension = new FakeSuspension();
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/suspend`,
    });

    expect(response.statusCode).toBe(403);
    // Rejected by the pre-handler BEFORE the handler runs — nothing was mutated.
    expect(suspension.calls).toEqual([]);
  });

  it("surfaces the service's 409 when the mapping is not active", async () => {
    const suspension = new FakeSuspension();
    suspension.error = new ConflictError(
      `Approved mapping ${MAPPING} is stale; only an active mapping can be suspended.`,
    );
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/suspend`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().message).toContain("only an active mapping");
  });

  it("404s an unknown mapping", async () => {
    const suspension = new FakeSuspension();
    suspension.error = new NotFoundError(`Approved mapping ${MAPPING} not found.`);
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/suspend`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("400s a malformed mapping id before any transition", async () => {
    const suspension = new FakeSuspension();
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: "/api/approved-mappings/not-a-uuid/suspend",
    });

    expect(response.statusCode).toBe(400);
    expect(suspension.calls).toEqual([]);
  });
});

describe("POST /api/approved-mappings/:id/resume (SL-10.2)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("resumes a suspended mapping, attributed to the authenticated operator (OA-3)", async () => {
    const suspension = new FakeSuspension(mapping({ status: "suspended" }));
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/resume`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ApprovedMappingTransitionResponse>().mapping.status).toBe("active");
    expect(suspension.calls).toEqual([
      { op: "resume", mappingId: MAPPING, actor: TEST_OPERATOR.username },
    ]);
  });

  it("forbids a viewer (403) and never reaches the service (OA-2)", async () => {
    const suspension = new FakeSuspension();
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/resume`,
    });

    expect(response.statusCode).toBe(403);
    expect(suspension.calls).toEqual([]);
  });

  it("surfaces the 409 for a suspended-then-stale mapping (needs re-review, not resume)", async () => {
    const suspension = new FakeSuspension();
    suspension.error = new ConflictError(
      `Approved mapping ${MAPPING} is stale: a breaking spec change marked it while it was suspended, so it needs re-review (its successor proposal) to become active again — resume does not apply.`,
    );
    app = buildApp(suspension, new FakeReader());

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/approved-mappings/${MAPPING}/resume`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().message).toContain("needs re-review");
  });
});
