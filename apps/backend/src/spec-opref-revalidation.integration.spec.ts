import { randomUUID } from "node:crypto";

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
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  scopeCorrespondence,
  scopeLink,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  RecordLink,
  RegisteredApp,
  ResourceBinding,
  ScopeCorrespondence,
  ScopeLink,
  SyncRule,
} from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { decidePoll } from "@mediator/sync-engine";
import { inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GraphProjection } from "./modules/graph/index.js";
import { dbSyncStateArchival } from "./modules/persistence.js";
import type {
  CredentialTxStore,
  EndpointCacheInvalidator,
  TxStores,
} from "./modules/persistence.js";
import { RepoPollPlanResolver } from "./modules/sync/poll-plan-resolver.js";
import { ScopeLifecycleService } from "./modules/sync/scope-lifecycle.js";
import { SpecRegistry } from "./modules/spec-registry.js";

/**
 * **SL-5 — live-Postgres backend integration for the breaking-change operational-ref
 * re-validation** wired into {@link SpecRegistry.ingestNewVersion} ALONGSIDE SL-4's
 * mark-stale (same breaking diff, same transaction). It proves, against a real database,
 * exactly what the pure/fake layers cannot:
 *
 *  - **SL-5.1** the changed spec's `ResourceBinding`s carry forward **re-validated**: a
 *    broken bound ref (the collection read) is RETAINED but returned to **unconfirmed**
 *    (vs the additive path's drop), while an unaffected ref (the native id) stays confirmed
 *    — even when no mapping content was affected;
 *  - **SL-5.2** a `SyncRule.pollOperationRef` pinned to a now-gone source operation is
 *    returned to unconfirmed, and the rule **pauses** (asserted via the real
 *    {@link RepoPollPlanResolver} → `unconfirmed-poll-operation`); re-confirming onto a
 *    *different* operation clears the delta cursor and rebuilds the snapshot
 *    ({@link SyncRuleRepository.reconfirmPollOperation});
 *  - **SL-5.3** a scoped pair's `ScopeCorrespondence` returns to unconfirmed and its
 *    `ScopeLink`s are archived (never deleted) — only `identity-match` on a scope-identity-key
 *    break (a `constant`/`manual` link preserved), all on a container-gone break;
 *  - **SL-4 + SL-5 together (SL-5.6)** the one breaking branch marks a mapping stale AND
 *    returns its rule's operational refs to unconfirmed, consistently.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable. Teardown deletes `graph_edge`, `scope_link`,
 * `record_link` (all FK `registered_app` with no cascade) BEFORE `registered_app`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const CONFIRMED = { confirmedBy: "op@example.test", confirmedAt: CREATED_AT };

/** Storing credentials / emitting events is never part of a version advance (SL-1/SL-4/SL-5). */
const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** A two-resource provider doc: `issues` (id, title:<t>, updated) + `labels` (id, name). */
function providerDoc(
  titleType: "string" | "integer",
  listIssuesOp: string,
  listLabelsOp: string,
): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "SL-5 Provider", version: "1.0.0" },
    paths: {
      "/issues": listOp(listIssuesOp, "Issue"),
      "/issues/{id}": itemOp("getIssue", "Issue"),
      "/labels": listOp(listLabelsOp, "Label"),
      "/labels/{id}": itemOp("getLabel", "Label"),
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

function listOp(operationId: string, schema: string): Record<string, unknown> {
  return {
    get: {
      operationId,
      tags: [schema.toLowerCase()],
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: { type: "array", items: { $ref: `#/components/schemas/${schema}` } },
            },
          },
        },
      },
    },
  };
}

function itemOp(operationId: string, schema: string): Record<string, unknown> {
  return {
    get: {
      operationId,
      tags: [schema.toLowerCase()],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      responses: {
        "200": {
          description: "ok",
          content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
        },
      },
    },
  };
}

suite("SL-5 breaking operational-ref re-validation (requires Postgres)", () => {
  let db: Database;
  let graphProjection: GraphProjection;
  const registry = new SpecRegistry();
  const appIds: string[] = [];
  const mappingIds: string[] = [];
  const correspondenceIds: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    graphProjection = new GraphProjection({ db });
  });

  afterAll(async () => {
    // FK-safe teardown: rows FK-ing `registered_app` with no cascade go BEFORE the apps.
    if (correspondenceIds.length > 0) {
      await db.delete(scopeLink).where(inArray(scopeLink.scopeCorrespondenceId, correspondenceIds));
      await db
        .delete(scopeCorrespondence)
        .where(inArray(scopeCorrespondence.id, correspondenceIds));
    }
    if (appIds.length > 0) {
      await db
        .delete(recordLink)
        .where(or(inArray(recordLink.appAId, appIds), inArray(recordLink.appBId, appIds)));
      await db
        .delete(graphEdge)
        .where(
          or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)),
        );
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
      baseUrl: "https://sl5.example.test",
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
    role: "PROVIDER" | "CONSUMER" = "PROVIDER",
  ): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role,
      rawDocument: document,
      parsedIR: await buildIr(document),
      analysisExclusions: [],
      version: 1,
      contentHash: computeContentHash(document),
      status: "active",
      createdAt: CREATED_AT,
    };
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  function txStoresOn(handle: DbHandle, cacheDrops: string[]): TxStores {
    const cacheInvalidator: EndpointCacheInvalidator = {
      invalidateEndpoint: (endpointId) => cacheDrops.push(endpointId),
    };
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      detectionJobs: {
        enqueueScoped: (): Promise<boolean> => Promise.resolve(true),
        lockUnfinishedJob: (): Promise<undefined> => Promise.resolve(undefined),
        updateScope: (): Promise<void> => Promise.resolve(),
      },
      mappingArtifacts: new MappingArtifactsRepository(handle),
      downstreamArtifacts: new DownstreamArtifactRepository(handle),
      graph: {
        recomputeSyncEdge: (sourceAppId, targetAppId) =>
          graphProjection.recomputeSyncEdgeWithin(handle, sourceAppId, targetAppId),
        recomputeAdapterEdge: (consumerAppId, backendAppId) =>
          graphProjection.recomputeAdapterEdgeWithin(handle, consumerAppId, backendAppId),
      },
      cacheInvalidator,
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

  /** A confirmed peer-peer source binding: native id `id` + the collection read `listOp`. */
  function sourceBinding(specId: string, resourceRef: string, listOp: string): ResourceBinding {
    return {
      id: randomUUID(),
      apiSpecId: specId,
      resourceRef,
      nativeIdRef: { value: { kind: "field", path: "id" }, ...CONFIRMED },
      collectionReadRef: { value: { kind: "operation", operationId: listOp }, ...CONFIRMED },
      scopePathBindings: [],
    };
  }

  // ── SL-5.1/5.2/5.6 — bindings + pollOperationRef re-validation, together with SL-4 ────

  it("re-validates bindings (retain-unconfirmed) + pollOperationRef, pausing the rule, while SL-4 stales the referencing mapping", async () => {
    const provider = makeApp("SL-5 provider");
    const peerB = makeApp("SL-5 peer-B");
    const peerC = makeApp("SL-5 peer-C");
    const appRepo = new RegisteredAppRepository(db);
    await appRepo.create(provider);
    await appRepo.create(peerB);
    await appRepo.create(peerC);

    // Two distinct targets: an `active` mapping is UNIQUE per (source_spec, target_spec), so
    // the issues and labels mappings must point at different peers.
    const aV1 = await seedSpec(provider.id, providerDoc("string", "listIssues", "listLabels"));
    const bSpec = await seedSpec(
      peerB.id,
      providerDoc("string", "peerListIssues", "peerListLabels"),
    );
    const cSpec = await seedSpec(
      peerC.id,
      providerDoc("string", "peerListIssues", "peerListLabels"),
    );

    // Confirmed source bindings for the changed provider (issues + labels) + peer (target)
    // bindings so the poll-plan resolver's target-side lookup resolves.
    const bindingRepo = new ResourceBindingRepository(db);
    await bindingRepo.createMany([
      sourceBinding(aV1.id, "issues", "listIssues"),
      sourceBinding(aV1.id, "labels", "listLabels"),
      sourceBinding(bSpec.id, "issues", "peerListIssues"),
      sourceBinding(cSpec.id, "labels", "peerListLabels"),
    ]);

    const mappings = new ApprovedMappingRepository(db);
    const artifacts = new MappingArtifactsRepository(db);
    const downstream = new DownstreamArtifactRepository(db);

    // M_issues references the changed `issues.title` → SL-4 stales it.
    const mIssues: ApprovedMapping = peerMapping(aV1.id, bSpec.id, provider.id, peerB.id);
    mappingIds.push(mIssues.id);
    await mappings.insert(mIssues);
    await artifacts.replaceChildren(mIssues.id, {
      fieldMappings: [
        identityField(mIssues.id, "issues/id"),
        renameField(mIssues.id, "issues/title"),
      ],
      operationMappings: [],
      parameterMappings: [],
    });
    const rIssues: SyncRule = pollRule(
      mIssues.id,
      `${provider.id}:issues|${peerB.id}:issues`,
      "listIssues",
    );
    await downstream.insertSyncRuleIfAbsent(rIssues);

    // M_labels references only the unchanged `labels` → re-pinned active; its rule pauses via SL-5 alone.
    const mLabels: ApprovedMapping = peerMapping(aV1.id, cSpec.id, provider.id, peerC.id);
    mappingIds.push(mLabels.id);
    await mappings.insert(mLabels);
    await artifacts.replaceChildren(mLabels.id, {
      fieldMappings: [
        identityField(mLabels.id, "labels/id"),
        renameField(mLabels.id, "labels/name"),
      ],
      operationMappings: [],
      parameterMappings: [],
    });
    const rLabels: SyncRule = pollRule(
      mLabels.id,
      `${provider.id}:labels|${peerC.id}:labels`,
      "listLabels",
    );
    await downstream.insertSyncRuleIfAbsent(rLabels);

    // ── Breaking advance: retype issues.title + rename BOTH list ops. ──
    const cacheDrops: string[] = [];
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        provider.id,
        providerDoc("integer", "issuesIndex", "labelsIndex"),
        "PROVIDER",
        txStoresOn(handle, cacheDrops),
      ),
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    const aV2Id = outcome.newSpec.id;

    // ── SL-4 — the issues mapping is stale + pinned to v1; the labels mapping re-pins to v2. ──
    expect((await mappings.getById(mIssues.id))?.status).toBe("stale");
    expect((await mappings.getById(mIssues.id))?.sourceSpecId).toBe(aV1.id);
    expect((await mappings.getById(mLabels.id))?.status).toBe("active");
    expect((await mappings.getById(mLabels.id))?.sourceSpecId).toBe(aV2Id);

    // ── SL-5.1 — v2 bindings: the renamed-away collection read is RETAINED but unconfirmed;
    //    the surviving native id carries forward confirmed (even with no mapping change on labels). ──
    const v2Bindings = await bindingRepo.listByApiSpecId(aV2Id);
    const v2Labels = v2Bindings.find((b) => b.resourceRef === "labels");
    expect(v2Labels?.nativeIdRef?.confirmedBy).toBe("op@example.test"); // `id` survives → confirmed
    expect(v2Labels?.collectionReadRef).toBeDefined(); // RETAINED, not dropped
    expect(v2Labels?.collectionReadRef?.confirmedBy).toBeNull(); // returned to unconfirmed

    // ── SL-5.2 — both rules' pollOperationRef returned to unconfirmed (cleared). ──
    const ruleRepo = new SyncRuleRepository(db);
    expect((await ruleRepo.getById(rIssues.id))?.pollOperationRef).toBeUndefined();
    expect((await ruleRepo.getById(rLabels.id))?.pollOperationRef).toBeUndefined();
    // SL-5.4 — no rule status written; cursor/snapshot untouched by the break.
    expect((await ruleRepo.getById(rLabels.id))?.status).toBe("enabled");
    expect((await ruleRepo.getById(rLabels.id))?.cursor).toBe("cursor-labels");
    expect((await ruleRepo.getById(rLabels.id))?.lastSnapshotRef).toBe(rLabels.lastSnapshotRef);

    // ── SL-4 pause — the stale mapping's rule is HELD by the real Scheduler gate. ──
    const candidates = await ruleRepo.listPollCandidates();
    const now = new Date();
    const issuesCandidate = candidates.find((c) => c.rule.id === rIssues.id);
    const labelsCandidate = candidates.find((c) => c.rule.id === rLabels.id);
    if (issuesCandidate === undefined || labelsCandidate === undefined) {
      throw new Error("expected both rules in the candidate set");
    }
    expect(decidePoll(issuesCandidate, now)).toEqual({ kind: "hold", reason: "mapping-stale" });
    // The re-pinned (active) labels rule is NOT held for mapping status by the Scheduler...
    expect(decidePoll(labelsCandidate, now).kind).toBe("poll");

    // ── SL-5 pause — ...but the runtime resolver REFUSES it: its poll operation is unconfirmed. ──
    const resolver = new RepoPollPlanResolver(
      {
        syncRules: ruleRepo,
        approvedMappings: mappings,
        mappingArtifacts: artifacts,
        apiSpecs: new ApiSpecRepository(db),
        resourceBindings: bindingRepo,
        registeredApps: appRepo,
      },
      {
        scopeCorrespondences: new ScopeCorrespondenceRepository(db),
        scopeLinks: new ScopeLinkRepository(db),
      },
    );
    expect(await resolver.resolve(rLabels.id)).toEqual({
      pollable: false,
      reason: "unconfirmed-poll-operation",
    });

    // ── SL-5.2 (re-confirm) — re-confirming onto a DIFFERENT op clears the cursor + snapshot. ──
    const reconfirm = await ruleRepo.reconfirmPollOperation(rLabels.id, "labelsIndex");
    expect(reconfirm.reset).toBe(true);
    const afterReconfirm = await ruleRepo.getById(rLabels.id);
    expect(afterReconfirm?.pollOperationRef).toBe("labelsIndex");
    expect(afterReconfirm?.cursor).toBeUndefined(); // cursor cleared
    expect(afterReconfirm?.lastSnapshotRef).toBeUndefined(); // snapshot rebuilt (reset)
  });

  // ── SL-5.2 — the re-confirm reset is compare-to-current: SAME op preserves cursor/snapshot ──

  it("reconfirmPollOperation resets cursor/snapshot ONLY when the operation changes", async () => {
    const app = makeApp("SL-5 reconfirm");
    const peer = makeApp("SL-5 reconfirm peer");
    await new RegisteredAppRepository(db).create(app);
    await new RegisteredAppRepository(db).create(peer);
    const spec = await seedSpec(app.id, providerDoc("string", "listIssues", "listLabels"));

    const mapping = peerMapping(spec.id, spec.id, app.id, peer.id);
    mappingIds.push(mapping.id);
    await new ApprovedMappingRepository(db).insert(mapping);
    const snapshotRef = randomUUID();
    const rule: SyncRule = {
      id: randomUUID(),
      approvedMappingId: mapping.id,
      resourcePairRef: `${app.id}:issues|${peer.id}:issues`,
      status: "enabled",
      backfillStatus: "completed",
      pollOperationRef: "listIssues",
      cursor: "cursor-keep",
      lastSnapshotRef: snapshotRef,
    };
    await new DownstreamArtifactRepository(db).insertSyncRuleIfAbsent(rule);
    const ruleRepo = new SyncRuleRepository(db);

    // Re-confirm onto the SAME operation → no reset, cursor/snapshot preserved (SL-8.2 "still valid").
    const same = await ruleRepo.reconfirmPollOperation(rule.id, "listIssues");
    expect(same.reset).toBe(false);
    expect((await ruleRepo.getById(rule.id))?.cursor).toBe("cursor-keep");
    expect((await ruleRepo.getById(rule.id))?.lastSnapshotRef).toBe(snapshotRef);

    // Re-confirm onto a DIFFERENT operation → reset, cursor cleared + snapshot rebuilt.
    const changed = await ruleRepo.reconfirmPollOperation(rule.id, "issuesIndex");
    expect(changed.reset).toBe(true);
    expect((await ruleRepo.getById(rule.id))?.pollOperationRef).toBe("issuesIndex");
    expect((await ruleRepo.getById(rule.id))?.cursor).toBeUndefined();
    expect((await ruleRepo.getById(rule.id))?.lastSnapshotRef).toBeUndefined();
  });

  // ── SL-5.3 — scoped ScopeCorrespondence / ScopeLink re-validation through the breaking branch ──

  it("scope-identity-key break: correspondence unconfirmed + ONLY identity-match links archived (constant/manual preserved, archived not deleted)", async () => {
    const landscape = await seedScopedLandscape();

    // Advance the TARGET-container side (Vikunja), removing `projects.title` — the scope
    // identity key's `targetFieldPath`. That is a scope-identity-key break, not a container-gone.
    const cacheDrops: string[] = [];
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        landscape.vikunjaAppId,
        vikunjaDoc(false),
        "PROVIDER",
        txStoresOn(handle, cacheDrops),
      ),
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");

    const corrRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);

    // Correspondence returned to unconfirmed.
    const persisted = await corrRepo.getByResourcePair(landscape.pair);
    expect(persisted?.confirmedBy).toBeNull();

    // ONLY the identity-match link archived; constant/manual preserved (operator-pinned).
    const links = await linkRepo.listByCorrespondence(landscape.correspondenceId);
    const byId = new Map(links.map((l) => [l.id, l.status]));
    expect(byId.get(landscape.identityMatchLinkId)).toBe("archived");
    expect(byId.get(landscape.constantLinkId)).toBe("active");
    expect(byId.get(landscape.manualLinkId)).toBe("active");

    // Archived, NEVER deleted — the RecordLink.scopeRef still resolves its frozen link.
    const resolved = await linkRepo.getById(landscape.identityMatchLinkId);
    expect(resolved?.status).toBe("archived");
    const storedRecord = await new RecordLinkRepository(db).getById(landscape.recordLinkId);
    expect(storedRecord?.scopeRef).toStrictEqual({
      kind: "scope-link",
      scopeLinkId: landscape.identityMatchLinkId,
    });
  });

  it("container-gone break: correspondence unconfirmed + ALL links archived", async () => {
    const landscape = await seedScopedLandscape();

    // Advance the SOURCE-container side (Gitea), removing the `/repos` container entirely.
    const cacheDrops: string[] = [];
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        landscape.giteaAppId,
        giteaDoc(false),
        "PROVIDER",
        txStoresOn(handle, cacheDrops),
      ),
    );
    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");

    const corrRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);

    expect((await corrRepo.getByResourcePair(landscape.pair))?.confirmedBy).toBeNull();
    // A gone container archives EVERY link regardless of how it was established.
    const links = await linkRepo.listByCorrespondence(landscape.correspondenceId);
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.status === "archived")).toBe(true);
  });

  // ── scoped-landscape fixtures ────────────────────────────────────────────────

  interface ScopedLandscape {
    readonly giteaAppId: string;
    readonly vikunjaAppId: string;
    readonly pair: string;
    readonly correspondenceId: string;
    readonly identityMatchLinkId: string;
    readonly constantLinkId: string;
    readonly manualLinkId: string;
    readonly recordLinkId: string;
  }

  /**
   * A Gitea↔Vikunja scoped pair: Gitea `issues` records under a `repos` container (source),
   * Vikunja `tasks` records under a `projects` container (target); one confirmed
   * `ScopeCorrespondence` with an `identity-match`, a `constant`, and a `manual` `ScopeLink`,
   * plus a `RecordLink` pointing at the identity-match link.
   */
  async function seedScopedLandscape(): Promise<ScopedLandscape> {
    const gitea = makeApp("SL-5 Gitea");
    const vikunja = makeApp("SL-5 Vikunja");
    await new RegisteredAppRepository(db).create(gitea);
    await new RegisteredAppRepository(db).create(vikunja);

    const giteaSpec = await seedSpec(gitea.id, giteaDoc(true));
    await seedSpec(vikunja.id, vikunjaDoc(true));

    // Gitea's `issues` record binding captures its container scope (`repository.owner`).
    await new ResourceBindingRepository(db).createMany([
      {
        id: randomUUID(),
        apiSpecId: giteaSpec.id,
        resourceRef: "issues",
        nativeIdRef: { value: { kind: "field", path: "id" }, ...CONFIRMED },
        sourceScopeRef: {
          components: [{ key: "owner", fieldPath: "repository.owner" }],
          ...CONFIRMED,
        },
        scopePathBindings: [],
      },
    ]);

    const pair = `${gitea.id}:issues|${vikunja.id}:tasks`;
    const correspondenceId = randomUUID();
    const correspondence: ScopeCorrespondence = {
      id: correspondenceId,
      resourcePairRef: pair,
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "title" }],
      targetContainerRef: { appId: vikunja.id, resourceRef: "projects" },
      sourceContainerRef: { appId: gitea.id, resourceRef: "repos" },
      ...CONFIRMED,
    };
    correspondenceIds.push(correspondenceId);
    const corrRepo = new ScopeCorrespondenceRepository(db);
    await corrRepo.create(correspondence);

    const linkRepo = new ScopeLinkRepository(db);
    const mkLink = (establishedBy: ScopeLink["establishedBy"], key: string): ScopeLink => ({
      id: randomUUID(),
      scopeCorrespondenceId: correspondenceId,
      appAId: gitea.id,
      appAScopeKey: { owner: "alice", name: "phoenix" },
      appBId: vikunja.id,
      appBScopeKey: { id: key },
      resourcePairRef: pair,
      establishedBy,
      status: "active",
      createdAt: CREATED_AT,
    });
    const identityMatch = mkLink("identity-match", "42");
    const constant = mkLink("constant", "43");
    const manual = mkLink("manual", "44");
    await linkRepo.create(identityMatch);
    await linkRepo.create(constant);
    await linkRepo.create(manual);

    const record: RecordLink = {
      id: randomUUID(),
      appAId: gitea.id,
      appANativeId: "gitea-1",
      appBId: vikunja.id,
      appBNativeId: "vikunja-1",
      resourcePairRef: pair,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "identity-value", value: "issue-1" },
      scopeRef: { kind: "scope-link", scopeLinkId: identityMatch.id },
      createdAt: CREATED_AT,
      tombstonedAt: null,
    };
    await new RecordLinkRepository(db).insert(record);

    return {
      giteaAppId: gitea.id,
      vikunjaAppId: vikunja.id,
      pair,
      correspondenceId,
      identityMatchLinkId: identityMatch.id,
      constantLinkId: constant.id,
      manualLinkId: manual.id,
      recordLinkId: record.id,
    };
  }

  // ── shared builders ──────────────────────────────────────────────────────────

  function peerMapping(
    sourceSpecId: string,
    targetSpecId: string,
    sourceAppId: string,
    targetAppId: string,
  ): ApprovedMapping {
    return {
      id: randomUUID(),
      sourceSpecId,
      targetSpecId,
      sourceAppId,
      targetAppId,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: CREATED_AT,
      status: "active",
    };
  }

  function identityField(mappingId: string, path: string): FieldMapping {
    return {
      id: randomUUID(),
      mappingId,
      sourcePath: path,
      targetPath: path,
      transform: "rename",
      isIdentityKey: true,
    };
  }

  function renameField(mappingId: string, path: string): FieldMapping {
    return { id: randomUUID(), mappingId, sourcePath: path, targetPath: path, transform: "rename" };
  }

  function pollRule(
    mappingId: string,
    resourcePairRef: string,
    pollOperationRef: string,
  ): SyncRule {
    const label = pollOperationRef.toLowerCase().includes("label") ? "labels" : "issues";
    return {
      id: randomUUID(),
      approvedMappingId: mappingId,
      resourcePairRef,
      status: "enabled",
      backfillStatus: "completed",
      pollOperationRef,
      cursor: `cursor-${label}`,
      // `last_snapshot_ref` is a `poll_snapshot` row id (a uuid column), not free text.
      lastSnapshotRef: randomUUID(),
    };
  }
});

// ── scoped documents (built via buildIr so representation fields resolve) ────────

/** Gitea: `issues` records reached under `/repos/{owner}/{repo}` + a `repos` container. */
function giteaDoc(withRepos: boolean): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    "/repos/{owner}/{repo}/issues": {
      get: {
        operationId: "listIssues",
        tags: ["issue"],
        parameters: [scopeParam("owner"), scopeParam("repo")],
        responses: arrayResponse("Issue"),
      },
    },
  };
  if (withRepos) {
    paths["/repos"] = {
      get: { operationId: "listRepos", tags: ["repo"], responses: arrayResponse("Repo") },
    };
  }
  return {
    openapi: "3.0.0",
    info: { title: "SL-5 Gitea", version: "1.0.0" },
    paths,
    components: {
      schemas: {
        Issue: {
          type: "object",
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            repository: { $ref: "#/components/schemas/RepoRef" },
          },
          required: ["id"],
        },
        RepoRef: {
          type: "object",
          properties: { owner: { type: "string" }, name: { type: "string" } },
        },
        Repo: {
          type: "object",
          properties: { id: { type: "integer" }, full_name: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };
}

/** Vikunja: `tasks` records + a `projects` container; `withTitle` toggles the identity field. */
function vikunjaDoc(withTitle: boolean): Record<string, unknown> {
  const projectProps: Record<string, unknown> = withTitle
    ? { id: { type: "integer" }, title: { type: "string" } }
    : { id: { type: "integer" } };
  return {
    openapi: "3.0.0",
    info: { title: "SL-5 Vikunja", version: "1.0.0" },
    paths: {
      "/tasks": {
        get: { operationId: "listTasks", tags: ["task"], responses: arrayResponse("Task") },
      },
      "/projects": {
        get: {
          operationId: "listProjects",
          tags: ["project"],
          responses: arrayResponse("Project"),
        },
      },
    },
    components: {
      schemas: {
        Task: {
          type: "object",
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            project_id: { type: "integer" },
          },
          required: ["id"],
        },
        Project: { type: "object", properties: projectProps, required: ["id"] },
      },
    },
  };
}

function scopeParam(name: string): Record<string, unknown> {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

function arrayResponse(schema: string): Record<string, unknown> {
  return {
    "200": {
      description: "ok",
      content: {
        "application/json": {
          schema: { type: "array", items: { $ref: `#/components/schemas/${schema}` } },
        },
      },
    },
  };
}
