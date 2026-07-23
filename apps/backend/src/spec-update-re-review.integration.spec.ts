import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DetectionJobRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  eventOutbox,
  mappingDetectionJob,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  runMigrations,
  tx,
  type Database,
  type DbHandle,
  type DbTransaction,
} from "@mediator/db";
import type { ApiSpec, ApprovedMapping, RegisteredApp } from "@mediator/domain";
import { PostgresEventBus } from "@mediator/event-bus";
import { buildIr, computeContentHash } from "@mediator/ir";
import { FakeProvider, PROMPT_VERSION } from "@mediator/llm";
import {
  createDbProposalStore,
  createDbSpecSource,
  createDbStaleMappingSource,
  runScopedReReviewAnalysis,
} from "@mediator/mapping-engine";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApprovalService } from "./modules/approval/approval-service.js";
import { DbApprovalUnitOfWork } from "./modules/approval/persistence.js";
import { DetectionWorker } from "./modules/detection/worker.js";
import type { CredentialTxStore, TxStores } from "./modules/persistence.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import type { SpecScopeRevalidationResult } from "./modules/sync/scope-lifecycle.js";
import { providerSpecDocument } from "./testing/sample-specs.testkit.js";

/**
 * SL-6 — live-Postgres backend integration for the **breaking change → stale mapping →
 * re-review job → worker → successor proposal → approve → successor mapping** path. A
 * breaking spec bump (a `title` retype) stales the mapping that references it and records a
 * `re-review` `mapping_detection_job` in the advance transaction; the real
 * {@link DetectionWorker} then claims it and runs the detail-only scoped re-analysis (LLM =
 * the deterministic `FakeProvider`), persisting an ordinary `pending` successor proposal
 * tagged `reReviewOf`; approving it through the real {@link ApprovalService} yields the
 * successor `ApprovedMapping` — a new row pinned to the new version, linked to the stale
 * predecessor for SL-7 to adopt. Everything but the LLM is real Postgres.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when `DATABASE_URL` is unresolvable. Run in isolation (the
 * shared-DB integration suite is flaky across files).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const NOW = new Date("2026-07-23T12:00:00.000Z");
const ACTOR = "operator@example.test";

const unusedCredentials: CredentialTxStore = {
  store: () => Promise.reject(new Error("unused")),
};

/** The provider doc with `Issue.title` retyped string → integer: a breaking `issues` change. */
function providerSpecWithRetypedTitle(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    components: { schemas: { Issue: { properties: { title: { type: string } } } } };
  };
  doc.components.schemas.Issue.properties.title.type = "integer";
  return doc;
}

/** A minimal second provider with a `tasks` resource group (the unchanged counterpart). */
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

/** The scripted detail output for the established `issues ↔ tasks` re-review pair. */
const issuesToTasksDetail = {
  variant: "peer-peer",
  operationMappings: [
    {
      sourceOperationId: "listIssues",
      targetOperationId: "listTasks",
      confidence: 0.9,
      rationale: "Both list a collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "title",
      targetField: "title",
      transform: "rename",
      transformDetail: "",
      identityCandidate: false,
      confidence: 0.9,
      rationale: "Same title field.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
};

suite(
  "SL-6 scoped re-review: stale → job → worker → successor proposal (requires Postgres)",
  () => {
    let db: Database;
    const registry = new SpecRegistry();
    const appIds: string[] = [];
    const specIds: string[] = [];
    const mappingIds: string[] = [];
    const proposalIds: string[] = [];

    beforeAll(async () => {
      db = createDb(resolveDatabaseUrl(process.env));
      await runMigrations(db);
    });

    afterAll(async () => {
      // FK-safe teardown, most-dependent first. Nothing here writes graph_edge or
      // adapter_endpoint (the mapping is peer-peer; graph recompute is stubbed), so there is
      // no adapter/graph row to clear before registered_app.
      if (mappingIds.length > 0) {
        // The MappingApproved outbox event references the successor by id in its payload.
        await db.delete(eventOutbox).where(
          sql`${eventOutbox.type} = 'MappingApproved' AND ${eventOutbox.payload}->>'approvedMappingId' IN (${sql.join(
            mappingIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      }
      if (proposalIds.length > 0) {
        // Deleting the re-review proposals first clears their `re_review_of` FK to the stale
        // predecessor, so approved_mapping can be deleted next (items cascade with the proposal).
        await db.delete(mappingProposal).where(inArray(mappingProposal.id, proposalIds));
      }
      if (specIds.length > 0) {
        await db.delete(mappingDetectionJob).where(inArray(mappingDetectionJob.apiSpecId, specIds));
      }
      if (mappingIds.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.relatedMappingId, mappingIds));
      }
      if (proposalIds.length > 0) {
        await db.delete(auditLog).where(inArray(auditLog.relatedProposalId, proposalIds));
      }
      if (appIds.length > 0) {
        // predecessor/successor are deleted in one statement (self-FK is NO ACTION), children cascade.
        await db.delete(approvedMapping).where(inArray(approvedMapping.sourceAppId, appIds));
      }
      if (specIds.length > 0) {
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
        baseUrl: "https://sl6.example.test",
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

    /**
     * A version-advance `TxStores` with the REAL detection-job / approved-mapping / mapping-
     * artifacts / api-spec repos (the SL-4 stale-mark + SL-6 re-review-job record), and inert
     * stubs for the SL-5 / graph / cache ports this SL-6-focused test does not exercise.
     */
    function txStoresOn(handle: DbHandle): TxStores {
      return {
        registeredApps: new RegisteredAppRepository(handle),
        apiSpecs: new ApiSpecRepository(handle),
        resourceBindings: new ResourceBindingRepository(handle),
        credentialStore: unusedCredentials,
        approvedMappings: new ApprovedMappingRepository(handle),
        audit: new AuditLogRepository(handle),
        detectionJobs: new DetectionJobRepository(handle),
        mappingArtifacts: new MappingArtifactsRepository(handle),
        downstreamArtifacts: {
          listAdapterBindingsByMapping: (): Promise<never[]> => Promise.resolve([]),
          listSyncRulesByMapping: (): Promise<never[]> => Promise.resolve([]),
        },
        graph: {
          recomputeSyncEdge: (): Promise<void> => Promise.resolve(),
          recomputeAdapterEdge: (): Promise<void> => Promise.resolve(),
        },
        cacheInvalidator: { invalidateEndpoint: (): void => {} },
        syncRules: { clearPollOperationRef: (): Promise<void> => Promise.resolve() },
        scopeCorrespondences: { listByResourceSide: (): Promise<never[]> => Promise.resolve([]) },
        scopeLifecycle: {
          // The only SL-5 hook the breaking carry-forward reaches; no bindings → no findings.
          revalidateSpecBindings: (): Promise<SpecScopeRevalidationResult> =>
            Promise.resolve({ findings: [], bindings: [] }),
          revalidateCorrespondence: () =>
            Promise.reject(new Error("no scoped correspondence in this test")),
        },
        emit: () => Promise.reject(new Error("advance must not emit")),
      };
    }

    it("stales the mapping, records a re-review job, and the worker produces a successor proposal that approval links to its predecessor", async () => {
      const appA = providerApp("SL-6 A");
      const appB = providerApp("SL-6 B");
      await new RegisteredAppRepository(db).create(appA);
      await new RegisteredAppRepository(db).create(appB);

      const aV1 = await seedSpec(appA.id, providerSpecDocument());
      const bSpec = await seedSpec(appB.id, taskProviderDocument());

      // A peer-peer ApprovedMapping issues(A v1) → tasks(B), referencing the soon-broken `title`.
      const staleMappingId = randomUUID();
      mappingIds.push(staleMappingId);
      const mapping: ApprovedMapping = {
        id: staleMappingId,
        sourceSpecId: aV1.id,
        targetSpecId: bSpec.id,
        sourceAppId: appA.id,
        targetAppId: appB.id,
        variant: "peer-peer",
        approvedBy: ACTOR,
        approvedAt: CREATED_AT,
        status: "active",
      };
      await new ApprovedMappingRepository(db).insert(mapping);
      await new MappingArtifactsRepository(db).replaceChildren(staleMappingId, {
        fieldMappings: [
          {
            id: randomUUID(),
            mappingId: staleMappingId,
            sourcePath: "issues/title",
            targetPath: "tasks/title",
            transform: "rename",
          },
        ],
        operationMappings: [
          {
            id: randomUUID(),
            mappingId: staleMappingId,
            sourceOperationRef: "issues/listIssues",
            targetOperationRef: "tasks/listTasks",
            action: "read",
          },
        ],
        parameterMappings: [],
      });

      // Advance A with a breaking `title` retype — stales the mapping + records the re-review job.
      const outcome = await tx(db, (handle) =>
        registry.ingestNewVersion(
          appA.id,
          providerSpecWithRetypedTitle(),
          "PROVIDER",
          txStoresOn(handle),
        ),
      );
      if (outcome.kind !== "advanced") throw new Error("expected advanced");
      const aV2 = outcome.newSpec;
      specIds.push(aV2.id);
      expect(outcome.diff.classification).toBe("breaking");

      // SL-4 — the mapping is stale and stays pinned to the reviewed (superseded) v1.
      const staled = await new ApprovedMappingRepository(db).getById(staleMappingId);
      expect(staled?.status).toBe("stale");
      expect(staled?.sourceSpecId).toBe(aV1.id);

      // SL-6.1 — a pending `re-review` job exists for v2 carrying the stale mapping's descriptor.
      const pending = await new DetectionJobRepository(db).listByStatus("pending");
      const v2Jobs = pending.filter((job) => job.apiSpecId === aV2.id);
      expect(v2Jobs).toHaveLength(1);
      const scope = v2Jobs[0]?.scope;
      if (scope?.kind !== "re-review") throw new Error("expected a re-review scope");
      expect(scope.supersededSpecId).toBe(aV1.id);
      expect(scope.staleMappings).toEqual([
        { staleMappingId, affectedPairs: [{ sourceResource: "issues", targetResource: "tasks" }] },
      ]);

      // Wire the real worker with a FakeProvider (no live LLM); the re-review branch runs
      // detail-only (no shortlist scripted → a stage-1 call would throw loudly).
      const provider = new FakeProvider({
        detail: { "issues=>tasks@peer-peer": [issuesToTasksDetail] },
      });
      const runDeps = {
        provider,
        maxRetries: 0,
        promptVersion: PROMPT_VERSION,
        specSource: createDbSpecSource(db),
        proposalStore: createDbProposalStore(db),
      };
      const worker = new DetectionWorker<DbTransaction>({
        scope: db,
        jobs: (handle) => new DetectionJobRepository(handle),
        runDetection: () =>
          Promise.reject(new Error("full detection not expected for a scoped job")),
        runScopedDetection: async (job) => {
          if (job.scope?.kind !== "re-review") {
            throw new Error(`expected a re-review scope, got ${String(job.scope?.kind)}`);
          }
          await runScopedReReviewAnalysis(
            {
              newSpecId: job.apiSpecId,
              supersededSpecId: job.scope.supersededSpecId,
              staleMappings: job.scope.staleMappings,
            },
            { ...runDeps, staleMappings: createDbStaleMappingSource(db) },
          );
        },
        clock: () => NOW,
      });

      const runResult = await worker.runOnce();
      expect(runResult).toStrictEqual({ claimed: true, outcome: "completed" });

      // SL-6.3/6.4 — an ordinary PENDING successor proposal, pinned to v2, tagged with the
      // stale predecessor. Nothing was auto-approved.
      const proposalRepo = new MappingProposalRepository(db);
      const successorProposals = (await proposalRepo.listBySourceSpecId(aV2.id)).filter(
        (proposal) => proposal.targetSpecId === bSpec.id,
      );
      expect(successorProposals).toHaveLength(1);
      const successorProposal = successorProposals[0];
      if (successorProposal === undefined) throw new Error("no successor proposal");
      proposalIds.push(successorProposal.id);
      expect(successorProposal.status).toBe("pending");
      expect(successorProposal.reReviewOf).toBe(staleMappingId);
      const pairs = successorProposal.shortlistResult?.candidatePairs ?? [];
      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({ sourceResource: "issues", targetResource: "tasks" });
      const items = await proposalRepo.listItems(successorProposal.id);
      expect(items.length).toBeGreaterThan(0);

      // Approve the re-review proposal through the REAL Approval Service → the successor mapping.
      const approvalService = new ApprovalService({
        unitOfWork: new DbApprovalUnitOfWork(db, new PostgresEventBus()),
      });
      for (const item of items) {
        await approvalService.decideItem({ itemId: item.id, decision: { kind: "accept" } }, ACTOR);
      }
      const approveResult = await approvalService.approve(
        { proposalId: successorProposal.id },
        ACTOR,
      );
      if (approveResult.outcome === "rejected") throw new Error("unexpected rejected");
      mappingIds.push(approveResult.mapping.id);

      // SL-6.4 — the successor is a NEW row pinned to the new version, linked to its predecessor.
      const successor = await new ApprovedMappingRepository(db).getById(approveResult.mapping.id);
      expect(successor?.id).not.toBe(staleMappingId);
      expect(successor?.status).toBe("active");
      expect(successor?.sourceSpecId).toBe(aV2.id);
      expect(successor?.targetSpecId).toBe(bSpec.id);
      expect(successor?.predecessorMappingId).toBe(staleMappingId);

      // The stale predecessor is retained, still stale — SL-7 adoption (a later slice) supersedes it.
      expect((await new ApprovedMappingRepository(db).getById(staleMappingId))?.status).toBe(
        "stale",
      );

      // The successor of the stale mapping is discoverable by the predecessor link (the SL-7 seam).
      const bySuccessorLink = await db
        .select()
        .from(approvedMapping)
        .where(eq(approvedMapping.predecessorMappingId, staleMappingId));
      expect(bySuccessorLink.map((row) => row.id)).toEqual([approveResult.mapping.id]);
    });
  },
);
