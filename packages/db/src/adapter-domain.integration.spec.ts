import { randomUUID } from "node:crypto";

import type {
  AdapterBinding,
  AdapterEndpoint,
  AdapterWriteOutcome,
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  Credential,
  RegisteredApp,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { mapAdapterBindingRow, mapAdapterEndpointRow, mapAuditLogRow } from "./mappers/index.js";
import { runMigrations } from "./migrate.js";
import {
  AdapterWriteOutcomeRepository,
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  CredentialRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
} from "./repositories/index.js";
import {
  adapterBinding,
  adapterEndpoint,
  adapterWriteOutcome,
  apiSpec,
  approvedMapping,
  auditLog,
  credential,
  registeredApp,
} from "./schema.js";

/**
 * Live-database integration test for the Phase-5 adapter domain (AD-1..AD-6). It
 * is the real-Postgres counterpart to the `@mediator/domain` schema unit tests and
 * the standing rule that a fake-only proof has repeatedly missed real defects here.
 *
 * Proves against a freshly migrated schema (chain 0000→0021): that a Phase-3-shaped
 * `adapter_endpoint`/`adapter_binding` row loads with every Phase-5 field absent
 * (AD-6.2); that a fully composed endpoint (incl. the `postMergePagination` `Date`
 * rehydration) and a chained binding round-trip; that the same-endpoint composite
 * FK rejects a cross-endpoint dependency (AD-6.3); that endpoint deletion cascades
 * to bindings and write-outcome rows (AD-6.4); the bounded write-outcome store's
 * dedup/metadata/expiry semantics (AD-4); `Credential.validUntil` round-trip and
 * the "still valid" query (AD-3.3); and the `adapter-request` audit columns (AD-5).
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded
 * from `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_CONSUMER = randomUUID();
const APP_BACKEND = randomUUID();
const SPEC_CONSUMER = randomUUID();
const SPEC_BACKEND = randomUUID();
const CP_MAPPING = randomUUID();
const CREATED_AT = new Date("2026-07-20T00:00:00.000Z");

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: false,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string, role: ApiSpec["role"]): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function cpMapping(): ApprovedMapping {
  return {
    id: CP_MAPPING,
    sourceSpecId: SPEC_CONSUMER,
    targetSpecId: SPEC_BACKEND,
    sourceAppId: APP_CONSUMER,
    targetAppId: APP_BACKEND,
    variant: "consumer-provider",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

suite("Phase-5 adapter-domain persistence integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);

    // Clean slate for the tables this suite touches (children first, FK order).
    await db.delete(adapterWriteOutcome);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(auditLog);
    await db.delete(credential);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_CONSUMER, "consumer"));
      await apps.create(appOf(APP_BACKEND, "backend"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_CONSUMER, APP_CONSUMER, "CONSUMER"));
      await specs.create(specOf(SPEC_BACKEND, APP_BACKEND, "PROVIDER"));
      await new ApprovedMappingRepository(txn).insert(cpMapping());
    });
  });

  afterAll(async () => {
    // Leave a clean slate for sibling integration files (they run serially and
    // clear only the tables they touch): our `credential` rows would otherwise
    // block their `registered_app` cleanup.
    await db.delete(adapterWriteOutcome);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(auditLog);
    await db.delete(credential);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("loads a Phase-3-shaped endpoint/binding with every Phase-5 field absent (AD-6.2)", async () => {
    const endpointId = randomUUID();
    const bindingId = randomUUID();
    // Insert exactly the AM-6 minimal columns Phase-3 AI-2 wrote — no Phase-5
    // columns at all, so they land NULL, mirroring a genuine pre-Phase-5 row.
    await db.insert(adapterEndpoint).values({
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "getMinimal",
      status: "composition-required",
    });
    await db.insert(adapterBinding).values({
      id: bindingId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "getBackendMinimal",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "proposed",
    });

    const [endpointRow] = await db
      .select()
      .from(adapterEndpoint)
      .where(eq(adapterEndpoint.id, endpointId));
    const [bindingRow] = await db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.id, bindingId));
    expect(endpointRow).toBeDefined();
    expect(bindingRow).toBeDefined();
    if (endpointRow === undefined || bindingRow === undefined) {
      return;
    }
    const endpoint = mapAdapterEndpointRow(endpointRow);
    const binding = mapAdapterBindingRow(bindingRow);
    expect(Object.keys(endpoint).sort()).toEqual(
      ["consumerAppId", "consumerOperationId", "id", "status"].sort(),
    );
    expect(binding).not.toHaveProperty("executionOrder");
    expect(binding).not.toHaveProperty("dependsOnBindingId");
    expect(binding).not.toHaveProperty("chainInputs");
  });

  it("round-trips a fully composed collection-union endpoint incl. postMergePagination Date (AD-1)", async () => {
    const endpointId = randomUUID();
    const composed: AdapterEndpoint = {
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "listUnion",
      status: "active",
      aggregationStrategy: "collection-union",
      cacheTtl: 30_000,
      strictness: "strict",
      postMergeFilters: [
        { consumerParamRef: "status", consumerFieldPath: "state", operator: "eq" },
      ],
      postMergeSorts: [
        {
          consumerParamRef: "sort",
          paramValue: "name",
          consumerFieldPath: "name",
          direction: "asc",
        },
      ],
      postMergePagination: {
        convention: {
          convention: "page-number",
          pageParamRef: "page",
          sizeParamRef: "perPage",
          firstPageNumber: 1,
        },
        confirmedBy: "operator@example.test",
        confirmedAt: new Date("2026-07-20T09:30:00.000Z"),
      },
      postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "email" },
    };
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint(composed);

    const loaded = await repo.getAdapterEndpoint(APP_CONSUMER, "listUnion");
    expect(loaded).toEqual(composed);
    // The jsonb-stored confirmedAt rehydrates to a real Date, not a string.
    expect(loaded?.postMergePagination?.confirmedAt).toBeInstanceOf(Date);
  });

  it("round-trips a chained binding (executionOrder/dependsOnBindingId/chainInputs, AD-2)", async () => {
    const endpointId = randomUUID();
    const primaryId = randomUUID();
    const supplementId = randomUUID();
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint({
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "getChained",
      status: "active",
      aggregationStrategy: "fanout-merge",
    });
    const primary: AdapterBinding = {
      id: primaryId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "getPrimary",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
      executionOrder: 0,
    };
    const supplement: AdapterBinding = {
      id: supplementId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "getSupplement",
      approvedMappingId: CP_MAPPING,
      role: "supplement",
      status: "active",
      executionOrder: 1,
      dependsOnBindingId: primaryId,
      chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "userId", transform: "rename" }],
    };
    // Insert the upstream first (the composite FK references it).
    await repo.insertAdapterBindingIfAbsent(primary);
    await repo.insertAdapterBindingIfAbsent(supplement);

    const bindings = await repo.listAdapterBindingsByMapping(CP_MAPPING);
    const loadedSupplement = bindings.find((b) => b.id === supplementId);
    expect(loadedSupplement).toEqual(supplement);
  });

  it("rejects a cross-endpoint dependsOnBindingId at the DB level (AD-6.3)", async () => {
    const endpointA = randomUUID();
    const endpointB = randomUUID();
    const bindingA = randomUUID();
    const bindingB = randomUUID();
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint({
      id: endpointA,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "epA",
      status: "active",
      aggregationStrategy: "fanout-merge",
    });
    await repo.ensureAdapterEndpoint({
      id: endpointB,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "epB",
      status: "active",
      aggregationStrategy: "fanout-merge",
    });
    await db.insert(adapterBinding).values({
      id: bindingA,
      adapterEndpointId: endpointA,
      backendAppId: APP_BACKEND,
      backendOperationId: "opA",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
    });
    await db.insert(adapterBinding).values({
      id: bindingB,
      adapterEndpointId: endpointB,
      backendAppId: APP_BACKEND,
      backendOperationId: "opB",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
    });
    // bindingA (endpoint A) depending on bindingB (endpoint B) is a cross-endpoint
    // dependency — the composite FK must reject it.
    await expect(
      db
        .update(adapterBinding)
        .set({ dependsOnBindingId: bindingB })
        .where(eq(adapterBinding.id, bindingA)),
    ).rejects.toThrow();
  });

  it("cascades endpoint deletion to bindings and write-outcome rows (AD-6.4)", async () => {
    const endpointId = randomUUID();
    const bindingId = randomUUID();
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint({
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "createCascade",
      status: "active",
      aggregationStrategy: "single",
    });
    await db.insert(adapterBinding).values({
      id: bindingId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "createBackend",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
    });
    await new AdapterWriteOutcomeRepository(db).recordOutcomeIfAbsent({
      id: randomUUID(),
      idempotencyKey: "cascade-key",
      adapterEndpointId: endpointId,
      adapterBindingId: bindingId,
      result: { outcome: "success", responseStatus: 201, responseBody: { id: 7 } },
      executedAt: CREATED_AT,
      expiresAt: new Date("2026-07-20T01:00:00.000Z"),
    });

    await db.delete(adapterEndpoint).where(eq(adapterEndpoint.id, endpointId));

    const bindingsLeft = await db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.adapterEndpointId, endpointId));
    const outcomesLeft = await db
      .select()
      .from(adapterWriteOutcome)
      .where(eq(adapterWriteOutcome.adapterEndpointId, endpointId));
    expect(bindingsLeft).toHaveLength(0);
    expect(outcomesLeft).toHaveLength(0);
  });

  it("dedups write outcomes, replays the original, and hides the body from metadata (AD-4)", async () => {
    const endpointId = randomUUID();
    const bindingId = randomUUID();
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint({
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "writeDedup",
      status: "active",
      aggregationStrategy: "single",
    });
    await db.insert(adapterBinding).values({
      id: bindingId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "writeBackend",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
    });
    const store = new AdapterWriteOutcomeRepository(db);
    const original: AdapterWriteOutcome = {
      id: randomUUID(),
      idempotencyKey: "dedup-key",
      adapterEndpointId: endpointId,
      adapterBindingId: bindingId,
      result: { outcome: "success", responseStatus: 201, responseBody: { id: 99, name: "widget" } },
      executedAt: CREATED_AT,
      expiresAt: new Date("2026-07-20T01:00:00.000Z"),
    };
    const first = await store.recordOutcomeIfAbsent(original);
    expect(first.id).toBe(original.id);

    // A repeat delivery (different row id, same dedup key) must NOT insert — it
    // returns the ORIGINAL recorded outcome, never re-executed or fabricated.
    const replay = await store.recordOutcomeIfAbsent({ ...original, id: randomUUID() });
    expect(replay.id).toBe(original.id);
    expect(replay.result).toEqual(original.result);

    const found = await store.findByDedupKey(endpointId, "dedup-key");
    expect(found?.result).toEqual(original.result);

    // The operator-facing metadata read carries no response body at all (AD-4.4).
    const metadata = await store.findMetadataByDedupKey(endpointId, "dedup-key");
    expect(metadata).toBeDefined();
    expect(metadata).not.toHaveProperty("responseBody");
    expect(metadata?.outcome).toBe("success");
  });

  it("records a failed write outcome answerable on replay, and sweeps expired rows (AD-4.3/AD-4.5)", async () => {
    const endpointId = randomUUID();
    const bindingId = randomUUID();
    const repo = new DownstreamArtifactRepository(db);
    await repo.ensureAdapterEndpoint({
      id: endpointId,
      consumerAppId: APP_CONSUMER,
      consumerOperationId: "writeExpire",
      status: "active",
      aggregationStrategy: "single",
    });
    await db.insert(adapterBinding).values({
      id: bindingId,
      adapterEndpointId: endpointId,
      backendAppId: APP_BACKEND,
      backendOperationId: "writeExpireBackend",
      approvedMappingId: CP_MAPPING,
      role: "primary",
      status: "active",
    });
    const store = new AdapterWriteOutcomeRepository(db);
    await store.recordOutcomeIfAbsent({
      id: randomUUID(),
      idempotencyKey: "failed-key",
      adapterEndpointId: endpointId,
      adapterBindingId: bindingId,
      result: { outcome: "failure", responseStatus: 409, responseBody: { error: "conflict" } },
      executedAt: new Date("2026-07-19T00:00:00.000Z"),
      expiresAt: new Date("2026-07-19T01:00:00.000Z"),
    });
    const failed = await store.findByDedupKey(endpointId, "failed-key");
    expect(failed?.result.outcome).toBe("failure");

    // The boundedness sweep prunes the row once its dedup window has closed.
    const pruned = await store.deleteExpired(new Date("2026-07-20T00:00:00.000Z"));
    expect(pruned).toBeGreaterThanOrEqual(1);
    const afterPrune = await store.findByDedupKey(endpointId, "failed-key");
    expect(afterPrune).toBeUndefined();
  });

  it("round-trips Credential.validUntil and exposes it as queryable metadata (AD-3.3)", async () => {
    const withBound: Credential = {
      id: randomUUID(),
      appId: APP_CONSUMER,
      type: "adapterToken",
      encryptedPayload: "scrypt$16384$8$1$64$c2FsdA==$aGFzaA==",
      scopes: [],
      lastRotatedAt: CREATED_AT,
      validUntil: new Date("2026-07-21T00:00:00.000Z"),
    };
    const unbounded: Credential = {
      id: randomUUID(),
      appId: APP_CONSUMER,
      type: "adapterToken",
      encryptedPayload: "scrypt$16384$8$1$64$c2FsdA==$b3RoZXI=",
      scopes: [],
      lastRotatedAt: CREATED_AT,
    };
    const creds = new CredentialRepository(db);
    const boundedMeta = await creds.create(withBound);
    await creds.create(unbounded);
    expect(boundedMeta.validUntil).toEqual(withBound.validUntil);

    const list = await creds.listByAppId(APP_CONSUMER);
    const bounded = list.find((c) => c.id === withBound.id);
    const unboundedMeta = list.find((c) => c.id === unbounded.id);
    expect(bounded?.validUntil).toEqual(withBound.validUntil);
    // The unbounded token has an absent key, distinct from a bounded one.
    expect(unboundedMeta).not.toHaveProperty("validUntil");

    // Clear the credentials right away: sibling integration files clean
    // `registered_app` without clearing `credential`, so leaving a row referencing
    // our app would break a sibling that happens to run after us.
    await db.delete(credential);
  });

  it("round-trips the adapter-request audit columns (relatedBinding/endpoint, cause, degraded — AD-5)", async () => {
    const endpointId = randomUUID();
    const bindingId = randomUUID();
    const entry: AuditLogEntry = {
      id: randomUUID(),
      type: "adapter-request",
      actor: "adapter-runtime",
      status: "success",
      degraded: true, // a degraded success carries no failure cause
      relatedEndpointId: endpointId,
      relatedBindingId: bindingId,
      traceId: "trace-1",
      spanId: "span-1",
      timestamp: CREATED_AT,
    };
    await new AuditLogRepository(db).insert(entry);

    const [row] = await db.select().from(auditLog).where(eq(auditLog.id, entry.id));
    expect(row).toBeDefined();
    if (row === undefined) {
      return;
    }
    const loaded = mapAuditLogRow(row);
    expect(loaded.relatedEndpointId).toBe(endpointId);
    expect(loaded.relatedBindingId).toBe(bindingId);
    expect(loaded.degraded).toBe(true);
    expect(loaded.status).toBe("success");
    expect(loaded).not.toHaveProperty("cause");

    // A failure row records a distinct named cause.
    const failure: AuditLogEntry = {
      id: randomUUID(),
      type: "adapter-request",
      actor: "adapter-runtime",
      status: "failure",
      cause: "backend-disabled",
      relatedEndpointId: endpointId,
      relatedBindingId: bindingId,
      timestamp: CREATED_AT,
    };
    await new AuditLogRepository(db).insert(failure);
    const [failRow] = await db.select().from(auditLog).where(eq(auditLog.id, failure.id));
    expect(failRow === undefined ? undefined : mapAuditLogRow(failRow).cause).toBe(
      "backend-disabled",
    );
  });
});
