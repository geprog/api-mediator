import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  AuditLogEntry,
  RegisteredApp,
  ResourceBinding,
  ScopeCorrespondence,
  ScopeLink,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  AuditLogRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
} from "./repositories/index.js";
import {
  apiSpec,
  auditLog,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
  scopeCorrespondence,
  scopeLink,
} from "./schema.js";

/**
 * SS-16 — live-database integration for the persistence primitives the scope-artifact
 * re-validation lifecycle relies on. Each requires a REAL database (the fakes-mirror-real
 * standing rule): the SQL `LIKE` prefix push-down + `OFFSET` paging that keeps a bounded
 * park scan from crowding out genuine entries; the `establishedBy`-filtered, active-only
 * `ScopeLink` archive; and the whole-binding re-validation write (jsonb columns + normalized
 * ref rows) that returns a confirmed ref to unconfirmed and deletes an absent one.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`. Self-skips when
 * `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CONTAINER_PREFIX = "ambiguous container match";
const IDENTITY_PREFIX = "ambiguous identity match";

suite("SS-16 scope-revalidation persistence (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  // ── AuditLogRepository.querySyncEvents — detailsPrefix + offset (crowding-out) ──

  describe("querySyncEvents detailsPrefix + offset", () => {
    const ruleId = randomUUID();

    afterEach(async () => {
      await db.delete(auditLog).where(eq(auditLog.relatedRuleId, ruleId));
    });

    function failureRow(details: string, at: string): AuditLogEntry {
      return {
        id: randomUUID(),
        type: "sync-execution",
        actor: "system",
        status: "failure",
        relatedRuleId: ruleId,
        details,
        timestamp: new Date(at),
      };
    }

    it("pushes the family prefix into SQL so a bounded scan is not crowded out", async () => {
      const audit = new AuditLogRepository(db);
      // 30 NEWER unrelated write failures, then 2 OLDER genuine container parks. Under the
      // pre-SS-16 read (`{ status: failure, limit: 5 }`) the newest 5 are all write
      // failures and the parks are invisible; the prefix filter makes `limit` bound parks.
      const rows: AuditLogEntry[] = [];
      for (let i = 0; i < 30; i++) {
        rows.push(
          failureRow(
            `write failed: 500 upstream #${String(i)}`,
            `2026-07-13T12:${String(i).padStart(2, "0")}:00.000Z`,
          ),
        );
      }
      rows.push(
        failureRow(
          `${CONTAINER_PREFIX}: 1 candidate containers [7] :: {}`,
          "2026-07-13T10:00:00.000Z",
        ),
      );
      rows.push(
        failureRow(
          `${CONTAINER_PREFIX}: 1 candidate containers [8] :: {}`,
          "2026-07-13T10:01:00.000Z",
        ),
      );
      for (const row of rows) {
        await audit.insert(row);
      }

      const withoutPrefix = await audit.querySyncEvents({ status: "failure", limit: 5 });
      expect(withoutPrefix.every((r) => r.details?.startsWith(CONTAINER_PREFIX))).toBe(false);

      const parks = await audit.querySyncEvents({
        status: "failure",
        detailsPrefix: CONTAINER_PREFIX,
        limit: 5,
      });
      expect(parks).toHaveLength(2);
      expect(parks.every((r) => r.details?.startsWith(CONTAINER_PREFIX))).toBe(true);
      // The identity-match family is not matched by the container prefix.
      expect(parks.every((r) => !r.details?.startsWith(IDENTITY_PREFIX))).toBe(true);
    });

    it("pages with offset, newest-first, without widening the limit", async () => {
      const audit = new AuditLogRepository(db);
      for (let i = 0; i < 5; i++) {
        await audit.insert(
          failureRow(
            `${CONTAINER_PREFIX}: park #${String(i)} :: {}`,
            `2026-07-13T10:0${String(i)}:00.000Z`,
          ),
        );
      }
      const page1 = await audit.querySyncEvents({
        status: "failure",
        detailsPrefix: CONTAINER_PREFIX,
        limit: 2,
        offset: 0,
      });
      const page2 = await audit.querySyncEvents({
        status: "failure",
        detailsPrefix: CONTAINER_PREFIX,
        limit: 2,
        offset: 2,
      });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // Disjoint pages (newest-first): #4,#3 then #2,#1.
      expect(page1[0]?.details).toContain("park #4");
      expect(page2[0]?.details).toContain("park #2");
    });

    it("treats LIKE metacharacters in the prefix literally (no widening)", async () => {
      const audit = new AuditLogRepository(db);
      await audit.insert(failureRow("100% failure of the widget", "2026-07-13T10:00:00.000Z"));
      await audit.insert(failureRow("100 failures of the widget", "2026-07-13T10:01:00.000Z"));
      // `%` in the prefix must match a literal percent, not "any run of chars".
      const matched = await audit.querySyncEvents({
        status: "failure",
        detailsPrefix: "100%",
        limit: 10,
      });
      expect(matched).toHaveLength(1);
      expect(matched[0]?.details).toBe("100% failure of the widget");
    });
  });

  // ── ScopeLinkRepository.archiveByCorrespondence — establishedBy filter, active-only ──

  describe("archiveByCorrespondence establishedBy filter", () => {
    const pair = `sixteen-a:issues|sixteen-b:tasks`;
    const corrId = randomUUID();

    function makeCorrespondence(): ScopeCorrespondence {
      return {
        id: corrId,
        resourcePairRef: pair,
        scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "title" }],
        targetContainerRef: { appId: randomUUID(), resourceRef: "projects" },
        sourceContainerRef: { appId: randomUUID(), resourceRef: "repos" },
        confirmedBy: "op@example.test",
        confirmedAt: new Date("2026-07-17T00:00:00.000Z"),
      };
    }
    function makeLink(overrides: Partial<ScopeLink>): ScopeLink {
      return {
        id: randomUUID(),
        scopeCorrespondenceId: corrId,
        appAId: randomUUID(),
        appAScopeKey: { owner: "alice", name: "phoenix" },
        appBId: randomUUID(),
        appBScopeKey: { id: "42" },
        resourcePairRef: pair,
        establishedBy: "identity-match",
        status: "active",
        createdAt: new Date("2026-07-17T00:00:00.000Z"),
        ...overrides,
      };
    }

    afterEach(async () => {
      await db.delete(scopeLink).where(eq(scopeLink.scopeCorrespondenceId, corrId));
      await db.delete(scopeCorrespondence).where(eq(scopeCorrespondence.id, corrId));
    });

    it("SS-16.4: archives ONLY identity-match links, leaving constant/manual active", async () => {
      const corrRepo = new ScopeCorrespondenceRepository(db);
      const linkRepo = new ScopeLinkRepository(db);
      await corrRepo.create(makeCorrespondence());
      const idm = makeLink({ establishedBy: "identity-match", appBScopeKey: { id: "42" } });
      const constant = makeLink({ establishedBy: "constant", appBScopeKey: { id: "43" } });
      const manual = makeLink({ establishedBy: "manual", appBScopeKey: { id: "44" } });
      await linkRepo.create(idm);
      await linkRepo.create(constant);
      await linkRepo.create(manual);

      const archived = await linkRepo.archiveByCorrespondence(corrId, {
        establishedBy: "identity-match",
      });
      expect(archived).toBe(1);

      const all = await linkRepo.listByCorrespondence(corrId);
      const byId = new Map(all.map((l) => [l.id, l.status]));
      expect(byId.get(idm.id)).toBe("archived");
      expect(byId.get(constant.id)).toBe("active");
      expect(byId.get(manual.id)).toBe("active");
    });

    it("SS-16.5: unfiltered archive flips every ACTIVE link (already-archived untouched, count exact)", async () => {
      const corrRepo = new ScopeCorrespondenceRepository(db);
      const linkRepo = new ScopeLinkRepository(db);
      await corrRepo.create(makeCorrespondence());
      const active1 = makeLink({ appBScopeKey: { id: "42" } });
      const active2 = makeLink({ establishedBy: "manual", appBScopeKey: { id: "43" } });
      const alreadyArchived = makeLink({ status: "archived", appBScopeKey: { id: "44" } });
      await linkRepo.create(active1);
      await linkRepo.create(active2);
      await linkRepo.create(alreadyArchived);

      const archived = await linkRepo.archiveByCorrespondence(corrId);
      // Only the two ACTIVE rows are flipped; the already-archived one is not re-counted.
      expect(archived).toBe(2);
      const all = await linkRepo.listByCorrespondence(corrId);
      expect(all.every((l) => l.status === "archived")).toBe(true);
      // A second run is a no-op.
      expect(await linkRepo.archiveByCorrespondence(corrId)).toBe(0);
    });
  });

  // ── ResourceBindingRepository.replaceRevalidated — whole-binding write ─────────

  describe("replaceRevalidated whole-binding write", () => {
    const appId = randomUUID();
    const specId = randomUUID();
    const bindingId = randomUUID();
    const confirmedAt = new Date("2026-07-18T00:00:00.000Z");

    const app: RegisteredApp = {
      id: appId,
      name: "Gitea",
      status: "active",
      baseUrl: "https://gitea.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60000,
      },
      createdAt: confirmedAt,
    };
    const spec: ApiSpec = {
      id: specId,
      appId,
      role: "PROVIDER",
      rawDocument: { openapi: "3.1.0", info: { title: "Gitea", version: "1" } },
      parsedIR: [
        {
          resourceRef: "issues",
          name: "issues",
          operations: [],
          schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
          crossResourceRefs: [],
        },
      ],
      analysisExclusions: [],
      version: 1,
      contentHash: "sha256:ss16-replace",
      status: "active",
      createdAt: confirmedAt,
    };
    // Confirmed native id + a confirmed record-address ref + a confirmed scope constant.
    const stored: ResourceBinding = {
      id: bindingId,
      apiSpecId: specId,
      resourceRef: "issues",
      nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: "op", confirmedAt },
      recordAddressRef: {
        value: { kind: "field", path: "number" },
        confirmedBy: "op",
        confirmedAt,
      },
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "owner",
          value: "alice",
          confirmedBy: "op",
          confirmedAt,
        },
      ],
    };

    beforeAll(async () => {
      await tx(db, async (txn) => {
        await new RegisteredAppRepository(txn).create(app);
        await new ApiSpecRepository(txn).create(spec);
        await new ResourceBindingRepository(txn).createMany([stored]);
      });
    });

    afterAll(async () => {
      await db
        .delete(resourceBindingRef)
        .where(eq(resourceBindingRef.resourceBindingId, bindingId));
      await db.delete(resourceBinding).where(eq(resourceBinding.apiSpecId, specId));
      await db.delete(apiSpec).where(eq(apiSpec.id, specId));
      await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    });

    it("returns a confirmed ref to unconfirmed, adds a scope binding, and deletes an absent ref", async () => {
      const repo = new ResourceBindingRepository(db);
      // The re-validation output: recordAddressRef returned to unconfirmed (its address
      // field broke), nativeIdRef DROPPED (absent), a new unconfirmed scope binding added.
      const revalidated: ResourceBinding = {
        id: bindingId,
        apiSpecId: specId,
        resourceRef: "issues",
        recordAddressRef: {
          value: { kind: "field", path: "number" },
          confirmedBy: null,
          confirmedAt: null,
        },
        scopePathBindings: [
          {
            kind: "constant",
            parameterName: "owner",
            value: "alice",
            confirmedBy: "op",
            confirmedAt,
          },
          {
            kind: "constant",
            parameterName: "repo",
            value: "",
            confirmedBy: null,
            confirmedAt: null,
          },
        ],
      };
      const written = await repo.replaceRevalidated(revalidated);
      expect(written).toBeDefined();

      const reloaded = await repo.getById(bindingId);
      // recordAddressRef retained but unconfirmed (NOT dropped — SS-19 native-id reinstate guard).
      expect(reloaded?.recordAddressRef?.value).toStrictEqual({ kind: "field", path: "number" });
      expect(reloaded?.recordAddressRef?.confirmedBy).toBeNull();
      // nativeIdRef row deleted (absent on the revalidated binding).
      expect(reloaded?.nativeIdRef).toBeUndefined();
      // The new scope binding is present and unconfirmed; the pre-existing one carried forward.
      const byName = new Map((reloaded?.scopePathBindings ?? []).map((e) => [e.parameterName, e]));
      expect(byName.get("owner")?.confirmedBy).toBe("op");
      expect(byName.get("repo")?.confirmedBy).toBeNull();
    });
  });
});
