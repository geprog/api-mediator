import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DetectionJobRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  apiSpec,
  closeDb,
  createDb,
  mappingProposal,
  mappingDetectionJob,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  runMigrations,
  tx,
  type Database,
  type DbHandle,
  type DbTransaction,
} from "@mediator/db";
import type { ApiSpec, MappingProposal, RegisteredApp } from "@mediator/domain";
import { buildIr, computeContentHash } from "@mediator/ir";
import { FakeProvider, PROMPT_VERSION } from "@mediator/llm";
import {
  createDbPriorProposalSource,
  createDbProposalStore,
  createDbSpecSource,
  runScopedAdditiveAnalysis,
} from "@mediator/mapping-engine";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DetectionWorker } from "./modules/detection/worker.js";
import type { CredentialTxStore, TxStores } from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { providerSpecDocument } from "./testing/sample-specs.testkit.js";

/**
 * SL-3 — live-Postgres backend integration for the **record-job → worker → delta
 * proposal** path. An additive spec bump that adds a genuinely-new in-scope resource
 * group records a **scoped** `mapping_detection_job` in the ingest transaction (the
 * real repository + partial-unique idempotency), then the real `DetectionWorker`
 * claims it and runs the scoped analysis, persisting an ordinary (pending) delta
 * `MappingProposal` — the LLM is the deterministic `FakeProvider`, everything else is
 * real Postgres.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when `DATABASE_URL` is unresolvable. Run in isolation
 * (shared-DB integration suite is flaky across files).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");
const NOW = new Date("2026-07-21T12:00:00.000Z");

const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** The provider doc plus a whole **new** `labels` resource group → additive diff (SL-3.1). */
function providerSpecWithNewResourceGroup(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  doc.paths["/labels"] = {
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
  };
  doc.components.schemas["Label"] = {
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
    required: ["id"],
  };
  return doc;
}

/** A minimal second provider with a `tasks` resource group (the counterpart). */
function taskProviderDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Task Provider", version: "1.0.0" },
    paths: {
      "/tasks": {
        get: {
          operationId: "listTasks",
          tags: ["task"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Task" } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Task: {
          type: "object",
          properties: { id: { type: "integer" }, title: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };
}

// Scripted stage outputs for the `labels` new group ↔ `tasks`. The shortlist is keyed by
// the SOURCE summary only, so it is robust to any extra active counterpart the shared DB
// might hold: `labels` only ever pairs with `tasks`, which non-task specs lack.
const labelsShortlist = {
  candidatePairs: [
    {
      sourceResource: "labels",
      targetResource: "tasks",
      confidence: 0.5,
      rationale: "Both are simple id/name collections.",
    },
  ],
};
const peerDetail = (sourceOperationId: string, targetOperationId: string): unknown => ({
  variant: "peer-peer",
  operationMappings: [
    {
      sourceOperationId,
      targetOperationId,
      confidence: 0.5,
      rationale: "Both list a collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "id",
      targetField: "id",
      transform: "rename",
      transformDetail: "",
      identityCandidate: false,
      confidence: 0.6,
      rationale: "Same id field.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
});

suite("SL-3 scoped-delta analysis: record job → worker → proposal (requires Postgres)", () => {
  let db: Database;
  const registry = new SpecRegistry();
  const appIds: string[] = [];
  const specIds: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    if (specIds.length > 0) {
      // Proposals reference specs (cascades to items); jobs and bindings reference specs.
      const proposals = await db
        .select({ id: mappingProposal.id })
        .from(mappingProposal)
        .where(inArray(mappingProposal.sourceSpecId, specIds));
      const proposalIds = proposals.map((row) => row.id);
      if (proposalIds.length > 0) {
        await db.delete(mappingProposal).where(inArray(mappingProposal.id, proposalIds));
      }
      await db.delete(mappingDetectionJob).where(inArray(mappingDetectionJob.apiSpecId, specIds));
      await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, specIds));
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
      baseUrl: "https://sl3.example.test",
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

  async function seedSpec(appId: string, document: Record<string, unknown>): Promise<ApiSpec> {
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

  /** A version-advance `TxStores` with the REAL detection-job repo (records the scoped job). */
  function txStoresOn(handle: DbHandle): TxStores {
    return {
      registeredApps: new RegisteredAppRepository(handle),
      apiSpecs: new ApiSpecRepository(handle),
      resourceBindings: new ResourceBindingRepository(handle),
      credentialStore: unusedCredentials,
      approvedMappings: new ApprovedMappingRepository(handle),
      audit: new AuditLogRepository(handle),
      detectionJobs: new DetectionJobRepository(handle),
      // SL-4 breaking-reaction ports — this SL-3 additive spec never reaches the breaking branch.
      mappingArtifacts: {
        listFieldMappings: (): Promise<never[]> => Promise.resolve([]),
        listOperationMappings: (): Promise<never[]> => Promise.resolve([]),
      },
      downstreamArtifacts: {
        listAdapterBindingsByMapping: (): Promise<never[]> => Promise.resolve([]),
        listSyncRulesByMapping: (): Promise<never[]> => Promise.resolve([]),
      },
      graph: {
        recomputeSyncEdge: (): Promise<void> => Promise.resolve(),
        recomputeAdapterEdge: (): Promise<void> => Promise.resolve(),
      },
      cacheInvalidator: { invalidateEndpoint: (): void => {} },
      // SL-5 operational-ref re-validation ports — this SL-3 additive spec never reaches the
      // breaking branch, so `scopeLifecycle` is never invoked (a rejecting guard proves it).
      syncRules: { clearPollOperationRef: (): Promise<void> => Promise.resolve() },
      scopeCorrespondences: { listByResourceSide: (): Promise<never[]> => Promise.resolve([]) },
      scopeLifecycle: {
        revalidateSpecBindings: () => Promise.reject(new Error("unused on the additive path")),
        revalidateCorrespondence: () => Promise.reject(new Error("unused on the additive path")),
      },
      emit: () => Promise.reject(new Error("advance must not emit")),
    };
  }

  it("records a scoped job in the ingest tx (idempotently), then the worker persists a delta proposal", async () => {
    const appA = providerApp("SL-3 A");
    const appB = providerApp("SL-3 B");
    await new RegisteredAppRepository(db).create(appA);
    await new RegisteredAppRepository(db).create(appB);

    const aV1 = await seedSpec(appA.id, providerSpecDocument());
    const bSpec = await seedSpec(appB.id, taskProviderDocument());

    // Advance A additively (adds the whole `labels` group) — records the scoped job in-tx.
    const outcome = await tx(db, (handle) =>
      registry.ingestNewVersion(
        appA.id,
        providerSpecWithNewResourceGroup(),
        "PROVIDER",
        txStoresOn(handle),
      ),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    const aV2 = outcome.newSpec;
    specIds.push(aV2.id);
    expect(outcome.diff.classification).toBe("additive");

    // A scoped, pending job exists for v2 with the new-group scope.
    const pending = await new DetectionJobRepository(db).listByStatus("pending");
    const v2Jobs = pending.filter((job) => job.apiSpecId === aV2.id);
    expect(v2Jobs).toHaveLength(1);
    expect(v2Jobs[0]?.scope).toEqual({
      kind: "additive-delta",
      supersededSpecId: aV1.id,
      newResourceGroups: ["labels"],
      changedResources: [],
    });

    // SL-3.5 idempotency: a redelivered enqueue collapses to the one un-finished job.
    await tx(db, (handle) =>
      new DetectionJobRepository(handle).enqueueScoped(aV2.id, {
        kind: "additive-delta",
        supersededSpecId: aV1.id,
        newResourceGroups: ["labels"],
        changedResources: [],
      }),
    );
    const stillPending = (await new DetectionJobRepository(db).listByStatus("pending")).filter(
      (job) => job.apiSpecId === aV2.id,
    );
    expect(stillPending).toHaveLength(1);

    // Wire the real worker with a FakeProvider (no live LLM) and run it once.
    const provider = new FakeProvider({
      shortlistKey: (ctx) => ctx.sourceSpecSummaryIR.map((r) => r.resourceRef).join(","),
      shortlist: { labels: [labelsShortlist] },
      detail: {
        "labels=>tasks@peer-peer": [peerDetail("listLabels", "listTasks")],
        "tasks=>labels@peer-peer": [peerDetail("listTasks", "listLabels")],
      },
    });
    const runDetectionDeps = {
      provider,
      maxRetries: 0,
      promptVersion: PROMPT_VERSION,
      specSource: createDbSpecSource(db),
      proposalStore: createDbProposalStore(db),
    };
    const worker = new DetectionWorker<DbTransaction>({
      scope: db,
      jobs: (handle) => new DetectionJobRepository(handle),
      runDetection: () => Promise.reject(new Error("full detection not expected for a scoped job")),
      runScopedDetection: async (job) => {
        if (job.scope === null) throw new Error("scoped job carries no scope");
        await runScopedAdditiveAnalysis(
          {
            newSpecId: job.apiSpecId,
            supersededSpecId: job.scope.supersededSpecId,
            scope: {
              newResourceGroups: job.scope.newResourceGroups,
              changedResources: job.scope.changedResources,
            },
          },
          { ...runDetectionDeps, priorProposals: createDbPriorProposalSource(db) },
        );
      },
      clock: () => NOW,
    });

    const result = await worker.runOnce();
    expect(result).toStrictEqual({ claimed: true, outcome: "completed" });

    // The job is completed; a pending job no longer exists for v2.
    const afterRun = (await new DetectionJobRepository(db).listByStatus("pending")).filter(
      (job) => job.apiSpecId === aV2.id,
    );
    expect(afterRun).toHaveLength(0);

    // The delta proposals are ordinary, PENDING (nothing auto-approved), and cover only the
    // new group's `labels`↔`tasks` pair. Peer-peer → both directions.
    const proposalRepo = new MappingProposalRepository(db);
    const forward = await proposalRepo.listBySourceSpecId(aV2.id);
    const reverse = (await proposalRepo.listBySourceSpecId(bSpec.id)).filter(
      (proposal: MappingProposal) => proposal.targetSpecId === aV2.id,
    );
    expect(forward).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    for (const proposal of [...forward, ...reverse]) {
      expect(proposal.status).toBe("pending");
      const pairs = proposal.shortlistResult?.candidatePairs ?? [];
      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.sourceResource).toBe("labels");
      expect(pairs[0]?.targetResource).toBe("tasks");
      const items = await proposalRepo.listItems(proposal.id);
      expect(items.length).toBeGreaterThan(0);
    }
  });
});
