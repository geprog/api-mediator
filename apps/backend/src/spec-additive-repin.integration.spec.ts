import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CredentialTxStore, TxStores } from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { providerSpecDocument } from "./testing/sample-specs.testkit.js";

/**
 * SL-2 — live-Postgres backend integration for the **additive reaction** wired into
 * {@link SpecRegistry.ingestNewVersion}: an additive spec bump re-pins every active
 * `ApprovedMapping` to the new version (audit-logged), carries the prior version's
 * `ResourceBinding`s + `analysisExclusions` forward, and never sets a mapping `stale`,
 * changes its content, or touches its `counterpartMappingId`.
 *
 * Proves the persistence-touching behaviours the in-memory unit tests cannot (SL-2.3's
 * "no active mapping references a `superseded` row" is asserted by re-reading Postgres):
 *  - **SL-2.1/2.3** re-pin + audit; no active mapping left on the superseded row;
 *  - **SL-2.2** only the pinned spec version changes — the mapping row, its `FieldMapping`
 *    content, and its `SyncRule` state are byte-identical, and status stays `active`;
 *  - **SL-2.4** the bindings + exclusions appear on the new version, confirmations intact;
 *  - **SL-2.5** `counterpartMappingId` is undisturbed on both directions.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-20T00:00:00.000Z");

/** Storing credentials / emitting events is never part of a version advance (SL-1/SL-2). */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** The additive re-ingest document: the provider spec plus one **optional** field. */
function providerSpecWithOptionalField(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    components: { schemas: { Issue: { properties: Record<string, unknown> } } };
  };
  doc.components.schemas.Issue.properties["priority"] = { type: "string" };
  return doc;
}

suite("SL-2 additive re-pin + carry-forward (requires Postgres)", () => {
  let db: Database;
  const registry = new SpecRegistry();
  const appIds: string[] = [];
  const specIds: string[] = [];
  const mappingIds: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    // FK-safe teardown: mappings (and their cascading rule/field children + audit) before
    // the specs they pin; binding refs before their bindings before the specs.
    if (mappingIds.length > 0) {
      await db
        .update(approvedMapping)
        .set({ counterpartMappingId: null })
        .where(inArray(approvedMapping.id, mappingIds));
      await db.delete(auditLog).where(inArray(auditLog.relatedMappingId, mappingIds));
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
    }
    if (specIds.length > 0) {
      const bindingRows = await db
        .select({ id: resourceBinding.id })
        .from(resourceBinding)
        .where(inArray(resourceBinding.apiSpecId, specIds));
      const bindingIds = bindingRows.map((row) => row.id);
      if (bindingIds.length > 0) {
        await db
          .delete(resourceBindingRef)
          .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
        await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, specIds));
      }
    }
    if (appIds.length > 0) {
      await db.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, appIds));
    }
    await closeDb(db);
  });

  function providerApp(name: string): RegisteredApp {
    const app: RegisteredApp = {
      id: randomUUID(),
      name: `${name} ${randomUUID()}`,
      status: "active",
      baseUrl: "https://sl2.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60_000,
      },
      createdAt: CREATED_AT,
    };
    appIds.push(app.id);
    return app;
  }

  async function seedSpec(
    appId: string,
    document: Record<string, unknown>,
    analysisExclusions: string[],
  ): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role: "PROVIDER",
      rawDocument: document,
      parsedIR: await buildIr(document),
      analysisExclusions,
      version: 1,
      contentHash: computeContentHash(document),
      status: "active",
      createdAt: CREATED_AT,
    };
    specIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  function peerMapping(
    id: string,
    sourceSpec: ApiSpec,
    targetSpec: ApiSpec,
    counterpartMappingId: string,
  ): ApprovedMapping {
    mappingIds.push(id);
    return {
      id,
      sourceSpecId: sourceSpec.id,
      targetSpecId: targetSpec.id,
      sourceAppId: sourceSpec.appId,
      targetAppId: targetSpec.appId,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
      counterpartMappingId,
    };
  }

  /** The version-advance `TxStores` over one transaction handle (real repositories). */
  function txStoresOn(handle: DbHandle): TxStores {
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      emit: () => Promise.reject(new Error("ingestNewVersion must not emit on advance")),
    };
  }

  it("re-pins active mappings, audits each, carries bindings/exclusions forward, and never changes content/counterpart/status", async () => {
    // Two provider apps forming a bidirectional peer pair; app A's lineage advances.
    const appA = providerApp("SL-2 A");
    const appB = providerApp("SL-2 B");
    await new RegisteredAppRepository(db).create(appA);
    await new RegisteredAppRepository(db).create(appB);
    const aV1 = await seedSpec(appA.id, providerSpecDocument(), ["issues"]);
    const bV1 = await seedSpec(appB.id, providerSpecDocument(), []);

    const m1Id = randomUUID();
    const m2Id = randomUUID();
    const m1 = peerMapping(m1Id, aV1, bV1, m2Id); // A → B, pins A-v1 as source.
    const m2 = peerMapping(m2Id, bV1, aV1, m1Id); // B → A, pins A-v1 as target.
    const mappingsRepo = new ApprovedMappingRepository(db);
    // Insert without the circular counterpart FK, then cross-link (the AS-6 approve order).
    await mappingsRepo.insert({ ...m1, counterpartMappingId: undefined });
    await mappingsRepo.insert({ ...m2, counterpartMappingId: undefined });
    await mappingsRepo.setCounterpart(m1Id, m2Id);
    await mappingsRepo.setCounterpart(m2Id, m1Id);

    // M1 content + a derived rule, to prove neither is touched by a re-pin.
    const fieldMappingRow: FieldMapping = {
      id: randomUUID(),
      mappingId: m1Id,
      sourcePath: "title",
      targetPath: "title",
      transform: "rename",
    };
    await new MappingArtifactsRepository(db).replaceChildren(m1Id, {
      fieldMappings: [fieldMappingRow],
      operationMappings: [],
      parameterMappings: [],
    });
    const syncRuleRow: SyncRule = {
      id: randomUUID(),
      approvedMappingId: m1Id,
      resourcePairRef: `${appA.id}:issues|${appB.id}:issues`,
      status: "disabled",
    };
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(syncRuleRow);

    // Snapshot the content + rule as persisted, to prove they are byte-identical after.
    const fieldsBefore = await new MappingArtifactsRepository(db).listFieldMappings(m1Id);
    const rulesBefore = await new DownstreamArtifactRepository(db).listSyncRulesByMapping(m1Id);

    // A confirmed binding on A-v1 → must carry forward to A-v2 with its confirmation.
    const aBinding: ResourceBinding = {
      id: randomUUID(),
      apiSpecId: aV1.id,
      resourceRef: "issues",
      nativeIdRef: {
        value: { kind: "field", path: "id" },
        confirmedBy: "reviewer:bob",
        confirmedAt: CREATED_AT,
      },
      scopePathBindings: [],
    };
    await new ResourceBindingRepository(db).createMany([aBinding]);

    // Advance app A's lineage with an additive change (a new optional field).
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        appA.id,
        providerSpecWithOptionalField(),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("additive");
    const aV2Id = outcome.newSpec.id;
    specIds.push(aV2Id);

    const mappings = new ApprovedMappingRepository(db);

    // SL-2.1 — each side re-pinned only on the side that pinned the superseded version.
    const m1After = await mappings.getById(m1Id);
    const m2After = await mappings.getById(m2Id);
    expect(m1After).toMatchObject({ sourceSpecId: aV2Id, targetSpecId: bV1.id, status: "active" });
    expect(m2After).toMatchObject({ sourceSpecId: bV1.id, targetSpecId: aV2Id, status: "active" });

    // SL-2.2 — byte-identical apart from the one advanced spec id (never stale).
    expect(m1After).toEqual({ ...m1, sourceSpecId: aV2Id });
    // SL-2.5 — the counterpart pairing is undisturbed on both directions.
    expect(m1After?.counterpartMappingId).toBe(m2Id);
    expect(m2After?.counterpartMappingId).toBe(m1Id);

    // SL-2.3 — re-read Postgres: NO active mapping references the superseded A-v1 row.
    const stillOnV1 = await db
      .select()
      .from(approvedMapping)
      .where(eq(approvedMapping.status, "active"));
    expect(
      stillOnV1.filter((row) => row.sourceSpecId === aV1.id || row.targetSpecId === aV1.id),
    ).toEqual([]);

    // SL-2.1 — each re-pin is an audit-logged, system-attributed event.
    const auditM1 = await new AuditLogRepository(db).listByMappingId(m1Id);
    const auditM2 = await new AuditLogRepository(db).listByMappingId(m2Id);
    expect(auditM1).toHaveLength(1);
    expect(auditM2).toHaveLength(1);
    expect(auditM1[0]).toMatchObject({ type: "mapping-decision", actor: "system" });
    expect(auditM1[0]?.status).toBeUndefined();
    expect(auditM1[0]?.details).toContain(aV2Id);

    // SL-2.2 — the mapping's FieldMapping content + SyncRule state are byte-identical.
    const fieldsAfter = await new MappingArtifactsRepository(db).listFieldMappings(m1Id);
    expect(fieldsAfter).toEqual(fieldsBefore);
    expect(fieldsAfter).toEqual([fieldMappingRow]);
    const rulesAfter = await new DownstreamArtifactRepository(db).listSyncRulesByMapping(m1Id);
    expect(rulesAfter).toEqual(rulesBefore);

    // SL-2.4 — exclusions carried forward, and the confirmed binding re-created on A-v2.
    const aV2 = await new ApiSpecRepository(db).getById(aV2Id);
    expect(aV2?.analysisExclusions).toEqual(["issues"]);
    const aV2Bindings = await new ResourceBindingRepository(db).listByApiSpecId(aV2Id);
    const carried = aV2Bindings.find((binding) => binding.resourceRef === "issues");
    expect(carried).toBeDefined();
    expect(carried?.id).not.toBe(aBinding.id); // a fresh row on the new version.
    expect(carried?.nativeIdRef).toEqual({
      value: { kind: "field", path: "id" },
      confirmedBy: "reviewer:bob",
      confirmedAt: CREATED_AT,
    });
  });
});
