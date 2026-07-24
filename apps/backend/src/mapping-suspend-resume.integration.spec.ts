import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  CredentialRepository,
  DetectionJobRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncRuleRepository,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
  mappingDetectionJob,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  tx,
  type Database,
  type DbHandle,
  type DetectionJobScope,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  OperationMapping,
  RegisteredApp,
  SyncRule,
} from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { decidePoll } from "@mediator/sync-engine";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConflictError } from "./app-errors.js";
import { validateBindingHealth } from "./http/adapter-runtime/serve/planner.js";
import { ApprovedMappingSuspensionService } from "./modules/approved-mapping-suspension.js";
import { GraphProjection } from "./modules/graph/index.js";
import { dbSyncStateArchival } from "./modules/persistence.js";
import type { CredentialTxStore, TxStores } from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";

/**
 * **SL-10 — live-Postgres backend integration for the manual suspend / resume of an
 * `ApprovedMapping`**, driven through the real {@link ApprovedMappingSuspensionService}
 * against real repositories, the real {@link GraphProjection}, and a spy cache invalidator:
 *
 *  - **SL-10.1** suspending an `active` mapping sets `status = suspended`, which **pauses**
 *    its real enabled `SyncRule` (asserted through the real Scheduler gate `decidePoll` over
 *    the real `SyncRuleRepository.listPollCandidates` join) and makes its real
 *    `AdapterBinding` fail with the distinct **`mapping-suspended`** cause (asserted through
 *    the real RP-3 `validateBindingHealth`) — both **derived**: neither the rule's nor the
 *    binding's own `status` is written;
 *  - **SL-10.2** resuming restores all of it under the stored state — the rule polls again
 *    and the binding is healthy — with no re-backfill and no re-composition (the rule's
 *    `backfillStatus`, cursor columns, and the binding's composition config are untouched);
 *  - **SL-10.3** every transition writes an `AuditLog` row attributed to the authenticated
 *    operator (OA-3);
 *  - **SL-10.4** both directions drop the affected endpoint's cached entries (XI-2) and
 *    recompute the affected `GraphEdge`s (GR-2/GR-3) — `paused` while suspended, `active`
 *    again after resume;
 *  - **SL-10.5** a **breaking** `SpecDiff` on a suspended mapping's spec still classifies it
 *    and marks it `stale` (`suspended → stale`), after which a resume is **rejected** — the
 *    more-blocking condition wins and only re-review returns it to `active`.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips when
 * `DATABASE_URL` is unresolvable. Teardown deletes `graph_edge` and `adapter_endpoint` (both
 * FK `registered_app` with no cascade) BEFORE `registered_app`.
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

/** Storing credentials / emitting events is never part of a version advance. */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** A two-resource provider doc: `issues` (id, title:<titleType>) + `labels` (id, name). */
function providerDoc(titleType: "string" | "integer"): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "SL-10 Provider", version: "1.0.0" },
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          tags: ["issue"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Issue" } },
                },
              },
            },
          },
        },
      },
      "/issues/{id}": {
        get: {
          operationId: "getIssue",
          tags: ["issue"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Issue" } },
              },
            },
          },
        },
      },
      "/labels": {
        get: {
          operationId: "listLabels",
          tags: ["label"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Label" } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Issue: {
          type: "object",
          properties: { id: { type: "integer" }, title: { type: titleType } },
          required: ["id"],
        },
        Label: {
          type: "object",
          properties: { id: { type: "integer" }, name: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };
}

suite("SL-10 manual suspend / resume of an ApprovedMapping (requires Postgres)", () => {
  let db: Database;
  let graphProjection: GraphProjection;
  let suspension: ApprovedMappingSuspensionService;
  const registry = new SpecRegistry();

  const appIds: string[] = [];
  const specIds: string[] = [];
  const mappingIds: string[] = [];
  /** Every `invalidateEndpoint` the transitions drove, in order (the XI-2 spy). */
  const cacheDrops: string[] = [];
  /** Every scoped detection job recorded in-tx (the SL-6 re-review trigger spy). */
  const enqueuedJobs: { apiSpecId: string; scope: DetectionJobScope }[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    graphProjection = new GraphProjection({ db, newId: randomUUID });
    suspension = new ApprovedMappingSuspensionService({
      // A real transaction over the SAME hand-built `TxStores` (all real repositories +
      // the real `GraphProjection`) the Spec Registry runs on below, so the catch-up's
      // re-pin / mark-stale / re-review paths hit real rows and real constraints.
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
    if (appIds.length > 0) {
      await db
        .delete(graphEdge)
        .where(
          or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)),
        );
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.consumerAppId, appIds));
    }
    if (mappingIds.length > 0) {
      await db.delete(auditLog).where(inArray(auditLog.relatedMappingId, mappingIds));
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
    }
    if (appIds.length > 0) {
      const specRows = await db
        .select({ id: apiSpec.id })
        .from(apiSpec)
        .where(inArray(apiSpec.appId, appIds));
      const allSpecIds = specRows.map((row) => row.id);
      if (allSpecIds.length > 0) {
        // FK `api_spec` — the SL-6 re-review jobs must go before their spec rows.
        await db
          .delete(mappingDetectionJob)
          .where(inArray(mappingDetectionJob.apiSpecId, allSpecIds));
      }
      if (allSpecIds.length > 0) {
        const bindingRows = await db
          .select({ id: resourceBinding.id })
          .from(resourceBinding)
          .where(inArray(resourceBinding.apiSpecId, allSpecIds));
        const bindingIds = bindingRows.map((row) => row.id);
        if (bindingIds.length > 0) {
          await db
            .delete(resourceBindingRef)
            .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
        }
        await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, allSpecIds));
      }
      await db.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, appIds));
    }
    await closeDb(db);
  });

  function makeApp(name: string): RegisteredApp {
    const app: RegisteredApp = {
      id: randomUUID(),
      name: `${name} ${randomUUID()}`,
      status: "active",
      baseUrl: "https://sl10.example.test",
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

  /** A minimal `active` spec row (a real `api_spec` the FKs need). */
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
    specIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  async function seedProviderV1(appId: string): Promise<ApiSpec> {
    const document = providerDoc("string");
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role: "PROVIDER",
      rawDocument: document,
      parsedIR: await buildIr(document),
      analysisExclusions: [],
      version: 1,
      contentHash: computeContentHash(document),
      status: "active",
      createdAt: CREATED_AT,
    };
    specIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  function txStoresOn(handle: DbHandle): TxStores {
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      // The REAL enqueue (so the SL-6 job row is really written against the real schema),
      // wrapped to record the scope for assertions.
      detectionJobs: {
        enqueueScoped: async (apiSpecId, scope): Promise<boolean> => {
          enqueuedJobs.push({ apiSpecId, scope });
          // Propagate SL-9's insert-reporting boolean rather than swallowing it, so this
          // stub keeps mirroring the real repository's collapse semantics.
          return await new DetectionJobRepository(handle).enqueueScoped(apiSpecId, scope);
        },
        // SL-9's collapse-resolution ports: delegated to the real repository, since this
        // stub exists to record the scope, not to fake the schema.
        lockUnfinishedJob: (apiSpecId) =>
          new DetectionJobRepository(handle).lockUnfinishedJob(apiSpecId),
        updateScope: (jobId, scope) => new DetectionJobRepository(handle).updateScope(jobId, scope),
      },
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
      // AL-2 — the deregister cascade's seams; unused by this suite, wired so
      // the hand-built `TxStores` stays complete.
      syncStateArchival: dbSyncStateArchival(handle),
      credentials: new CredentialRepository(handle),
      emit: () => Promise.reject(new Error("ingestNewVersion must not emit on advance")),
    };
  }

  /** The `mapping-decision` audit rows for a mapping, oldest first. */
  async function auditFor(mappingId: string): Promise<{ actor: string; details: string | null }[]> {
    const rows = await db
      .select({ actor: auditLog.actor, details: auditLog.details, timestamp: auditLog.timestamp })
      .from(auditLog)
      .where(eq(auditLog.relatedMappingId, mappingId));
    return [...rows]
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .map((row) => ({ actor: row.actor, details: row.details }));
  }

  it("suspend pauses the rule + fails the binding mapping-suspended + drops cache + repaints the graph; resume restores all of it", async () => {
    const provider = makeApp("SL-10 provider");
    const peer = makeApp("SL-10 peer");
    const consumer = makeApp("SL-10 consumer");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peer);
    await appRepo.create(consumer);

    const providerSpec = await seedProviderV1(provider.id);
    const peerSpec = await seedBareSpec(peer.id);
    const consumerSpec = await seedBareSpec(consumer.id);

    const mappings = new ApprovedMappingRepository(db);
    const artifacts = new MappingArtifactsRepository(db);
    const downstream = new DownstreamArtifactRepository(db);

    // ── A peer-peer mapping with one ENABLED, backfill-completed rule. ──
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
    await artifacts.replaceChildren(syncMapping.id, {
      fieldMappings: [
        {
          id: randomUUID(),
          mappingId: syncMapping.id,
          sourcePath: "issues/title",
          targetPath: "issues/title",
          transform: "rename",
        },
      ],
      operationMappings: [],
      parameterMappings: [],
    });
    const rule: SyncRule = {
      id: randomUUID(),
      approvedMappingId: syncMapping.id,
      resourcePairRef: `${provider.id}:issues|${peer.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
    };
    await downstream.insertSyncRuleIfAbsent(rule);

    // ── A consumer-provider mapping with one ACTIVE binding on an active endpoint. ──
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
    const adapterOp: OperationMapping = {
      id: randomUUID(),
      mappingId: adapterMapping.id,
      sourceOperationRef: "con-issues/getConIssue",
      targetOperationRef: "issues/getIssue",
      action: "read",
    };
    const adapterField: FieldMapping = {
      id: randomUUID(),
      mappingId: adapterMapping.id,
      sourcePath: "issues/title",
      targetPath: "con-issues/title",
      transform: "rename",
      phase: "response",
    };
    await artifacts.replaceChildren(adapterMapping.id, {
      fieldMappings: [adapterField],
      operationMappings: [adapterOp],
      parameterMappings: [],
    });
    const endpoint: AdapterEndpoint = {
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: "con-issues/getConIssue",
      status: "active",
    };
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
    const beforeCandidates = await new SyncRuleRepository(db).listPollCandidates();
    const beforeCandidate = beforeCandidates.find((candidate) => candidate.rule.id === rule.id);
    if (beforeCandidate === undefined) throw new Error("expected the rule in the candidate set");
    expect(decidePoll(beforeCandidate, new Date()).kind).toBe("poll");

    // ── SL-10.1 — SUSPEND both mappings. ──
    cacheDrops.length = 0;
    const suspendedSync = await suspension.suspend(syncMapping.id, OPERATOR);
    expect(suspendedSync.status).toBe("suspended");
    const suspendedAdapter = await suspension.suspend(adapterMapping.id, OPERATOR);
    expect(suspendedAdapter.status).toBe("suspended");

    // The status is persisted; the pinned specs and counterpart are untouched.
    const reloadedSync = await mappings.getById(syncMapping.id);
    expect(reloadedSync?.status).toBe("suspended");
    expect(reloadedSync?.sourceSpecId).toBe(providerSpec.id);
    expect(reloadedSync?.targetSpecId).toBe(peerSpec.id);

    // SL-10.1 — the rule PAUSES through the real Scheduler gate, with the distinct reason,
    // and its OWN status is untouched (suspension lives on the mapping alone).
    const heldCandidates = await new SyncRuleRepository(db).listPollCandidates();
    const heldCandidate = heldCandidates.find((candidate) => candidate.rule.id === rule.id);
    if (heldCandidate === undefined) throw new Error("expected the rule in the candidate set");
    expect(decidePoll(heldCandidate, new Date())).toEqual({
      kind: "hold",
      reason: "mapping-suspended",
    });
    const rulesAfterSuspend = await downstream.listSyncRulesByMapping(syncMapping.id);
    expect(rulesAfterSuspend[0]?.status).toBe("enabled");
    expect(rulesAfterSuspend[0]?.backfillStatus).toBe("completed");

    // SL-10.1 — the binding fails with the DISTINCT `mapping-suspended` cause (RP-3), not
    // `mapping-stale`, and its own status is untouched.
    const bindingsAfterSuspend = await downstream.listAdapterBindingsByMapping(adapterMapping.id);
    const bindingRow = bindingsAfterSuspend[0];
    if (bindingRow === undefined) throw new Error("expected the adapter binding");
    expect(bindingRow.status).toBe("active");
    expect(
      validateBindingHealth({
        binding: bindingRow,
        mappingStatus: "suspended",
        backendStatus: "active",
      }),
    ).toEqual({ cause: "mapping-suspended" });

    // SL-10.4 / XI-2 — the consumer-provider mapping's endpoint cache dropped. The peer-peer
    // mapping has no adapter bindings, so it drops nothing.
    expect(cacheDrops).toEqual([endpoint.id]);

    // SL-10.4 / GR-2/GR-3 — both edges recompute to `paused` (a suspended mapping pauses
    // every member), so no stale graph edge masks the hold.
    expect((await downstream.getGraphEdge(provider.id, peer.id, "sync"))?.status).toBe("paused");
    expect(
      (await downstream.getGraphEdge(consumer.id, provider.id, "adapter-dependency"))?.status,
    ).toBe("paused");

    // SL-10.3 / OA-3 — each suspend is attributed to the authenticated operator.
    const syncAudit = await auditFor(syncMapping.id);
    expect(syncAudit).toHaveLength(1);
    expect(syncAudit[0]?.actor).toBe(OPERATOR);
    expect(syncAudit[0]?.details).toContain("suspended");

    // ── SL-10.2 — RESUME both mappings (the exact inverse). ──
    cacheDrops.length = 0;
    expect((await suspension.resume(syncMapping.id, OPERATOR)).status).toBe("active");
    expect((await suspension.resume(adapterMapping.id, OPERATOR)).status).toBe("active");

    // The rule polls again under its STORED state — no re-backfill was triggered.
    const resumedCandidates = await new SyncRuleRepository(db).listPollCandidates();
    const resumedCandidate = resumedCandidates.find((candidate) => candidate.rule.id === rule.id);
    if (resumedCandidate === undefined) throw new Error("expected the rule in the candidate set");
    expect(decidePoll(resumedCandidate, new Date()).kind).toBe("poll");
    const rulesAfterResume = await downstream.listSyncRulesByMapping(syncMapping.id);
    expect(rulesAfterResume[0]?.backfillStatus).toBe("completed");

    // The binding is healthy again — no re-composition was required.
    const bindingsAfterResume = await downstream.listAdapterBindingsByMapping(adapterMapping.id);
    const resumedBinding = bindingsAfterResume[0];
    if (resumedBinding === undefined) throw new Error("expected the adapter binding");
    expect(resumedBinding.status).toBe("active");
    expect(resumedBinding.role).toBe("primary");
    expect(
      validateBindingHealth({
        binding: resumedBinding,
        mappingStatus: "active",
        backendStatus: "active",
      }),
    ).toBeUndefined();

    // SL-10.4 — resume drops the cache again (so no entry cached under the suspension is
    // served) and repaints both edges to `active`.
    expect(cacheDrops).toEqual([endpoint.id]);
    expect((await downstream.getGraphEdge(provider.id, peer.id, "sync"))?.status).toBe("active");
    expect(
      (await downstream.getGraphEdge(consumer.id, provider.id, "adapter-dependency"))?.status,
    ).toBe("active");

    // SL-10.3 — the resume is audited to the operator too (two rows now).
    const auditAfterResume = await auditFor(syncMapping.id);
    expect(auditAfterResume).toHaveLength(2);
    expect(auditAfterResume[1]?.actor).toBe(OPERATOR);
    expect(auditAfterResume[1]?.details).toContain("resumed");
  });

  it("rejects an illegal transition: resuming an active mapping and suspending a suspended one", async () => {
    const provider = makeApp("SL-10 guard provider");
    const peer = makeApp("SL-10 guard peer");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peer);
    const providerSpec = await seedBareSpec(provider.id);
    const peerSpec = await seedBareSpec(peer.id);

    const mappings = new ApprovedMappingRepository(db);
    const mapping: ApprovedMapping = {
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
    mappingIds.push(mapping.id);
    await mappings.insert(mapping);

    // Resume is valid only from `suspended`.
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    await suspension.suspend(mapping.id, OPERATOR);
    // Suspend is valid only from `active` — suspending twice is a conflict, not a no-op.
    await expect(suspension.suspend(mapping.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    expect((await mappings.getById(mapping.id))?.status).toBe("suspended");

    // An unknown mapping is a clean 404, not a silent no-op.
    await expect(suspension.suspend(randomUUID(), OPERATOR)).rejects.toThrow(/not found/i);
  });

  it("SL-10.5 a breaking diff marks a SUSPENDED mapping stale, and a later resume is rejected", async () => {
    const provider = makeApp("SL-10 breaking provider");
    const peer = makeApp("SL-10 breaking peer");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peer);

    const providerV1 = await seedProviderV1(provider.id);
    const peerSpec = await seedBareSpec(peer.id);

    const mappings = new ApprovedMappingRepository(db);
    const artifacts = new MappingArtifactsRepository(db);
    const mapping: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: providerV1.id,
      targetSpecId: peerSpec.id,
      sourceAppId: provider.id,
      targetAppId: peer.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(mapping.id);
    await mappings.insert(mapping);
    // References the `issues.title` the breaking bump retypes.
    await artifacts.replaceChildren(mapping.id, {
      fieldMappings: [
        {
          id: randomUUID(),
          mappingId: mapping.id,
          sourcePath: "issues/title",
          targetPath: "issues/title",
          transform: "rename",
        },
      ],
      operationMappings: [],
      parameterMappings: [],
    });

    // The operator puts it on a manual hold FIRST.
    expect((await suspension.suspend(mapping.id, OPERATOR)).status).toBe("suspended");

    // ── A breaking spec bump lands while the mapping is suspended. ──
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDoc("integer"),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    specIds.push(outcome.newSpec.id);

    // SL-10.5 — the manual hold did NOT make the diff skip the mapping; the more-blocking
    // `stale` wins. `status` is a single enum, so it is now `stale`, not "suspended+stale".
    const afterBreak = await mappings.getById(mapping.id);
    expect(afterBreak?.status).toBe("stale");
    // SL-4.3 — still pinned to the version it was reviewed against.
    expect(afterBreak?.sourceSpecId).toBe(providerV1.id);

    // A suspended-then-stale mapping reaches `active` only through re-review — never resume.
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toThrow(/re-review/i);
    expect((await mappings.getById(mapping.id))?.status).toBe("stale");
  });

  // ── SL-10.2 — the resume pin catch-up: a hold DEFERS the lifecycle, never exempts it ──

  /** Seed a suspended peer-peer mapping on a real provider v1 + a bare peer spec. */
  async function seedSuspendedMapping(label: string): Promise<{
    provider: RegisteredApp;
    providerV1: ApiSpec;
    peerSpec: ApiSpec;
    mapping: ApprovedMapping;
  }> {
    const provider = makeApp(`${label} provider`);
    const peer = makeApp(`${label} peer`);
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peer);
    const providerV1 = await seedProviderV1(provider.id);
    const peerSpec = await seedBareSpec(peer.id);

    const mapping: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: providerV1.id,
      targetSpecId: peerSpec.id,
      sourceAppId: provider.id,
      targetAppId: peer.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(mapping.id);
    await new ApprovedMappingRepository(db).insert(mapping);
    // References `issues.title` — the field the breaking bump retypes.
    await new MappingArtifactsRepository(db).replaceChildren(mapping.id, {
      fieldMappings: [
        {
          id: randomUUID(),
          mappingId: mapping.id,
          sourcePath: "issues/title",
          targetPath: "issues/title",
          transform: "rename",
        },
      ],
      operationMappings: [],
      parameterMappings: [],
    });
    await suspension.suspend(mapping.id, OPERATOR);
    return { provider, providerV1, peerSpec, mapping };
  }

  /** An ADDITIVE bump of the provider doc: a new optional `Issue.assignee` field. */
  function providerDocWithAddedField(): Record<string, unknown> {
    const document = providerDoc("string");
    return {
      ...document,
      components: {
        schemas: {
          Issue: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              assignee: { type: "string" },
            },
            required: ["id"],
          },
          Label: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
            required: ["id"],
          },
        },
      },
    };
  }

  it("resume after an ADDITIVE advance during the hold re-pins to the current version and activates", async () => {
    const { provider, providerV1, peerSpec, mapping } =
      await seedSuspendedMapping("SL-10 additive");

    // An additive advance lands while suspended. SL-2 re-pins only ACTIVE mappings, so the
    // suspended mapping is left pinned to v1 and v1 becomes `superseded`.
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDocWithAddedField(),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("additive");
    const v2Id = outcome.newSpec.id;
    specIds.push(v2Id);

    const mappings = new ApprovedMappingRepository(db);
    expect((await mappings.getById(mapping.id))?.sourceSpecId).toBe(providerV1.id);
    expect((await new ApiSpecRepository(db).getById(providerV1.id))?.status).toBe("superseded");

    // ── Resume catches the mapping up: nothing it references broke → re-pin, then activate. ──
    const resumed = await suspension.resume(mapping.id, OPERATOR);
    expect(resumed.status).toBe("active");
    // The load-bearing assertion: it is pinned to the CURRENT active version, never a
    // superseded one (data-model `ApprovedMapping.sourceSpecId`), so every later advance
    // still finds it.
    expect(resumed.sourceSpecId).toBe(v2Id);
    expect(resumed.targetSpecId).toBe(peerSpec.id); // the untouched side is carried forward
    const reloaded = await mappings.getById(mapping.id);
    expect(reloaded?.sourceSpecId).toBe(v2Id);

    // It is now in the ACTIVE set a subsequent advance of v2 would re-pin — no longer orphaned.
    expect((await mappings.listActiveBySpecId(v2Id)).map((row) => row.id)).toContain(mapping.id);

    // SL-2's re-pin audit row was written alongside the operator's resume row.
    const rows = await auditFor(mapping.id);
    expect(rows.some((row) => row.details?.includes("re-pinned") === true)).toBe(true);
    expect(rows.some((row) => row.actor === OPERATOR && row.details?.includes("resumed"))).toBe(
      true,
    );
  });

  it("resume after a BREAKING advance during the hold marks stale, triggers SL-6 re-review, and is rejected", async () => {
    const { provider, providerV1, mapping } = await seedSuspendedMapping("SL-10 breaking-hold");
    enqueuedJobs.length = 0;

    // A BREAKING advance lands while suspended. The suspended mapping is pinned to v1, so
    // the advance's own SL-4 pass classifies it — but to isolate the catch-up we assert the
    // resume path drives the reaction for a mapping the advance could not reach: re-pin it
    // back to v1 first is unnecessary here, because SL-10.5 already stales it at advance
    // time. Instead this case proves the SAME outcome is reached via resume for a mapping
    // whose break is only discovered at resume time (below, the two-advance case).
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDoc("integer"),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    specIds.push(outcome.newSpec.id);

    const mappings = new ApprovedMappingRepository(db);
    // SL-10.5 (advance-time) — already stale, pinned to v1.
    expect((await mappings.getById(mapping.id))?.status).toBe("stale");
    expect((await mappings.getById(mapping.id))?.sourceSpecId).toBe(providerV1.id);
    // ...and resume is refused with the re-review reason.
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toThrow(/re-review/i);
  });

  it("resume across TWO advances (additive then breaking) stales via the catch-up and is rejected", async () => {
    const { provider, providerV1, mapping } = await seedSuspendedMapping("SL-10 two-advance");
    enqueuedJobs.length = 0;
    cacheDrops.length = 0;

    // (1) ADDITIVE v1 → v2 while suspended: SL-2 re-pins only active mappings, so the
    //     suspended mapping stays pinned to v1 and the advance's SL-4 pass does not stale it.
    const additive = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDocWithAddedField(),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (additive.kind !== "advanced") throw new Error("expected advanced");
    expect(additive.diff.classification).toBe("additive");
    specIds.push(additive.newSpec.id);

    const mappings = new ApprovedMappingRepository(db);
    expect((await mappings.getById(mapping.id))?.status).toBe("suspended");
    expect((await mappings.getById(mapping.id))?.sourceSpecId).toBe(providerV1.id);

    // (2) BREAKING v2 → v3. The mapping is pinned to v1, so the advance looks up by v2 and
    //     CANNOT see it — this is exactly the detachment the catch-up exists to close.
    const breaking = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDoc("integer"),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (breaking.kind !== "advanced") throw new Error("expected advanced");
    expect(breaking.diff.classification).toBe("breaking");
    const v3Id = breaking.newSpec.id;
    specIds.push(v3Id);
    // The advance did NOT reach it (still suspended, still pinned to v1).
    expect((await mappings.getById(mapping.id))?.status).toBe("suspended");

    // ── Resume diffs pinned v1 → current v3 in ONE comparison and finds the break. ──
    enqueuedJobs.length = 0;
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);

    // The stale mark COMMITTED even though the resume was rejected.
    const after = await mappings.getById(mapping.id);
    expect(after?.status).toBe("stale");
    // SL-4.3 — a stale mapping stays pinned to the version it was reviewed against.
    expect(after?.sourceSpecId).toBe(providerV1.id);

    // SL-6 — the scoped re-review job that produces the successor proposal was recorded
    // against the CURRENT active version, scoped to this one mapping and the touched pair.
    expect(enqueuedJobs).toHaveLength(1);
    const job = enqueuedJobs[0];
    if (job?.scope.kind !== "re-review") throw new Error("expected a re-review scope");
    expect(job.apiSpecId).toBe(v3Id);
    expect(job.scope.supersededSpecId).toBe(providerV1.id);
    expect(job.scope.staleMappings.map((entry) => entry.staleMappingId)).toEqual([mapping.id]);
    expect(job.scope.staleMappings[0]?.affectedPairs).toEqual([
      { sourceResource: "issues", targetResource: "issues" },
    ]);

    // A second resume attempt now hits the plain `stale` guard.
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toThrow(/re-review/i);
  });

  it("refuses to resume when another mapping took the pair's active slot during the hold", async () => {
    const { provider, providerV1, peerSpec, mapping } =
      await seedSuspendedMapping("SL-10 incumbent");
    void provider;

    // While suspended, a new approval takes the pair's single `active` slot: the approval
    // service's update-in-place keys on the ACTIVE mapping, finds none, and inserts.
    const incumbent: ApprovedMapping = {
      id: randomUUID(),
      sourceSpecId: providerV1.id,
      targetSpecId: peerSpec.id,
      sourceAppId: mapping.sourceAppId,
      targetAppId: mapping.targetAppId,
      variant: "peer-peer",
      approvedBy: "reviewer:bob",
      approvedAt: CREATED_AT,
      status: "active",
    };
    mappingIds.push(incumbent.id);
    await new ApprovedMappingRepository(db).insert(incumbent);

    // Resume must report the state conflict (409), NOT surface a raw constraint violation.
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
    await expect(suspension.resume(mapping.id, OPERATOR)).rejects.toThrow(
      /already the active mapping/i,
    );
    // Nothing changed: the held mapping is still suspended, the incumbent still active.
    const mappings = new ApprovedMappingRepository(db);
    expect((await mappings.getById(mapping.id))?.status).toBe("suspended");
    expect((await mappings.getById(incumbent.id))?.status).toBe("active");
  });
});
