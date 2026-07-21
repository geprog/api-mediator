import type { IssueAdapterTokenResponse } from "@mediator/contracts";
import type { CutoverResult, IssueTokenResult } from "@mediator/credentials";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { LocalAccountsAuthProvider, installAuthentication } from "../auth/index.js";
import { registerErrorHandler } from "../errors.js";
import {
  TEST_OPERATOR,
  TEST_OPERATOR_ACCOUNTS,
  TEST_VIEWER,
  injectAs,
} from "../../testing/auth.testkit.js";
import type { AdapterTokenIssuer } from "../../modules/adapter-token/index.js";
import { registerAdapterTokenRoutes } from "./adapter-token.routes.js";

/**
 * Route tests for the adapter-token control plane (AT-1/AT-4), driven with
 * `fastify.inject()` through the **real** operator-auth path (OA-1/OA-2) and a fake
 * {@link AdapterTokenIssuer}. They assert the HTTP contract: a viewer is forbidden
 * with no issuance, an operator gets the raw token exactly once, and the store
 * outcomes map to the right status codes. The issuance mechanics themselves are the
 * `@mediator/credentials` store's unit tests; here we cover the HTTP boundary.
 */

const APP_ID = "11111111-1111-4111-8111-111111111111";

/** A fake issuer returning scripted outcomes and recording each call's actor. */
class FakeIssuer implements AdapterTokenIssuer {
  public readonly calls: Array<{ op: string; appId: string; actor: string }> = [];
  public issueResult: IssueTokenResult = {
    outcome: "issued",
    token: {
      rawToken: "amt.raw.token",
      credentialId: "cred-1",
      issuedAt: new Date("2026-07-21T00:00:00.000Z"),
    },
    rotated: false,
  };
  public cutoverResult: CutoverResult = { outcome: "cutover", endedCredentialIds: ["cred-0"] };

  public issue(appId: string, actor: string): Promise<IssueTokenResult> {
    this.calls.push({ op: "issue", appId, actor });
    return Promise.resolve(this.issueResult);
  }
  public rotate(appId: string, actor: string): Promise<IssueTokenResult> {
    this.calls.push({ op: "rotate", appId, actor });
    return Promise.resolve(this.issueResult);
  }
  public cutover(appId: string, actor: string): Promise<CutoverResult> {
    this.calls.push({ op: "cutover", appId, actor });
    return Promise.resolve(this.cutoverResult);
  }
}

function buildApp(issuer: AdapterTokenIssuer): FastifyInstance {
  const app = Fastify();
  void app.register((instance) => {
    installAuthentication(instance, new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS));
    registerAdapterTokenRoutes(instance, issuer);
    return Promise.resolve();
  });
  registerErrorHandler(app);
  return app;
}

describe("POST /api/apps/:id/adapter-token (AT-1)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("issues a token to an operator, returning the raw value once, attributed", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<IssueAdapterTokenResponse>();
    expect(body.token).toBe("amt.raw.token");
    expect(body.credentialId).toBe("cred-1");
    expect(body.rotated).toBe(false);
    // Attributed to the authenticated operator identity (OA-3).
    expect(issuer.calls).toStrictEqual([{ op: "issue", appId: APP_ID, actor: "operator" }]);
  });

  it("forbids a viewer (403) and generates no token (AT-1.3)", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });

    expect(response.statusCode).toBe(403);
    expect(issuer.calls).toHaveLength(0);
    expect(response.body).not.toContain("amt.raw.token");
  });

  it("rejects an unauthenticated request (401) before issuance", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    const response = await app.inject({
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });
    expect(response.statusCode).toBe(401);
    expect(issuer.calls).toHaveLength(0);
  });

  it("maps a no-CONSUMER-spec app to 400 (AT-1.4)", async () => {
    const issuer = new FakeIssuer();
    issuer.issueResult = { outcome: "app-not-consumer" };
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("maps an unknown app to 404 and a disabled app to 409", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    issuer.issueResult = { outcome: "app-not-found" };
    const notFound = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });
    expect(notFound.statusCode).toBe(404);

    issuer.issueResult = { outcome: "app-not-active" };
    const disabled = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token`,
    });
    expect(disabled.statusCode).toBe(409);
  });
});

describe("POST /api/apps/:id/adapter-token/rotate and /cutover (AT-4)", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("rotates for an operator and returns the new token once", async () => {
    const issuer = new FakeIssuer();
    issuer.issueResult = {
      outcome: "issued",
      token: { rawToken: "amt.new.token", credentialId: "cred-2", issuedAt: new Date() },
      rotated: true,
    };
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token/rotate`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<IssueAdapterTokenResponse>();
    expect(body.token).toBe("amt.new.token");
    expect(body.rotated).toBe(true);
    expect(issuer.calls).toStrictEqual([{ op: "rotate", appId: APP_ID, actor: "operator" }]);
  });

  it("forbids a viewer from rotating (403), nothing changes (AT-4.6)", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_VIEWER, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token/rotate`,
    });
    expect(response.statusCode).toBe(403);
    expect(issuer.calls).toHaveLength(0);
  });

  it("cutover returns the ended credential ids for an operator", async () => {
    const issuer = new FakeIssuer();
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token/cutover`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ endedCredentialIds: string[] }>().endedCredentialIds).toStrictEqual([
      "cred-0",
    ]);
  });

  it("cutover with no overlap is an idempotent 200 with an empty list", async () => {
    const issuer = new FakeIssuer();
    issuer.cutoverResult = { outcome: "nothing-to-cutover" };
    app = buildApp(issuer);

    const response = await injectAs(app, TEST_OPERATOR, {
      method: "POST",
      url: `/api/apps/${APP_ID}/adapter-token/cutover`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ endedCredentialIds: string[] }>().endedCredentialIds).toStrictEqual([]);
  });
});
