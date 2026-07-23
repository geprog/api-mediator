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
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
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
import { inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GraphProjection } from "./modules/graph/index.js";
import type {
  CredentialTxStore,
  EndpointCacheInvalidator,
  TxStores,
} from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";
import { validateBindingHealth } from "./http/adapter-runtime/serve/planner.js";

/**
 * SL-4 — live-Postgres backend integration for the **breaking reaction** wired into
 * {@link SpecRegistry.ingestNewVersion}. A breaking spec bump on a provider:
 *
 *  - **SL-4.1/4.3** marks ONLY the mappings that reference a changed element `stale` and
 *    leaves them pinned to the reviewed (superseded) version, while every mapping that
 *    references no changed element re-pins to the new version exactly as SL-2;
 *  - **SL-4.2** staleness lives on the mapping alone: the derived `SyncRule`/`AdapterBinding`
 *    keep their own `status`, the rule **pauses** (asserted via the real Scheduler gate
 *    `decidePoll` over `SyncRuleRepository.listPollCandidates`) and the binding fails
 *    `mapping-stale` (asserted via the real RP-3 `validateBindingHealth`);
 *  - **SL-4.4** the same path covers a PROVIDER-side peer-peer `SyncRule` AND a
 *    consumer-provider `AdapterBinding` backed by the changed spec;
 *  - **SL-4.6 / XI-2 / GR-2/GR-3** the affected endpoints' caches drop (spy invalidator)
 *    and the affected `GraphEdge`s recompute to `stale`, while an unaffected edge is
 *    untouched.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable. Teardown deletes `graph_edge` and `adapter_endpoint`
 * (both FK `registered_app` with no cascade) BEFORE `registered_app`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-22T00:00:00.000Z");

/** Storing credentials / emitting events is never part of a version advance (SL-1/SL-4). */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** A two-resource provider doc: `issues` (id, title:<titleType>, updated) + `labels` (id, name). */
function providerDoc(titleType: "string" | "integer"): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "SL-4 Provider", version: "1.0.0" },
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
              content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } },
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
          properties: {
            id: { type: "integer" },
            title: { type: titleType },
            updated: { type: "string" },
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

suite(
  "SL-4 breaking reaction — mark stale, pause/flag, drop cache, recompute edges (requires Postgres)",
  () => {
    let db: Database;
    let graphProjection: GraphProjection;
    const registry = new SpecRegistry();
    const appIds: string[] = [];
    const specIds: string[] = [];
    const mappingIds: string[] = [];
    const cacheDrops: string[] = [];

    beforeAll(async () => {
      db = createDb(resolveDatabaseUrl(process.env));
      await runMigrations(db);
      graphProjection = new GraphProjection({ db });
    });

    afterAll(async () => {
      // FK-safe teardown. `graph_edge` and `adapter_endpoint` FK `registered_app` with NO
      // cascade, so they are deleted BEFORE the apps (a prior branch's teardown FK-poisoned
      // the shared DB by not doing this). `approved_mapping` cascades its field/operation
      // mappings, sync rules, and adapter bindings; it is deleted before the specs it pins.
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
        baseUrl: "https://sl4.example.test",
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

    /** A minimal `active` spec row (a real `api_spec` the FKs need); `parsedIR` empty is fine for a peer/consumer counterpart. */
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
      const cacheInvalidator: EndpointCacheInvalidator = {
        invalidateEndpoint: (endpointId) => {
          cacheDrops.push(endpointId);
        },
      };
      return {
        registeredApps: new RegisteredAppRepository(handle),
        apiSpecs: new ApiSpecRepository(handle),
        resourceBindings: new ResourceBindingRepository(handle),
        credentialStore: unusedCredentials,
        approvedMappings: new ApprovedMappingRepository(handle),
        audit: new AuditLogRepository(handle),
        detectionJobs: { enqueueScoped: (): Promise<void> => Promise.resolve() },
        mappingArtifacts: new MappingArtifactsRepository(handle),
        downstreamArtifacts: new DownstreamArtifactRepository(handle),
        graph: {
          recomputeSyncEdge: (sourceAppId, targetAppId) =>
            graphProjection.recomputeSyncEdgeWithin(handle, sourceAppId, targetAppId),
          recomputeAdapterEdge: (consumerAppId, backendAppId) =>
            graphProjection.recomputeAdapterEdgeWithin(handle, consumerAppId, backendAppId),
        },
        cacheInvalidator,
        // SL-5 operational-ref re-validation ports (real repos). This SL-4 spec seeds no
        // bindings/rules/correspondences on the changed provider, so SL-5 finds nothing to
        // re-validate — proving SL-4 and SL-5 share the breaking branch without interfering.
        syncRules: new SyncRuleRepository(handle),
        scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
        scopeLifecycle: new ScopeLifecycleService({
          resourceBindings: new ResourceBindingRepository(handle),
          scopeCorrespondences: new ScopeCorrespondenceRepository(handle),
          scopeLinks: new ScopeLinkRepository(handle),
        }),
        emit: () => Promise.reject(new Error("ingestNewVersion must not emit on advance")),
      };
    }

    it("stales the referencing mappings (pinned), re-pins the rest, pauses the rule, fails the binding mapping-stale, drops cache, recomputes edges", async () => {
      const provider = makeApp("SL-4 provider");
      const peerB = makeApp("SL-4 peer-B");
      const peerC = makeApp("SL-4 peer-C");
      const consumer = makeApp("SL-4 consumer");
      const appRepo = new RegisteredAppRepository(db);
      await appRepo.create(provider);
      await appRepo.create(peerB);
      await appRepo.create(peerC);
      await appRepo.create(consumer);

      const aV1 = await seedProviderV1(provider.id);
      const bSpec = await seedBareSpec(peerB.id);
      const cSpec = await seedBareSpec(peerC.id);
      const conSpec = await seedBareSpec(consumer.id);

      const mappings = new ApprovedMappingRepository(db);
      const artifacts = new MappingArtifactsRepository(db);
      const downstream = new DownstreamArtifactRepository(db);

      // M_issues (peer-peer, source = provider issues) — references the changed `issues.title`.
      const mIssues: ApprovedMapping = {
        id: randomUUID(),
        sourceSpecId: aV1.id,
        targetSpecId: bSpec.id,
        sourceAppId: provider.id,
        targetAppId: peerB.id,
        variant: "peer-peer",
        approvedBy: "reviewer:alice",
        approvedAt: CREATED_AT,
        status: "active",
      };
      mappingIds.push(mIssues.id);
      await mappings.insert(mIssues);
      const mIssuesField: FieldMapping = {
        id: randomUUID(),
        mappingId: mIssues.id,
        sourcePath: "issues/title",
        targetPath: "issues/title",
        transform: "rename",
      };
      await artifacts.replaceChildren(mIssues.id, {
        fieldMappings: [mIssuesField],
        operationMappings: [],
        parameterMappings: [],
      });
      const rIssues: SyncRule = {
        id: randomUUID(),
        approvedMappingId: mIssues.id,
        resourcePairRef: `${provider.id}:issues|${peerB.id}:issues`,
        status: "enabled",
        backfillStatus: "completed",
      };
      await downstream.insertSyncRuleIfAbsent(rIssues);

      // M_labels (peer-peer, source = provider labels) — references only the unchanged `labels`.
      const mLabels: ApprovedMapping = {
        id: randomUUID(),
        sourceSpecId: aV1.id,
        targetSpecId: cSpec.id,
        sourceAppId: provider.id,
        targetAppId: peerC.id,
        variant: "peer-peer",
        approvedBy: "reviewer:alice",
        approvedAt: CREATED_AT,
        status: "active",
      };
      mappingIds.push(mLabels.id);
      await mappings.insert(mLabels);
      await artifacts.replaceChildren(mLabels.id, {
        fieldMappings: [
          {
            id: randomUUID(),
            mappingId: mLabels.id,
            sourcePath: "labels/name",
            targetPath: "labels/name",
            transform: "rename",
          },
        ],
        operationMappings: [],
        parameterMappings: [],
      });
      const rLabels: SyncRule = {
        id: randomUUID(),
        approvedMappingId: mLabels.id,
        resourcePairRef: `${provider.id}:labels|${peerC.id}:labels`,
        status: "enabled",
        backfillStatus: "completed",
      };
      await downstream.insertSyncRuleIfAbsent(rLabels);

      // M_adapter (consumer-provider, backend/target = provider issues) — reads `issues.title`.
      const mAdapter: ApprovedMapping = {
        id: randomUUID(),
        sourceSpecId: conSpec.id,
        targetSpecId: aV1.id,
        sourceAppId: consumer.id,
        targetAppId: provider.id,
        variant: "consumer-provider",
        approvedBy: "reviewer:alice",
        approvedAt: CREATED_AT,
        status: "active",
      };
      mappingIds.push(mAdapter.id);
      await mappings.insert(mAdapter);
      const adapterOp: OperationMapping = {
        id: randomUUID(),
        mappingId: mAdapter.id,
        sourceOperationRef: "con-issues/getConIssue",
        targetOperationRef: "issues/getIssue",
        action: "read",
      };
      // RESPONSE-phase field: the convention inverts (serve-context.ts/response-mapping.ts),
      // so `sourcePath` is the BACKEND (provider `issues/title`) field it reads and
      // `targetPath` the consumer (`con-issues/title`) field it writes.
      const adapterField: FieldMapping = {
        id: randomUUID(),
        mappingId: mAdapter.id,
        sourcePath: "issues/title",
        targetPath: "con-issues/title",
        transform: "rename",
        phase: "response",
      };
      await artifacts.replaceChildren(mAdapter.id, {
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
      const adapterBinding: AdapterBinding = {
        id: randomUUID(),
        adapterEndpointId: endpoint.id,
        backendAppId: provider.id,
        backendOperationId: "issues/getIssue",
        approvedMappingId: mAdapter.id,
        role: "primary",
        status: "active",
      };
      await downstream.insertAdapterBindingIfAbsent(adapterBinding);

      // Seed the initial (pre-break) graph edges the projection would create at approval.
      await downstream.upsertGraphEdge({
        id: randomUUID(),
        sourceNodeId: provider.id,
        targetNodeId: peerB.id,
        type: "sync",
        status: "disabled",
        metadata: {
          direction: { sourceSpecId: aV1.id, targetSpecId: bSpec.id },
          lastActivityAt: null,
        },
      });
      await downstream.upsertGraphEdge({
        id: randomUUID(),
        sourceNodeId: provider.id,
        targetNodeId: peerC.id,
        type: "sync",
        status: "disabled",
        metadata: {
          direction: { sourceSpecId: aV1.id, targetSpecId: cSpec.id },
          lastActivityAt: null,
        },
      });
      await downstream.upsertGraphEdge({
        id: randomUUID(),
        sourceNodeId: consumer.id,
        targetNodeId: provider.id,
        type: "adapter-dependency",
        status: "proposed",
        metadata: {
          direction: { sourceSpecId: conSpec.id, targetSpecId: aV1.id },
          lastActivityAt: null,
        },
      });

      // ── Advance the provider with a BREAKING change (issues.title retyped integer). ──
      const outcome = await tx(db, (handle) =>
        registry.ingestNewVersion(
          provider.id,
          providerDoc("integer"),
          "PROVIDER",
          txStoresOn(handle),
        ),
      );
      expect(outcome.kind).toBe("advanced");
      if (outcome.kind !== "advanced") throw new Error("expected advanced");
      expect(outcome.diff.classification).toBe("breaking");
      const aV2Id = outcome.newSpec.id;
      specIds.push(aV2Id);

      // ── SL-4.1/4.3 — the two mappings referencing `issues` are stale AND stay pinned to v1. ──
      const mIssuesAfter = await mappings.getById(mIssues.id);
      expect(mIssuesAfter?.status).toBe("stale");
      expect(mIssuesAfter?.sourceSpecId).toBe(aV1.id); // stays pinned to the superseded version.
      const mAdapterAfter = await mappings.getById(mAdapter.id);
      expect(mAdapterAfter?.status).toBe("stale");
      expect(mAdapterAfter?.targetSpecId).toBe(aV1.id);

      // ── SL-4.1 — the labels mapping references no changed element → re-pinned to v2, active. ──
      const mLabelsAfter = await mappings.getById(mLabels.id);
      expect(mLabelsAfter?.status).toBe("active");
      expect(mLabelsAfter?.sourceSpecId).toBe(aV2Id);

      // ── SL-4.2 — the derived rule/binding keep their OWN status. ──
      const rulesIssues = await downstream.listSyncRulesByMapping(mIssues.id);
      expect(rulesIssues[0]?.status).toBe("enabled");
      const bindingsAdapter = await downstream.listAdapterBindingsByMapping(mAdapter.id);
      expect(bindingsAdapter[0]?.status).toBe("active");

      // ── SL-4.2 — the stale mapping's rule PAUSES (real Scheduler gate over the real candidate query). ──
      const candidates = await new SyncRuleRepository(db).listPollCandidates();
      const issuesCandidate = candidates.find((c) => c.rule.id === rIssues.id);
      const labelsCandidate = candidates.find((c) => c.rule.id === rLabels.id);
      expect(issuesCandidate).toBeDefined();
      expect(labelsCandidate).toBeDefined();
      if (issuesCandidate === undefined || labelsCandidate === undefined) {
        throw new Error("expected both rules in the candidate set");
      }
      const now = new Date();
      const issuesDecision = decidePoll(issuesCandidate, now);
      expect(issuesDecision).toEqual({ kind: "hold", reason: "mapping-stale" });
      // The re-pinned (active) mapping's rule is NOT held for mapping status — it polls.
      expect(decidePoll(labelsCandidate, now).kind).toBe("poll");

      // ── SL-4.2 — the stale mapping's binding fails `mapping-stale` (the real RP-3 rule). ──
      const bindingRow = bindingsAdapter[0];
      expect(bindingRow).toBeDefined();
      if (bindingRow === undefined) throw new Error("expected the adapter binding");
      expect(
        validateBindingHealth({
          binding: bindingRow,
          mappingStatus: "stale",
          backendStatus: "active",
        }),
      ).toEqual({ cause: "mapping-stale" });

      // ── SL-4.6 / XI-2 — ONLY the stale adapter mapping's endpoint cache dropped. ──
      expect(cacheDrops).toEqual([endpoint.id]);

      // ── SL-4.6 / GR-2/GR-3 — the affected edges recompute to `stale`; the unaffected one is untouched. ──
      const syncEdgeB = await downstream.getGraphEdge(provider.id, peerB.id, "sync");
      expect(syncEdgeB?.status).toBe("stale");
      const adapterEdge = await downstream.getGraphEdge(
        consumer.id,
        provider.id,
        "adapter-dependency",
      );
      expect(adapterEdge?.status).toBe("stale");
      // The re-pinned labels mapping stayed active → its edge is NOT recomputed (still `disabled`).
      const syncEdgeC = await downstream.getGraphEdge(provider.id, peerC.id, "sync");
      expect(syncEdgeC?.status).toBe("disabled");

      // ── SL-4.1 — the version advanced and v1 is now superseded. ──
      expect(outcome.supersededSpec.id).toBe(aV1.id);
      const aV1After = await new ApiSpecRepository(db).getById(aV1.id);
      expect(aV1After?.status).toBe("superseded");
    });
  },
);
