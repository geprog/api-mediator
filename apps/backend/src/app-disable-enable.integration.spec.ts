import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncRuleRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { decidePoll } from "@mediator/sync-engine";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConflictError } from "./app-errors.js";
import { validateBindingHealth } from "./http/adapter-runtime/serve/planner.js";
import { AppLifecycleService } from "./modules/app-lifecycle.js";
import { GraphProjection } from "./modules/graph/index.js";
import type { CredentialTxStore, DetectionJobTxRepo, TxStores } from "./modules/persistence.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";

/**
 * **AL-1 — live-Postgres backend integration for disabling an app and re-enabling it**,
 * driven through the real {@link AppLifecycleService} against real repositories, the real
 * {@link GraphProjection}, and a spy cache invalidator:
 *
 *  - **AL-1.1** disabling an `active` app sets `status = disabled`, which **stops** its
 *    real enabled `SyncRule` from being polled — asserted through the real Scheduler gate
 *    `decidePoll` over the real `SyncRuleRepository.listPollCandidates` join, with the
 *    distinct `app-disabled` reason — while the rule's own `status`, `backfillStatus`,
 *    `cursor` and `lastSnapshotRef` are **byte-identical** before and after;
 *  - **AL-1.2** its real `AdapterBinding` fails with the distinct **`backend-disabled`**
 *    cause through the real RP-3 `validateBindingHealth`, reading the app status straight
 *    from the row the transition wrote (the binding's own `status` untouched);
 *  - **AL-1.3** re-enabling resumes polling from the **stored** cursor/snapshot with **no
 *    re-backfill** (`backfillStatus` never moves off `completed`);
 *  - **AL-1.4** each transition writes an `AuditLog` row attributed to the operator;
 *  - **AL-1.5** both directions drop the cached entries of the endpoints the app backs
 *    (XI-2.2) and recompute the affected `GraphEdge`s (GR-2/GR-3) — `paused` while
 *    disabled, `active` again after re-enable — with the app **still a node** (GR-5.4);
 *  - **AL-1.6** the app condition **composes** with the mapping conditions: a rule held by
 *    an app disable *and* a `suspended` mapping resumes only when **both** clear.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable. Teardown deletes the FK children (adapter bindings,
 * sync rules, graph edges, adapter endpoints, mappings, specs) before `registered_app`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const OPERATOR = "operator@example.test";
/** The stored delta cursor + snapshot ref the rule must still be on after a re-enable. */
const STORED_CURSOR = "cursor-2026-07-23T11:00:00Z";

/** A lifecycle transition never stores credentials, enqueues analysis, or emits events. */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("AL-1 must not store credentials")),
};
const unusedDetectionJobs: DetectionJobTxRepo = {
  enqueueScoped: () => Promise.reject(new Error("AL-1 must not enqueue analysis")),
  lockUnfinishedJob: () => Promise.reject(new Error("AL-1 must not enqueue analysis")),
  updateScope: () => Promise.reject(new Error("AL-1 must not enqueue analysis")),
};

suite("AL-1 disable / re-enable a RegisteredApp (requires Postgres)", () => {
  let db: Database;
  let graphProjection: GraphProjection;
  let lifecycle: AppLifecycleService;

  const appIds: string[] = [];
  const mappingIds: string[] = [];
  const ruleIds: string[] = [];
  const endpointIds: string[] = [];
  /** Every `invalidateEndpoint` the transitions drove, in order (the XI-2 spy). */
  const cacheDrops: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    graphProjection = new GraphProjection({ db, newId: randomUUID });
    lifecycle = new AppLifecycleService({
      // A real transaction over a hand-built `TxStores` of real repositories + the real
      // `GraphProjection`, so the transition hits real rows and real constraints.
      unitOfWork: { run: (work) => tx(db, (handle) => work(txStoresOn(handle))) },
      newId: randomUUID,
      cacheInvalidator: {
        invalidateEndpoint: (endpointId) => {
          cacheDrops.push(endpointId);
        },
      },
      // No ambient OTel span in the suite → keep the audit rows free of trace columns.
      readTraceContext: () => null,
    });
  });

  afterAll(async () => {
    if (endpointIds.length > 0) {
      await db.delete(adapterBinding).where(inArray(adapterBinding.adapterEndpointId, endpointIds));
    }
    if (ruleIds.length > 0) {
      await db.delete(syncRule).where(inArray(syncRule.id, ruleIds));
    }
    if (appIds.length > 0) {
      await db
        .delete(graphEdge)
        .where(
          or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)),
        );
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.consumerAppId, appIds));
      await db.delete(auditLog).where(inArray(auditLog.originAppId, appIds));
    }
    if (mappingIds.length > 0) {
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
    }
    if (appIds.length > 0) {
      await db.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, appIds));
    }
    await closeDb(db);
  });

  function txStoresOn(handle: DbHandle): TxStores {
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      detectionJobs: unusedDetectionJobs,
      mappingArtifacts: new MappingArtifactsRepository(handle),
      downstreamArtifacts: new DownstreamArtifactRepository(handle),
      graph: {
        recomputeSyncEdge: (sourceAppId, targetAppId) =>
          graphProjection.recomputeSyncEdgeWithin(handle, sourceAppId, targetAppId),
        recomputeAdapterEdge: (consumerAppId, backendAppId) =>
          graphProjection.recomputeAdapterEdgeWithin(handle, consumerAppId, backendAppId),
      },
      cacheInvalidator: {
        invalidateEndpoint: (endpointId) => {
          cacheDrops.push(endpointId);
        },
      },
      syncRules: new SyncRuleRepository(handle),
      scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
      scopeLifecycle: new ScopeLifecycleService({
        resourceBindings: new ResourceBindingRepository(handle),
        scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
        scopeLinks: new ScopeLinkRepository(handle),
      }),
      emit: () => Promise.reject(new Error("AL-1 must not emit")),
    };
  }

  function makeApp(name: string): RegisteredApp {
    const app: RegisteredApp = {
      id: randomUUID(),
      name: `${name} ${randomUUID()}`,
      status: "active",
      baseUrl: "https://al1.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: true,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60_000,
      },
      createdAt: CREATED_AT,
    };
    appIds.push(app.id);
    return app;
  }

  /** A minimal `active` spec row (a real `api_spec` the mapping FKs need). */
  async function seedBareSpec(appId: string): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role: "PROVIDER",
      rawDocument: {},
      parsedIR: [],
      analysisExclusions: [],
      version: 1,
      contentHash: randomUUID(),
      status: "active",
      createdAt: CREATED_AT,
    };
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  /**
   * The rule's live polling state **as persisted** (raw columns, NULLs and all), for the
   * untouched-by-the-transition check — deliberately not the mapped domain object, so an
   * absent key can never be confused with a NULL column.
   */
  async function pollState(ruleId: string): Promise<{
    status: SyncRule["status"];
    backfillStatus: SyncRule["backfillStatus"] | null;
    cursor: string | null;
    lastSnapshotRef: string | null;
  }> {
    const [row] = await db
      .select({
        status: syncRule.status,
        backfillStatus: syncRule.backfillStatus,
        cursor: syncRule.cursor,
        lastSnapshotRef: syncRule.lastSnapshotRef,
      })
      .from(syncRule)
      .where(eq(syncRule.id, ruleId));
    if (row === undefined) throw new Error("expected the sync rule row");
    return row;
  }

  /** The real Scheduler decision for a rule, over the real candidate join, right now. */
  async function decisionFor(ruleId: string): Promise<ReturnType<typeof decidePoll>> {
    const candidates = await new SyncRuleRepository(db).listPollCandidates();
    const candidate = candidates.find((entry) => entry.rule.id === ruleId);
    if (candidate === undefined) throw new Error("expected the rule in the candidate set");
    return decidePoll(candidate, new Date());
  }

  /** The real RP-3 health verdict for a binding, reading BOTH statuses from the database. */
  async function bindingHealth(
    binding: AdapterBinding,
    mappingId: string,
  ): Promise<ReturnType<typeof validateBindingHealth>> {
    const mapping = await new ApprovedMappingRepository(db).getById(mappingId);
    const backend = await new RegisteredAppRepository(db).getById(binding.backendAppId);
    if (mapping === undefined || backend === undefined) throw new Error("expected mapping + app");
    return validateBindingHealth({
      binding,
      mappingStatus: mapping.status,
      backendStatus: backend.status,
    });
  }

  /** The AL-1 audit rows for an app, oldest first. */
  async function auditFor(appId: string): Promise<{ actor: string; details: string | null }[]> {
    const rows = await db
      .select({ actor: auditLog.actor, details: auditLog.details, timestamp: auditLog.timestamp })
      .from(auditLog)
      .where(eq(auditLog.originAppId, appId));
    return [...rows]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .map((row) => ({ actor: row.actor, details: row.details }));
  }

  it("disabling stops the real rule polling + fails the binding backend-disabled + drops cache + repaints the graph; re-enabling resumes from the stored cursor", async () => {
    const provider = makeApp("AL-1 provider");
    const peer = makeApp("AL-1 peer");
    const consumer = makeApp("AL-1 consumer");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peer);
    await appRepo.create(consumer);

    const providerSpec = await seedBareSpec(provider.id);
    const peerSpec = await seedBareSpec(peer.id);
    const consumerSpec = await seedBareSpec(consumer.id);

    const mappings = new ApprovedMappingRepository(db);
    const downstream = new DownstreamArtifactRepository(db);

    // ── A peer-peer mapping with one ENABLED, backfill-completed rule that has already
    //    polled (a real stored cursor + snapshot ref). ──
    const syncMapping: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: providerSpec.id,
      targetSpecId: peerSpec.id,
      sourceAppId: provider.id,
      targetAppId: peer.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(syncMapping.id);
    await mappings.insert(syncMapping);
    const snapshotRef = randomUUID();
    const rule: SyncRule = {
      id: randomUUID(),
      approvedMappingId: syncMapping.id,
      resourcePairRef: `${provider.id}:issues|${peer.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
      cursor: STORED_CURSOR,
      lastSnapshotRef: snapshotRef,
    };
    ruleIds.push(rule.id);
    await downstream.insertSyncRuleIfAbsent(rule);

    // ── A consumer-provider mapping with one ACTIVE binding, backed by the provider. ──
    const adapterMapping: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: consumerSpec.id,
      targetSpecId: providerSpec.id,
      sourceAppId: consumer.id,
      targetAppId: provider.id,
      variant: "consumer-provider",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(adapterMapping.id);
    await mappings.insert(adapterMapping);
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: "con-issues/getConIssue",
      status: "active",
    };
    endpointIds.push(endpoint.id);
    await downstream.ensureAdapterEndpoint(endpoint);
    const binding: AdapterBinding = {
      id: randomUUID(),
      adapterEndpointId: endpoint.id,
      backendAppId: provider.id,
      backendOperationId: "issues/getIssue",
      approvedMappingId: adapterMapping.id,
      role: "primary",
      status: "active",
    };
    await downstream.insertAdapterBindingIfAbsent(binding);

    // Seed the pre-transition edges the projection would have created at approval.
    await downstream.upsertGraphEdge({
      id: randomUUID(),
      sourceNodeId: provider.id,
      targetNodeId: peer.id,
      type: "sync",
      status: "active",
      metadata: {
        direction: { sourceSpecId: providerSpec.id, targetSpecId: peerSpec.id },
        lastActivityAt: null,
      },
    });
    await downstream.upsertGraphEdge({
      id: randomUUID(),
      sourceNodeId: consumer.id,
      targetNodeId: provider.id,
      type: "adapter-dependency",
      status: "active",
      metadata: {
        direction: { sourceSpecId: consumerSpec.id, targetSpecId: providerSpec.id },
        lastActivityAt: null,
      },
    });

    // Baseline: the rule polls and the binding is healthy.
    expect((await decisionFor(rule.id)).kind).toBe("poll");
    expect(await bindingHealth(binding, adapterMapping.id)).toBeUndefined();
    const stateBefore = await pollState(rule.id);
    expect(stateBefore).toStrictEqual({
      status: "enabled",
      backfillStatus: "completed",
      cursor: STORED_CURSOR,
      lastSnapshotRef: snapshotRef,
    });

    // ── AL-1.1 — DISABLE the provider app. ──
    cacheDrops.length = 0;
    const disabled = await lifecycle.disable(provider.id, OPERATOR);
    expect(disabled.status).toBe("disabled");
    expect((await appRepo.getById(provider.id))?.status).toBe("disabled");

    // AL-1.1 — the rule STOPS being polled through the real candidate join + real gate,
    // with the distinct reason...
    expect(await decisionFor(rule.id)).toEqual({ kind: "hold", reason: "app-disabled" });
    // ...and NOTHING of its own state moved: no status, no backfill, no cursor, no snapshot.
    expect(await pollState(rule.id)).toStrictEqual(stateBefore);

    // AL-1.2 — the binding fails with the DISTINCT `backend-disabled` cause (RP-3.5), and
    // its own status is untouched (the pause is derived per request).
    const bindingRows = await downstream.listAdapterBindingsByMapping(adapterMapping.id);
    const bindingRow = bindingRows[0];
    if (bindingRow === undefined) throw new Error("expected the adapter binding");
    expect(bindingRow.status).toBe("active");
    expect(await bindingHealth(bindingRow, adapterMapping.id)).toEqual({
      cause: "backend-disabled",
      backendAppId: provider.id,
    });

    // AL-1.5 / XI-2.2 — the endpoint the disabled app BACKS had its cache dropped.
    expect(cacheDrops).toEqual([endpoint.id]);

    // AL-1.5 / GR-2/GR-3 — both incident edges recompute to `paused`...
    expect((await downstream.getGraphEdge(provider.id, peer.id, "sync"))?.status).toBe("paused");
    expect(
      (await downstream.getGraphEdge(consumer.id, provider.id, "adapter-dependency"))?.status,
    ).toBe("paused");
    // ...and GR-5.4 — the app is STILL A NODE, with its edges still present.
    expect(await appRepo.getById(provider.id)).toBeDefined();
    expect(await downstream.getGraphEdge(provider.id, peer.id, "sync")).toBeDefined();

    // AL-1.4 / OA-3 — the disable is attributed to the authenticated operator.
    const afterDisable = await auditFor(provider.id);
    expect(afterDisable).toHaveLength(1);
    expect(afterDisable[0]?.actor).toBe(OPERATOR);
    expect(afterDisable[0]?.details).toContain("disabled");

    // ── AL-1.6 — the app condition COMPOSES with the mapping conditions. ──
    await mappings.markSuspended(syncMapping.id);
    // Both conditions apply: still held (the app disable is reported first here only
    // because `reason` is a single token — both are live).
    expect((await decisionFor(rule.id)).kind).toBe("hold");

    // ── AL-1.3 — RE-ENABLE the app: lifts ONLY the app condition. ──
    cacheDrops.length = 0;
    const reEnabled = await lifecycle.enable(provider.id, OPERATOR);
    expect(reEnabled.status).toBe("active");

    // AL-1.6 — the suspended mapping still holds the rule; the resume is NOT complete.
    expect(await decisionFor(rule.id)).toEqual({ kind: "hold", reason: "mapping-suspended" });

    // Clear the LAST remaining condition → and only now does the rule poll again.
    await mappings.markActive(syncMapping.id);
    expect((await decisionFor(rule.id)).kind).toBe("poll");

    // AL-1.3 — it resumed from the STORED cursor/snapshot, with NO re-backfill: the rule's
    // poll state is byte-identical to what it was before the disable.
    expect(await pollState(rule.id)).toStrictEqual(stateBefore);

    // AL-1.2 — the binding is healthy again with no re-composition.
    const resumedBindings = await downstream.listAdapterBindingsByMapping(adapterMapping.id);
    const resumedBinding = resumedBindings[0];
    if (resumedBinding === undefined) throw new Error("expected the adapter binding");
    expect(resumedBinding.status).toBe("active");
    expect(resumedBinding.role).toBe("primary");
    expect(await bindingHealth(resumedBinding, adapterMapping.id)).toBeUndefined();

    // AL-1.5 — re-enable drops the cache again (nothing cached under the disable is served)
    // and repaints both edges. The sync edge is recomputed while the mapping is suspended,
    // so it reads `paused` until that separate condition clears — the composition again.
    expect(cacheDrops).toEqual([endpoint.id]);
    expect(
      (await downstream.getGraphEdge(consumer.id, provider.id, "adapter-dependency"))?.status,
    ).toBe("active");

    // A final recompute now that BOTH conditions are clear puts the sync edge back to active.
    await graphProjection.recomputeSyncEdge(provider.id, peer.id);
    expect((await downstream.getGraphEdge(provider.id, peer.id, "sync"))?.status).toBe("active");

    // AL-1.4 — the re-enable is audited to the operator too (two rows now).
    const afterEnable = await auditFor(provider.id);
    expect(afterEnable).toHaveLength(2);
    expect(afterEnable[1]?.actor).toBe(OPERATOR);
    expect(afterEnable[1]?.details).toContain("re-enabled");
  });

  it("a rule is stopped when the app is its TARGET, not only its source", async () => {
    const source = makeApp("AL-1 target-side source");
    const target = makeApp("AL-1 target-side target");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(source);
    await appRepo.create(target);
    const sourceSpec = await seedBareSpec(source.id);
    const targetSpec = await seedBareSpec(target.id);

    const mapping: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: sourceSpec.id,
      targetSpecId: targetSpec.id,
      sourceAppId: source.id,
      targetAppId: target.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(mapping.id);
    await new ApprovedMappingRepository(db).insert(mapping);
    const rule: SyncRule = {
      id: randomUUID(),
      approvedMappingId: mapping.id,
      resourcePairRef: `${source.id}:issues|${target.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
    };
    ruleIds.push(rule.id);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(rule);

    expect((await decisionFor(rule.id)).kind).toBe("poll");

    // Disable the app the rule WRITES to (never its source).
    await lifecycle.disable(target.id, OPERATOR);
    expect(await decisionFor(rule.id)).toEqual({ kind: "hold", reason: "app-disabled" });

    await lifecycle.enable(target.id, OPERATOR);
    expect((await decisionFor(rule.id)).kind).toBe("poll");
  });

  it("rejects an illegal transition: disabling a disabled app and enabling an active one", async () => {
    const app = makeApp("AL-1 guard");
    await new RegisteredAppRepository(db).create(app);

    // Enable is valid only from `disabled`.
    await expect(lifecycle.enable(app.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    await lifecycle.disable(app.id, OPERATOR);
    // Disable is valid only from `active` — disabling twice is a conflict, not a no-op.
    await expect(lifecycle.disable(app.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect((await new RegisteredAppRepository(db).getById(app.id))?.status).toBe("disabled");

    // An unknown app is a clean 404, not a silent no-op.
    await expect(lifecycle.disable(randomUUID(), OPERATOR)).rejects.toThrow(/not found/i);

    // The repository's compare-and-set is the real race guard behind those conflicts:
    // against real Postgres, a transition from the wrong status matches NO row and
    // returns `undefined` rather than clobbering the current one.
    const appRepo = new RegisteredAppRepository(db);
    expect(await appRepo.markDisabled(app.id)).toBeUndefined(); // already disabled
    expect((await appRepo.getById(app.id))?.status).toBe("disabled");
    expect(await appRepo.markActive(app.id)).toMatchObject({ status: "active" });
    expect(await appRepo.markActive(app.id)).toBeUndefined(); // already active
    expect(await appRepo.markDisabled(randomUUID())).toBeUndefined(); // no such row
  });
});
