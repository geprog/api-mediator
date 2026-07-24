import { randomUUID } from "node:crypto";

import { resolveRequest } from "@mediator/adapter-engine";
import {
  CredentialStore,
  DbCredentialPersistence,
  EnvKeyProvider,
  type ValidateTokenResult,
} from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  CredentialRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncFieldStateRepository,
  SyncRuleRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  credential,
  graphEdge,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  scopeCorrespondence,
  scopeLink,
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
  RecordLink,
  RegisteredApp,
  ScopeCorrespondence,
  ScopeLink,
  SyncFieldState,
  SyncRule,
} from "@mediator/domain";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BadRequestError } from "./app-errors.js";
import { AdapterTokenService, buildAdapterTokenValidator } from "./modules/adapter-token/index.js";
import { AppLifecycleService } from "./modules/app-lifecycle.js";
import { GraphProjection } from "./modules/graph/index.js";
import { dbSyncStateArchival } from "./modules/persistence.js";
import type { CredentialTxStore, DetectionJobTxRepo, TxStores } from "./modules/persistence.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";

/**
 * **AL-2 / AL-3 — live-Postgres backend integration for deregistering an app**, driven
 * through the real {@link AppLifecycleService} against real repositories, the real
 * {@link GraphProjection}, the real {@link AdapterTokenService}, a real
 * {@link CredentialStore}, and a spy cache invalidator.
 *
 * The landscape each case builds is a real one: a `PROVIDER` app with an **enabled**
 * `SyncRule` over a real peer mapping (cross-linked to its reverse-direction
 * counterpart), a real composed `AdapterEndpoint` + `AdapterBinding` on another
 * consumer's surface, its own consumer `AdapterEndpoint` + issued adapter token, real
 * `RecordLink`s / `SyncFieldState` / `ScopeCorrespondence` + `ScopeLink`s, and a real
 * stored credential.
 *
 * Asserted end to end after one deregistration: rules + bindings **gone** from the
 * tables; a binding-less endpoint reverted to serving **`not-yet-mapped`** through the
 * real `resolveRequest`; the app's own consumer surface **torn down** so a caller hits
 * **nothing** (no endpoint row at all — the subtle distinction from `not-yet-mapped`);
 * the adapter token no longer validating; mappings/specs/links/field-state/scope-links
 * **archived** (links **not** tombstoned); the counterpart link **cleared**; the
 * credentials **actually gone** from the credential table; the app's `GraphEdge`s
 * **removed**; the caches dropped. Plus an AL-3 case: the same system registers again and
 * nothing of the prior registration is visible or used.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable. Teardown deletes the FK children (bindings, rules,
 * graph edges, endpoints, credentials, audit, links, scope links/correspondences,
 * mappings, specs) before `registered_app`.
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
/** The 32-byte master key the per-suite `CredentialStore` seals envelopes with. */
const MASTER_KEY = Buffer.alloc(32, 7);

/** A deregistration never stores credentials, enqueues analysis, or emits events. */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("AL-2 must not store credentials")),
};
const unusedDetectionJobs: DetectionJobTxRepo = {
  enqueueScoped: () => Promise.reject(new Error("AL-2 must not enqueue analysis")),
  lockUnfinishedJob: () => Promise.reject(new Error("AL-2 must not enqueue analysis")),
  updateScope: () => Promise.reject(new Error("AL-2 must not enqueue analysis")),
};

suite("AL-2 deregister a RegisteredApp and cascade (requires Postgres)", () => {
  let db: Database;
  let graphProjection: GraphProjection;
  let lifecycle: AppLifecycleService;
  let tokens: AdapterTokenService;
  let credentialStore: CredentialStore;

  const appIds: string[] = [];
  const mappingIds: string[] = [];
  const ruleIds: string[] = [];
  const endpointIds: string[] = [];
  const recordLinkIds: string[] = [];
  const correspondenceIds: string[] = [];
  /** Every `invalidateEndpoint` the cascade drove, in order (the XI-2 spy). */
  const cacheDrops: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    graphProjection = new GraphProjection({ db, newId: randomUUID });
    credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(MASTER_KEY),
    );
    tokens = new AdapterTokenService({ db, rotationOverlapMs: 86_400_000 });
    lifecycle = new AppLifecycleService({
      // A real transaction over a hand-built `TxStores` of real repositories + the real
      // `GraphProjection`, so the cascade hits real rows, real constraints, and real
      // `ON DELETE CASCADE` behavior.
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
    // FK-safe teardown: every referencing row before `registered_app`.
    if (endpointIds.length > 0) {
      await db.delete(adapterBinding).where(inArray(adapterBinding.adapterEndpointId, endpointIds));
    }
    if (ruleIds.length > 0) {
      await db.delete(syncRule).where(inArray(syncRule.id, ruleIds));
    }
    if (recordLinkIds.length > 0) {
      // `sync_field_state` cascades from `record_link`.
      await db.delete(recordLink).where(inArray(recordLink.id, recordLinkIds));
    }
    if (correspondenceIds.length > 0) {
      await db.delete(scopeLink).where(inArray(scopeLink.scopeCorrespondenceId, correspondenceIds));
      await db
        .delete(scopeCorrespondence)
        .where(inArray(scopeCorrespondence.id, correspondenceIds));
    }
    if (appIds.length > 0) {
      await db
        .delete(graphEdge)
        .where(
          or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)),
        );
      await db.delete(adapterEndpoint).where(inArray(adapterEndpoint.consumerAppId, appIds));
      await db.delete(credential).where(inArray(credential.appId, appIds));
      await db.delete(auditLog).where(inArray(auditLog.originAppId, appIds));
    }
    if (mappingIds.length > 0) {
      // Clear the self-referencing counterpart links before deleting the rows.
      await db
        .update(approvedMapping)
        .set({ counterpartMappingId: null })
        .where(inArray(approvedMapping.id, mappingIds));
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
      syncStateArchival: dbSyncStateArchival(handle),
      credentials: new CredentialRepository(handle),
      emit: () => Promise.reject(new Error("AL-2 must not emit")),
    };
  }

  // ── seeding (real rows through the real repositories) ──────────────────────

  async function makeApp(
    name: string,
    baseUrl = "https://al2.example.test",
  ): Promise<RegisteredApp> {
    const app: RegisteredApp = {
      id: randomUUID(),
      name,
      status: "active",
      baseUrl,
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: true,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60_000,
      },
      createdAt: CREATED_AT,
    };
    appIds.push(app.id);
    await new RegisteredAppRepository(db).create(app);
    return app;
  }

  async function seedSpec(appId: string, role: ApiSpec["role"] = "PROVIDER"): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role,
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

  async function seedMapping(mapping: ApprovedMapping): Promise<ApprovedMapping> {
    mappingIds.push(mapping.id);
    return new ApprovedMappingRepository(db).insert(mapping);
  }

  async function seedRule(rule: SyncRule): Promise<void> {
    ruleIds.push(rule.id);
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(rule);
  }

  async function seedEndpoint(endpoint: AdapterEndpoint): Promise<AdapterEndpoint> {
    endpointIds.push(endpoint.id);
    return new DownstreamArtifactRepository(db).ensureAdapterEndpoint(endpoint);
  }

  async function seedBinding(binding: AdapterBinding): Promise<void> {
    await new DownstreamArtifactRepository(db).insertAdapterBindingIfAbsent(binding);
  }

  async function seedLink(link: RecordLink): Promise<RecordLink> {
    recordLinkIds.push(link.id);
    await new RecordLinkRepository(db).insert(link);
    return link;
  }

  async function seedFieldState(state: SyncFieldState): Promise<void> {
    await new SyncFieldStateRepository(db).seed([state]);
  }

  /** The persisted `RecordLink` row as it stands (status + tombstone columns). */
  async function linkRow(
    id: string,
  ): Promise<{ status: string; tombstoneReason: string | null; tombstonedAt: Date | null }> {
    const [row] = await db
      .select({
        status: recordLink.status,
        tombstoneReason: recordLink.tombstoneReason,
        tombstonedAt: recordLink.tombstonedAt,
      })
      .from(recordLink)
      .where(eq(recordLink.id, id));
    if (row === undefined) throw new Error("expected the record link row");
    return row;
  }

  /** The AL-2 audit rows for an app, oldest first. */
  async function auditFor(appId: string): Promise<{ actor: string; details: string | null }[]> {
    const rows = await db
      .select({ actor: auditLog.actor, details: auditLog.details, timestamp: auditLog.timestamp })
      .from(auditLog)
      .where(eq(auditLog.originAppId, appId));
    return [...rows]
      .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
      .map((row) => ({ actor: row.actor, details: row.details }));
  }

  it("runs the whole cascade against real rows: rules/bindings deleted, surface torn down, token revoked, state archived, edges removed", async () => {
    const provider = await makeApp(`AL-2 provider ${randomUUID()}`);
    const peer = await makeApp(`AL-2 peer ${randomUUID()}`);
    const consumer = await makeApp(`AL-2 consumer ${randomUUID()}`);
    const other = await makeApp(`AL-2 bystander ${randomUUID()}`);

    const providerSpec = await seedSpec(provider.id);
    const providerConsumerSpec = await seedSpec(provider.id, "CONSUMER");
    const peerSpec = await seedSpec(peer.id);
    const consumerSpec = await seedSpec(consumer.id, "CONSUMER");
    const otherSpec = await seedSpec(other.id);

    const mappings = new ApprovedMappingRepository(db);
    const downstream = new DownstreamArtifactRepository(db);

    // ── A bidirectional peer pair: two mappings, cross-linked as counterparts, each
    //    with a real ENABLED rule that has already polled. ──
    const forward = await seedMapping({
      id: randomUUID(),
      sourceSpecId: providerSpec.id,
      targetSpecId: peerSpec.id,
      sourceAppId: provider.id,
      targetAppId: peer.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });
    const reverse = await seedMapping({
      id: randomUUID(),
      sourceSpecId: peerSpec.id,
      targetSpecId: providerSpec.id,
      sourceAppId: peer.id,
      targetAppId: provider.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });
    await mappings.setCounterpart(forward.id, reverse.id);
    await mappings.setCounterpart(reverse.id, forward.id);

    // A mapping that does NOT involve the provider — its rule must survive untouched.
    const bystanderMapping = await seedMapping({
      id: randomUUID(),
      sourceSpecId: peerSpec.id,
      targetSpecId: otherSpec.id,
      sourceAppId: peer.id,
      targetAppId: other.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });

    const resourcePairRef = `${provider.id}:issues|${peer.id}:issues`;
    await seedRule({
      id: randomUUID(),
      approvedMappingId: forward.id,
      resourcePairRef,
      status: "enabled",
      backfillStatus: "completed",
      cursor: "cursor-2026-07-23T11:00:00Z",
    });
    await seedRule({
      id: randomUUID(),
      approvedMappingId: reverse.id,
      resourcePairRef,
      status: "enabled",
      backfillStatus: "completed",
    });
    const survivingRuleId = randomUUID();
    await seedRule({
      id: survivingRuleId,
      approvedMappingId: bystanderMapping.id,
      resourcePairRef: `${peer.id}:issues|${other.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
    });

    // ── The adapter side: the consumer's endpoint backed ONLY by the provider (it must
    //    revert to `not-yet-mapped`), a second endpoint the provider shares with another
    //    backend (it must keep serving), and the provider's OWN consumer surface. ──
    const adapterMapping = await seedMapping({
      id: randomUUID(),
      sourceSpecId: consumerSpec.id,
      targetSpecId: providerSpec.id,
      sourceAppId: consumer.id,
      targetAppId: provider.id,
      variant: "consumer-provider",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });
    const otherAdapterMapping = await seedMapping({
      id: randomUUID(),
      sourceSpecId: consumerSpec.id,
      targetSpecId: otherSpec.id,
      sourceAppId: consumer.id,
      targetAppId: other.id,
      variant: "consumer-provider",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });

    const soloEndpoint = await seedEndpoint({
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: `con-issues/getSolo-${randomUUID()}`,
      status: "active",
    });
    const sharedEndpoint = await seedEndpoint({
      id: randomUUID(),
      consumerAppId: consumer.id,
      consumerOperationId: `con-issues/getShared-${randomUUID()}`,
      status: "active",
    });
    const ownEndpoint = await seedEndpoint({
      id: randomUUID(),
      consumerAppId: provider.id,
      consumerOperationId: `own-issues/getOwn-${randomUUID()}`,
      status: "active",
    });
    await seedBinding({
      id: randomUUID(),
      adapterEndpointId: soloEndpoint.id,
      backendAppId: provider.id,
      backendOperationId: "issues/getIssue",
      approvedMappingId: adapterMapping.id,
      role: "primary",
      status: "active",
    });
    await seedBinding({
      id: randomUUID(),
      adapterEndpointId: sharedEndpoint.id,
      backendAppId: provider.id,
      backendOperationId: "issues/getIssue",
      approvedMappingId: adapterMapping.id,
      role: "primary",
      status: "active",
    });
    await seedBinding({
      id: randomUUID(),
      adapterEndpointId: sharedEndpoint.id,
      backendAppId: other.id,
      backendOperationId: "issues/getIssue",
      approvedMappingId: otherAdapterMapping.id,
      role: "supplement",
      status: "active",
    });
    // The provider's own surface is backed by the bystander app.
    await seedBinding({
      id: randomUUID(),
      adapterEndpointId: ownEndpoint.id,
      backendAppId: other.id,
      backendOperationId: "issues/getIssue",
      approvedMappingId: otherAdapterMapping.id,
      role: "primary",
      status: "active",
    });

    // ── Real linked sync state: two links naming the provider (one on each side) plus a
    //    tombstoned one, a bystander link, and their per-side baselines. ──
    function link(appAId: string, appBId: string, status: RecordLink["status"]): RecordLink {
      return {
        id: randomUUID(),
        appAId,
        appANativeId: randomUUID(),
        appBId,
        appBNativeId: randomUUID(),
        resourcePairRef: `${appAId}:issues|${appBId}:issues`,
        establishedBy: "identity-match",
        status,
        ...(status === "tombstoned" ? { tombstoneReason: "observed-delete" as const } : {}),
        establishingQueueKey: { kind: "both-native-id-queues" },
        createdAt: CREATED_AT,
        tombstonedAt: status === "tombstoned" ? CREATED_AT : null,
      };
    }
    const linkA = await seedLink(link(provider.id, peer.id, "active"));
    const linkB = await seedLink(link(peer.id, provider.id, "active"));
    const linkDead = await seedLink(link(provider.id, peer.id, "tombstoned"));
    const linkBystander = await seedLink(link(peer.id, other.id, "active"));
    for (const owner of [linkA, linkB, linkDead, linkBystander]) {
      await seedFieldState({
        id: randomUUID(),
        recordLinkId: owner.id,
        side: "A",
        fieldPath: "title",
        observedHash: "hash-title",
        observedAt: CREATED_AT,
        observedChangeTimestamp: null,
        status: "active",
      });
    }

    // ── A scoped pair naming the provider, and one that does not. ──
    const correspondence: ScopeCorrespondence = {
      id: randomUUID(),
      resourcePairRef,
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "projects/name" }],
      targetContainerRef: { appId: peer.id, resourceRef: "projects" },
      confirmedBy: null,
      confirmedAt: null,
    };
    const bystanderCorrespondence: ScopeCorrespondence = {
      id: randomUUID(),
      resourcePairRef: `${peer.id}:issues|${other.id}:issues`,
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "projects/name" }],
      targetContainerRef: { appId: other.id, resourceRef: "projects" },
      confirmedBy: null,
      confirmedAt: null,
    };
    correspondenceIds.push(correspondence.id, bystanderCorrespondence.id);
    await new ScopeCorrespondenceRepository(db).create(correspondence);
    await new ScopeCorrespondenceRepository(db).create(bystanderCorrespondence);
    function scopeLinkOf(parent: ScopeCorrespondence, appAId: string, appBId: string): ScopeLink {
      return {
        id: randomUUID(),
        scopeCorrespondenceId: parent.id,
        appAId,
        appAScopeKey: { owner: "acme" },
        appBId,
        appBScopeKey: { owner: "acme" },
        resourcePairRef: parent.resourcePairRef,
        establishedBy: "identity-match",
        status: "active",
        createdAt: CREATED_AT,
      };
    }
    const scopedLink = scopeLinkOf(correspondence, provider.id, peer.id);
    const bystanderScopeLink = scopeLinkOf(bystanderCorrespondence, peer.id, other.id);
    await new ScopeLinkRepository(db).create(scopedLink);
    await new ScopeLinkRepository(db).create(bystanderScopeLink);

    // ── Real credentials: a stored (envelope-encrypted) API key + a real adapter token. ──
    await credentialStore.store(provider.id, {
      secret: { type: "apiKey", apiKey: "provider-secret-value" },
    });
    await credentialStore.store(peer.id, {
      secret: { type: "apiKey", apiKey: "peer-secret-value" },
    });
    const issued = await tokens.issue(provider.id, OPERATOR);
    if (issued.outcome !== "issued") throw new Error("expected an issued adapter token");
    const rawToken = issued.token.rawToken;
    // Baseline: the token validates while the app is a live consumer app.
    const validator = buildAdapterTokenValidator({ db, rotationOverlapMs: 86_400_000 });
    const before: ValidateTokenResult = await validator.validate(rawToken);
    expect(before.outcome).toBe("resolved");

    // Pre-cascade graph edges, as the projection would have created them at approval.
    for (const edge of [
      {
        source: provider.id,
        target: peer.id,
        type: "sync" as const,
        direction: [providerSpec.id, peerSpec.id] as const,
      },
      {
        source: peer.id,
        target: provider.id,
        type: "sync" as const,
        direction: [peerSpec.id, providerSpec.id] as const,
      },
      {
        source: consumer.id,
        target: provider.id,
        type: "adapter-dependency" as const,
        direction: [consumerSpec.id, providerSpec.id] as const,
      },
      {
        source: consumer.id,
        target: other.id,
        type: "adapter-dependency" as const,
        direction: [consumerSpec.id, otherSpec.id] as const,
      },
    ]) {
      await downstream.upsertGraphEdge({
        id: randomUUID(),
        sourceNodeId: edge.source,
        targetNodeId: edge.target,
        type: edge.type,
        status: "active",
        metadata: {
          direction: { sourceSpecId: edge.direction[0], targetSpecId: edge.direction[1] },
          lastActivityAt: null,
        },
      });
    }

    // ── AL-2.1 — a wrong confirmation changes NOTHING against the real database. ──
    await expect(lifecycle.deregister(provider.id, OPERATOR, "wrong name")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await new SyncRuleRepository(db).getById(survivingRuleId)).toBeDefined();
    expect(await new CredentialRepository(db).listByAppId(provider.id)).toHaveLength(2);

    // ── DEREGISTER. ──
    cacheDrops.length = 0;
    const { app: after, summary } = await lifecycle.deregister(
      provider.id,
      OPERATOR,
      provider.name,
    );

    // The app row is RETAINED (the archived specs/mappings still FK it) and out of service.
    expect(after.status).toBe("disabled");
    expect(await new RegisteredAppRepository(db).getById(provider.id)).toBeDefined();

    // AL-2.2 — its rules are GONE from the table; a bystander rule survives.
    expect(summary.syncRulesDeleted).toBe(2);
    const survivingRules = await new SyncRuleRepository(db).listAll();
    expect(survivingRules.map((rule) => rule.id)).toContain(survivingRuleId);
    expect(
      await db
        .select({ id: syncRule.id })
        .from(syncRule)
        .where(inArray(syncRule.approvedMappingId, [forward.id, reverse.id])),
    ).toHaveLength(0);

    // AL-2.2 — the bindings it backed are gone; the other backend's survives...
    const sharedBindings = await downstream.listAdapterBindingsByEndpoint(sharedEndpoint.id);
    expect(sharedBindings).toHaveLength(1);
    expect(sharedBindings[0]?.backendAppId).toBe(other.id);
    // ...the solo endpoint has none left and therefore serves `not-yet-mapped` — through
    // the REAL RT-3 resolution over the REAL persisted state.
    const soloRow = await downstream.getAdapterEndpoint(
      consumer.id,
      soloEndpoint.consumerOperationId,
    );
    expect(soloRow?.status).toBe("composition-required");
    expect(
      resolveRequest({
        endpoint: soloRow,
        bindings: await downstream.listAdapterBindingsByEndpoint(soloEndpoint.id),
      }),
    ).toEqual({ kind: "not-yet-mapped", endpointId: soloEndpoint.id });
    // ...while the shared endpoint still SERVES (it kept an active binding).
    const sharedRow = await downstream.getAdapterEndpoint(
      consumer.id,
      sharedEndpoint.consumerOperationId,
    );
    expect(resolveRequest({ endpoint: sharedRow, bindings: sharedBindings }).kind).toBe("serve");

    // AL-2.3 — the app's OWN surface is torn down: there is no endpoint row at all, so a
    // caller hits NOTHING. The distinction from `not-yet-mapped` above is the point: that
    // one still has a row and answers with a cause; this one has no state to answer from.
    expect(summary.adapterEndpointsTornDown).toBe(1);
    expect(
      await downstream.getAdapterEndpoint(provider.id, ownEndpoint.consumerOperationId),
    ).toBeUndefined();
    expect(await downstream.listAdapterEndpointsByConsumerApp(provider.id)).toHaveLength(0);
    // Its bindings went with it through the FK cascade.
    expect(await downstream.listAdapterBindingsByEndpoint(ownEndpoint.id)).toHaveLength(0);

    // AL-2.3 / AT-4.5 — the adapter token no longer validates: its credential row is gone.
    const afterValidate: ValidateTokenResult = await validator.validate(rawToken);
    expect(afterValidate.outcome).toBe("rejected");

    // AL-2.4 — mappings archived and RETAINED; the counterpart pointing at one is cleared.
    expect(summary.approvedMappingsArchived).toBe(3);
    expect((await mappings.getById(forward.id))?.status).toBe("archived");
    expect((await mappings.getById(reverse.id))?.status).toBe("archived");
    expect((await mappings.getById(adapterMapping.id))?.status).toBe("archived");
    expect((await mappings.getById(bystanderMapping.id))?.status).toBe("active");
    // Both directions are archived here, so both counterpart columns are cleared.
    // A cleared counterpart reads back as an ABSENT domain key (the mapper collapses the
    // NULL column), never as a dangling id.
    expect((await mappings.getById(forward.id))?.counterpartMappingId).toBeUndefined();
    expect((await mappings.getById(reverse.id))?.counterpartMappingId).toBeUndefined();

    // AL-2.4 — the app's specs are archived (still resolvable for the archived mappings).
    expect(summary.apiSpecsArchived).toBe(2);
    const specs = new ApiSpecRepository(db);
    expect((await specs.getById(providerSpec.id))?.status).toBe("archived");
    expect((await specs.getById(providerConsumerSpec.id))?.status).toBe("archived");
    expect((await specs.getById(peerSpec.id))?.status).toBe("active");

    // AL-2.5 — links archived, NOT tombstoned; an already-tombstoned one keeps its tombstone.
    expect(summary.recordLinksArchived).toBe(2);
    for (const id of [linkA.id, linkB.id]) {
      expect(await linkRow(id)).toEqual({
        status: "archived",
        tombstoneReason: null,
        tombstonedAt: null,
      });
    }
    expect((await linkRow(linkDead.id)).status).toBe("tombstoned");
    expect((await linkRow(linkBystander.id)).status).toBe("active");

    // AL-2.5 — the per-side baselines of ALL the app's links archive (the tombstoned one
    // included); the bystander link's stays active.
    expect(summary.syncFieldStatesArchived).toBe(3);
    const fieldStates = new SyncFieldStateRepository(db);
    for (const id of [linkA.id, linkB.id, linkDead.id]) {
      expect((await fieldStates.findByLink(id))[0]?.status).toBe("archived");
    }
    expect((await fieldStates.findByLink(linkBystander.id))[0]?.status).toBe("active");

    // AL-2.5 — the scoped pair's `ScopeLink`s archive through the SS-10.5 sweep.
    expect(summary.scopeLinksArchived).toBe(1);
    const scopeLinks = new ScopeLinkRepository(db);
    expect((await scopeLinks.getById(scopedLink.id))?.status).toBe("archived");
    expect((await scopeLinks.getById(bystanderScopeLink.id))?.status).toBe("active");

    // AL-2.6 — the credentials are ACTUALLY GONE from the credential store, every type.
    expect(summary.credentialsDeleted).toBe(2);
    const credentials = new CredentialRepository(db);
    expect(await credentials.listByAppId(provider.id)).toHaveLength(0);
    expect(await credentials.listByAppId(peer.id)).toHaveLength(1);

    // AL-2.7 — every edge incident to the app is REMOVED (each aggregate is now empty),
    // while an edge between two surviving apps is untouched.
    expect(await downstream.getGraphEdge(provider.id, peer.id, "sync")).toBeUndefined();
    expect(await downstream.getGraphEdge(peer.id, provider.id, "sync")).toBeUndefined();
    expect(
      await downstream.getGraphEdge(consumer.id, provider.id, "adapter-dependency"),
    ).toBeUndefined();
    expect(
      await downstream.getGraphEdge(consumer.id, other.id, "adapter-dependency"),
    ).toBeDefined();

    // AL-2.7 / XI-2 — the caches of the torn-down endpoint and of every endpoint it backed.
    expect([...cacheDrops].sort()).toEqual(
      [ownEndpoint.id, soloEndpoint.id, sharedEndpoint.id].sort(),
    );

    // AL-2.8 — attributed to the operator, with the cascade summary, and every historical
    // audit row (the token issue above) retained.
    const rows = await auditFor(provider.id);
    expect(rows.map((row) => row.actor)).toEqual([OPERATOR, OPERATOR]);
    const deregistration = rows[1];
    expect(deregistration?.details).toContain("deregistered by operator");
    expect(deregistration?.details).toContain("credentialsDeleted=2");
    expect(deregistration?.details).not.toContain("https://");
    expect(deregistration?.details).not.toContain("provider-secret-value");
  });

  it("AL-3: re-registering the same system yields a NEW app that sees nothing of the prior one", async () => {
    const NAME = `AL-3 returning system ${randomUUID()}`;
    const BASE_URL = "https://al3-returning.example.test";
    const peer = await makeApp(`AL-3 peer ${randomUUID()}`);
    const peerSpec = await seedSpec(peer.id);

    // ── The FIRST registration, with real linked state, then deregistered. ──
    const first = await makeApp(NAME, BASE_URL);
    const firstSpec = await seedSpec(first.id);
    const firstMapping = await seedMapping({
      id: randomUUID(),
      sourceSpecId: firstSpec.id,
      targetSpecId: peerSpec.id,
      sourceAppId: first.id,
      targetAppId: peer.id,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    });
    const firstRuleId = randomUUID();
    await seedRule({
      id: firstRuleId,
      approvedMappingId: firstMapping.id,
      resourcePairRef: `${first.id}:issues|${peer.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
      cursor: "cursor-prior",
    });
    const firstNativeId = "issue-42";
    const firstLink = await seedLink({
      id: randomUUID(),
      appAId: first.id,
      appANativeId: firstNativeId,
      appBId: peer.id,
      appBNativeId: "JIRA-42",
      resourcePairRef: `${first.id}:issues|${peer.id}:issues`,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "both-native-id-queues" },
      createdAt: CREATED_AT,
      tombstonedAt: null,
    });
    await seedFieldState({
      id: randomUUID(),
      recordLinkId: firstLink.id,
      side: "A",
      fieldPath: "title",
      observedHash: "hash-prior",
      observedAt: CREATED_AT,
      observedChangeTimestamp: null,
      status: "active",
    });
    await credentialStore.store(first.id, {
      secret: { type: "apiKey", apiKey: "prior-registration-secret" },
    });

    await lifecycle.deregister(first.id, OPERATOR, NAME);

    // ── The SAME system registers again: a NEW `RegisteredApp`, same name + base URL. ──
    const second = await makeApp(NAME, BASE_URL);
    expect(second.id).not.toBe(first.id);

    // AL-3.1 — nothing of the prior registration belongs to, or is reachable from, the
    // new app id: no specs, no mappings, no rules, no links, no credentials.
    const specs = new ApiSpecRepository(db);
    expect(await specs.listByAppId(second.id)).toHaveLength(0);
    expect(await specs.findActiveByAppAndRole(second.id, "PROVIDER")).toBeUndefined();
    expect(await new ApprovedMappingRepository(db).listByAppId(second.id)).toHaveLength(0);
    expect(await new SyncRuleRepository(db).deleteByApp(second.id)).toHaveLength(0);
    expect(await new RecordLinkRepository(db).listIdsByApp(second.id)).toHaveLength(0);
    expect(await new CredentialRepository(db).listByAppId(second.id)).toHaveLength(0);

    // AL-3.1 — and the identity lookup the new app's pipeline would run finds NOTHING:
    // the canonical `resourcePairRef` embeds the app id, so the prior link's pair is not
    // even addressable from the new registration...
    const links = new RecordLinkRepository(db);
    const newPairRef = `${second.id}:issues|${peer.id}:issues`;
    expect(
      await links.findActiveByRecord(newPairRef, { appId: second.id, nativeId: firstNativeId }),
    ).toBeUndefined();
    expect(
      await links.findTombstonedByRecord(newPairRef, { appId: second.id, nativeId: firstNativeId }),
    ).toBeUndefined();
    // ...and even probing the PRIOR pair ref with the prior native id resolves nothing,
    // because the row is `archived` and the live lookup filters on `active`.
    expect(
      await links.findActiveByRecord(firstLink.resourcePairRef, {
        appId: first.id,
        nativeId: firstNativeId,
      }),
    ).toBeUndefined();

    // AL-3.2 — the new app starts from an empty slate, so its first approved mapping +
    // enabled rule performs a FRESH backfill: it inherits no rule, no cursor, and no
    // `backfillStatus` from the prior registration.
    expect(await new SyncRuleRepository(db).getById(firstRuleId)).toBeUndefined();

    // AL-3.3 — the prior rows are still there, archived, audit-only.
    expect((await specs.getById(firstSpec.id))?.status).toBe("archived");
    expect((await new ApprovedMappingRepository(db).getById(firstMapping.id))?.status).toBe(
      "archived",
    );
    expect((await linkRow(firstLink.id)).status).toBe("archived");
    expect((await new SyncFieldStateRepository(db).findByLink(firstLink.id))[0]?.status).toBe(
      "archived",
    );

    // AL-3.4 — the audit log retains the history, distinguishable by `RegisteredApp` id:
    // the deregistration belongs to the FIRST registration, never to the new one.
    expect(await auditFor(first.id)).toHaveLength(1);
    expect(await auditFor(second.id)).toHaveLength(0);
  });
});
