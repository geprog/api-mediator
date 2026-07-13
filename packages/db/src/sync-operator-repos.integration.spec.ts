import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  FieldMapping,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  SyncRuleRepository,
} from "./repositories/index.js";
import {
  apiSpec,
  approvedMapping,
  auditLog,
  fieldMapping,
  registeredApp,
  syncRule,
} from "./schema.js";

/**
 * Live-database integration test for the **Sync HTTP API repo methods** (SA-1/SA-2):
 * `SyncRuleRepository.updateConfig` + `listAll`,
 * `MappingArtifactsRepository.setFieldMappingConflictPolicy`, and
 * `AuditLogRepository.querySyncEvents`. Each uses **existing columns only** (no
 * migration). The partial-`set` / null-clear / type-restriction semantics are
 * real-Postgres properties, so they are proven here against real Postgres + the full
 * migration chain.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const MAPPING = randomUUID();
const RULE = randomUUID();
const CREATED_AT = new Date("2026-07-13T00:00:00.000Z");

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function mappingOf(): ApprovedMapping {
  return {
    id: MAPPING,
    sourceSpecId: SPEC_A,
    targetSpecId: SPEC_B,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}
function pendingRuleOf(id: string, pair: string): SyncRule {
  return {
    id,
    approvedMappingId: MAPPING,
    resourcePairRef: pair,
    status: "disabled",
    backfillStatus: "pending",
  };
}

suite("Sync HTTP API repo methods (SA-1/SA-2) — live Postgres", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await db.delete(auditLog);
    await db.delete(fieldMapping);
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A));
      await specs.create(specOf(SPEC_B, APP_B));
      await new ApprovedMappingRepository(txn).insert(mappingOf());
    });
  });

  beforeEach(async () => {
    await db.delete(auditLog);
    await db.delete(fieldMapping);
    await db.delete(syncRule);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(
      pendingRuleOf(RULE, "pair::widgets"),
    );
  });

  afterAll(async () => {
    await db.delete(auditLog);
    await db.delete(fieldMapping);
    await db.delete(syncRule);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  // ── SyncRuleRepository.updateConfig (SA-1.1/1.2) ─────────────────────────────

  it("updateConfig persists execution options (existing columns, no migration)", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.updateConfig(RULE, {
      pollIntervalOverride: 30_000,
      pollOperationRef: "widgets/listWidgets",
      deletePropagation: "propagate",
      targetDriftCheck: "read-before-write",
      backfillMode: "push",
    });

    const rule = await repo.getById(RULE);
    expect(rule?.pollIntervalOverride).toBe(30_000);
    expect(rule?.pollOperationRef).toBe("widgets/listWidgets");
    expect(rule?.deletePropagation).toBe("propagate");
    expect(rule?.targetDriftCheck).toBe("read-before-write");
    expect(rule?.backfillMode).toBe("push");
    // Untouched — status stays disabled (config never enables).
    expect(rule?.status).toBe("disabled");
  });

  it("updateConfig writes ONLY the provided fields (partial set)", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.updateConfig(RULE, { deletePropagation: "propagate" });
    await repo.updateConfig(RULE, { targetDriftCheck: "read-before-write" });

    const rule = await repo.getById(RULE);
    // The first field survived the second, unrelated update.
    expect(rule?.deletePropagation).toBe("propagate");
    expect(rule?.targetDriftCheck).toBe("read-before-write");
    expect(rule?.pollOperationRef ?? null).toBeNull();
  });

  it("updateConfig with pollIntervalOverride: null clears the override", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.updateConfig(RULE, { pollIntervalOverride: 15_000 });
    expect((await repo.getById(RULE))?.pollIntervalOverride).toBe(15_000);

    await repo.updateConfig(RULE, { pollIntervalOverride: null });
    expect((await repo.getById(RULE))?.pollIntervalOverride ?? null).toBeNull();
  });

  it("updateConfig with an empty patch is a no-op", async () => {
    const repo = new SyncRuleRepository(db);
    await repo.updateConfig(RULE, { deletePropagation: "propagate" });
    await repo.updateConfig(RULE, {});
    expect((await repo.getById(RULE))?.deletePropagation).toBe("propagate");
  });

  it("listAll returns every rule, id-ordered", async () => {
    const artifacts = new DownstreamArtifactRepository(db);
    const second = randomUUID();
    await artifacts.insertSyncRuleIfAbsent(pendingRuleOf(second, "pair::gadgets"));

    const repo = new SyncRuleRepository(db);
    const rules = await repo.listAll();
    expect(new Set(rules.map((r) => r.id))).toStrictEqual(new Set([RULE, second]));
    const ids = rules.map((r) => r.id);
    expect([...ids]).toStrictEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  // ── MappingArtifactsRepository.setFieldMappingConflictPolicy (SA-1.1) ────────

  it("setFieldMappingConflictPolicy sets and clears a peer-peer FieldMapping's policy", async () => {
    const fieldId = randomUUID();
    const artifacts = new MappingArtifactsRepository(db);
    const field: FieldMapping = {
      id: fieldId,
      mappingId: MAPPING,
      sourcePath: "status",
      targetPath: "status",
      transform: "rename",
    };
    await artifacts.replaceChildren(MAPPING, {
      fieldMappings: [field],
      operationMappings: [],
      parameterMappings: [],
    });

    await artifacts.setFieldMappingConflictPolicy(fieldId, "manual-resolve");
    const set = await artifacts.listFieldMappings(MAPPING);
    expect(set.find((f) => f.id === fieldId)?.conflictPolicy).toBe("manual-resolve");

    await artifacts.setFieldMappingConflictPolicy(fieldId, null);
    const cleared = await artifacts.listFieldMappings(MAPPING);
    expect(cleared.find((f) => f.id === fieldId)?.conflictPolicy ?? null).toBeNull();

    // Tidy up so the mapping's children do not leak into other tests.
    await artifacts.replaceChildren(MAPPING, {
      fieldMappings: [],
      operationMappings: [],
      parameterMappings: [],
    });
  });

  // ── AuditLogRepository.querySyncEvents (SA-2.3) ──────────────────────────────

  it("querySyncEvents returns sync rows filtered by rule/record/status; excludes non-sync types", async () => {
    const audit = new AuditLogRepository(db);
    const linkId = randomUUID();
    const otherRule = randomUUID();

    const rows: AuditLogEntry[] = [
      {
        id: randomUUID(),
        type: "sync-execution",
        actor: "system",
        status: "success",
        relatedRuleId: RULE,
        recordLinkId: linkId,
        sourceNativeId: "a1",
        timestamp: new Date("2026-07-13T10:00:00.000Z"),
      },
      {
        id: randomUUID(),
        type: "sync-execution",
        actor: "system",
        status: "failure",
        relatedRuleId: RULE,
        sourceNativeId: "a2",
        details: "ambiguous identity match: 2 candidates [t1, t2]",
        timestamp: new Date("2026-07-13T10:01:00.000Z"),
      },
      {
        id: randomUUID(),
        type: "poll-run",
        actor: "system",
        status: "success",
        relatedRuleId: otherRule,
        timestamp: new Date("2026-07-13T10:02:00.000Z"),
      },
      // A non-sync type — must be excluded from the sync audit log.
      {
        id: randomUUID(),
        type: "mapping-decision",
        actor: "operator",
        decision: "approve",
        relatedMappingId: MAPPING,
        timestamp: new Date("2026-07-13T10:03:00.000Z"),
      },
    ];
    for (const row of rows) {
      await audit.insert(row);
    }

    // Unfiltered (except type restriction): the 3 sync rows, newest-first.
    const all = await audit.querySyncEvents({ limit: 50 });
    expect(all.map((r) => r.type).sort()).toStrictEqual([
      "poll-run",
      "sync-execution",
      "sync-execution",
    ]);
    expect(all.every((r) => r.type !== "mapping-decision")).toBe(true);

    // Filter by rule.
    const byRule = await audit.querySyncEvents({ relatedRuleId: RULE, limit: 50 });
    expect(byRule.map((r) => r.sourceNativeId).sort()).toStrictEqual(["a1", "a2"]);

    // Filter by record link.
    const byLink = await audit.querySyncEvents({ recordLinkId: linkId, limit: 50 });
    expect(byLink).toHaveLength(1);
    expect(byLink[0]?.sourceNativeId).toBe("a1");

    // Filter by status.
    const byStatus = await audit.querySyncEvents({ status: "failure", limit: 50 });
    expect(byStatus).toHaveLength(1);
    expect(byStatus[0]?.details).toContain("ambiguous identity match");

    // Filter by source native id.
    const byNative = await audit.querySyncEvents({ sourceNativeId: "a1", limit: 50 });
    expect(byNative).toHaveLength(1);
    expect(byNative[0]?.status).toBe("success");

    // Limit bounds the scan.
    const bounded = await audit.querySyncEvents({ limit: 1 });
    expect(bounded).toHaveLength(1);
  });
});
