import { loadConfig, type AppConfig } from "@mediator/config";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DetectionJobRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  fieldMapping,
  mappingDetectionJob,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  runMigrations,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  IrResourceGroup,
  MappingProposal,
  RegisteredApp,
} from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServerLogger } from "./composition-root.js";
import {
  AnalysisExclusionsService,
  RE_INCLUSION_AUDIT_PREFIX,
} from "./modules/analysis-exclusions.js";
import {
  buildDetectionBackground,
  type DetectionBackground,
} from "./modules/detection/background.js";
import type { TxStores, UnitOfWork } from "./modules/persistence.js";

/**
 * **SL-9 — live-Postgres integration for the re-inclusion path**: removing a resource
 * group from an already-registered spec's `analysisExclusions` records a **scoped**
 * `re-inclusion` `mapping_detection_job` in the exclusions-replace transaction (the real
 * repository, real partial-unique idempotency), after which the **real** detection
 * background wiring claims it and runs the same scoped incremental analysis SL-3 runs —
 * persisting an ordinary `pending` `MappingProposal` for the re-included resource.
 *
 * It also pins the analysis-only invariant (SL-9.3): a pre-existing `ApprovedMapping`
 * over an unrelated resource, and its approved children, come out byte-identical. The
 * LLM is the deterministic `FakeProvider`; everything else is real Postgres.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`. Self-skips when `DATABASE_URL` is unresolvable. Run in isolation
 * (the shared-DB integration suite is flaky across files).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CREATED_AT = new Date("2026-07-23T00:00:00.000Z");
const OPERATOR = "sl9-operator@example.test";

/** The resource the operator excluded and then re-includes — the analysis subject. */
const labelsGroup: IrResourceGroup = {
  resourceRef: "labels",
  name: "Labels",
  operations: [
    {
      operationId: "listLabels",
      method: "get",
      path: "/labels",
      summary: "List labels",
      parameters: [],
    },
  ],
  schemas: [{ name: "Label", fields: [{ name: "name", type: "string", required: true }] }],
  crossResourceRefs: [],
};
/** An unrelated, never-excluded resource — the pre-existing `ApprovedMapping`'s subject. */
const issuesGroup: IrResourceGroup = {
  resourceRef: "issues",
  name: "Issues",
  operations: [
    {
      operationId: "listIssues",
      method: "get",
      path: "/issues",
      summary: "List issues",
      parameters: [],
    },
  ],
  schemas: [{ name: "Issue", fields: [{ name: "title", type: "string", required: true }] }],
  crossResourceRefs: [],
};
/** A second excluded resource, re-included while the first one's job is still pending. */
const webhooksGroup: IrResourceGroup = {
  resourceRef: "webhooks",
  name: "Webhooks",
  operations: [
    {
      operationId: "listWebhooks",
      method: "get",
      path: "/webhooks",
      summary: "List webhooks",
      parameters: [],
    },
  ],
  schemas: [{ name: "Webhook", fields: [{ name: "url", type: "string", required: true }] }],
  crossResourceRefs: [],
};
/** The counterpart spec's resource `labels` shortlists against. */
const tasksGroup: IrResourceGroup = {
  resourceRef: "tasks",
  name: "Tasks",
  operations: [
    {
      operationId: "listTasks",
      method: "get",
      path: "/tasks",
      summary: "List tasks",
      parameters: [],
    },
  ],
  schemas: [{ name: "Task", fields: [{ name: "name", type: "string", required: true }] }],
  crossResourceRefs: [],
};

function integrationConfig(): AppConfig {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://mediator:mediator@localhost:5432/api_mediator",
    CREDENTIAL_MASTER_KEY:
      process.env.CREDENTIAL_MASTER_KEY ?? Buffer.alloc(32, 7).toString("base64"),
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    MAPPING_LLM_MODEL: process.env.MAPPING_LLM_MODEL ?? "test-model",
    MAPPING_LLM_THINKING: process.env.MAPPING_LLM_THINKING ?? "false",
    MAPPING_LLM_REQUEST_TIMEOUT_MS: process.env.MAPPING_LLM_REQUEST_TIMEOUT_MS ?? "300000",
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "",
    OPERATOR_ACCOUNTS:
      process.env.OPERATOR_ACCOUNTS ?? "operator:operator:scrypt$16384$8$1$64$c2FsdA==$aGFzaA==",
  };
  return loadConfig(env);
}

/** The scripted stage-1 output for the re-included `labels` group vs. the counterpart. */
const labelsShortlist = {
  candidatePairs: [
    {
      sourceResource: "labels",
      targetResource: "tasks",
      confidence: 0.6,
      rationale: "Both are simple named collections.",
    },
  ],
};
const peerDetail = (sourceOperationId: string, targetOperationId: string): unknown => ({
  variant: "peer-peer",
  operationMappings: [
    {
      sourceOperationId,
      targetOperationId,
      confidence: 0.6,
      rationale: "Both list a collection.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
  fieldMappings: [
    {
      sourceField: "name",
      targetField: "name",
      transform: "rename",
      transformDetail: "",
      identityCandidate: false,
      confidence: 0.7,
      rationale: "Same name field.",
      ambiguousAlternatives: [],
      unmapped: false,
    },
  ],
});

suite("SL-9 re-inclusion: replace → scoped job → worker → proposal (requires Postgres)", () => {
  let db: Database;
  let background: DetectionBackground;
  const appIds: string[] = [];
  const specIds: string[] = [];
  const mappingIds: string[] = [];

  let specA: ApiSpec;
  let specB: ApiSpec;
  let seededMapping: ApprovedMapping;
  let seededField: FieldMapping;

  /**
   * A `TxStores` whose SL-9 ports are the REAL repositories and whose every other port
   * REJECTS. That encodes SL-9.3 structurally: if the exclusions replace ever reached an
   * `ApprovedMapping`, a proposal, the graph, or a cache, the transaction would fail.
   */
  function txStoresOn(handle: DbHandle): TxStores {
    const unused = (port: string) => (): Promise<never> =>
      Promise.reject(new Error(`SL-9 replace must not touch ${port}`));
    return {
      apiSpecs: new ApiSpecRepository(handle),
      detectionJobs: new DetectionJobRepository(handle),
      audit: new AuditLogRepository(handle),
      registeredApps: {
        create: unused("registeredApps"),
        getById: unused("registeredApps"),
      },
      resourceBindings: {
        createMany: unused("resourceBindings"),
        getById: unused("resourceBindings"),
        listByApiSpecId: unused("resourceBindings"),
        update: unused("resourceBindings"),
        updateScopePathBinding: unused("resourceBindings"),
        updateSourceScopeRef: unused("resourceBindings"),
      },
      credentialStore: { store: unused("credentialStore") },
      approvedMappings: {
        listActiveBySpecId: unused("approvedMappings"),
        repinSpecs: unused("approvedMappings"),
        markStale: unused("approvedMappings"),
      },
      mappingArtifacts: {
        listFieldMappings: unused("mappingArtifacts"),
        listOperationMappings: unused("mappingArtifacts"),
      },
      downstreamArtifacts: {
        listAdapterBindingsByMapping: unused("downstreamArtifacts"),
        listSyncRulesByMapping: unused("downstreamArtifacts"),
      },
      graph: {
        recomputeSyncEdge: unused("graph"),
        recomputeAdapterEdge: unused("graph"),
      },
      cacheInvalidator: {
        invalidateEndpoint: (): void => {
          throw new Error("SL-9 replace must not drop caches");
        },
      },
      syncRules: { clearPollOperationRef: unused("syncRules") },
      scopeCorrespondences: { listByResourceSide: unused("scopeCorrespondences") },
      scopeLifecycle: {
        revalidateSpecBindings: unused("scopeLifecycle"),
        revalidateCorrespondence: unused("scopeLifecycle"),
      },
      emit: unused("the event bus"),
    };
  }

  const unitOfWork: UnitOfWork = {
    run: (work) => tx(db, (handle) => work(txStoresOn(handle))),
  };

  function providerApp(name: string): RegisteredApp {
    const app: RegisteredApp = {
      id: randomUUID(),
      name: `${name} ${randomUUID()}`,
      status: "active",
      baseUrl: "https://sl9.example.test",
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
    parsedIR: IrResourceGroup[],
    analysisExclusions: string[],
  ): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role: "PROVIDER",
      rawDocument: { openapi: "3.0.0" },
      parsedIR,
      analysisExclusions,
      version: 1,
      contentHash: randomUUID(),
      status: "active",
      createdAt: CREATED_AT,
    };
    specIds.push(spec.id);
    await new ApiSpecRepository(db).create(spec);
    return spec;
  }

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);

    const appA = providerApp("SL-9 A");
    const appB = providerApp("SL-9 B");
    await new RegisteredAppRepository(db).create(appA);
    await new RegisteredAppRepository(db).create(appB);

    // Spec A holds two excluded groups (`labels`, `webhooks`) plus the unrelated,
    // never-excluded `issues`; B is the counterpart.
    specA = await seedSpec(
      appA.id,
      [issuesGroup, labelsGroup, webhooksGroup],
      ["labels", "webhooks"],
    );
    specB = await seedSpec(appB.id, [tasksGroup], []);

    // A pre-existing, human-approved mapping over the UNRELATED `issues` resource.
    seededMapping = {
      id: randomUUID(),
      sourceSpecId: specA.id,
      targetSpecId: specB.id,
      sourceAppId: appA.id,
      targetAppId: appB.id,
      variant: "peer-peer",
      status: "active",
      approvedBy: OPERATOR,
      approvedAt: CREATED_AT,
    };
    mappingIds.push(seededMapping.id);
    await new ApprovedMappingRepository(db).insert(seededMapping);
    seededField = {
      id: randomUUID(),
      mappingId: seededMapping.id,
      sourcePath: "issues/title",
      targetPath: "tasks/title",
      transform: "rename",
    };
    await new MappingArtifactsRepository(db).replaceChildren(seededMapping.id, {
      fieldMappings: [seededField],
      operationMappings: [],
      parameterMappings: [],
    });

    // The REAL production background wiring — so the `re-inclusion` branch under test is
    // the one that ships — with a deterministic FakeProvider instead of a live model.
    const provider = new FakeProvider({
      shortlistKey: (ctx) => ctx.sourceSpecSummaryIR.map((group) => group.resourceRef).join(","),
      // Keyed by the SOURCE summary only, so it is robust to any extra active counterpart
      // the shared DB might hold. Both keys pair `labels`→`tasks` and leave `webhooks`
      // unpaired; the merged-scope run summarizes both groups in one call.
      shortlist: { labels: [labelsShortlist], "labels,webhooks": [labelsShortlist] },
      detail: {
        "labels=>tasks@peer-peer": [peerDetail("listLabels", "listTasks")],
        "tasks=>labels@peer-peer": [peerDetail("listTasks", "listLabels")],
      },
    });
    background = buildDetectionBackground({
      config,
      db,
      logger: createServerLogger(config),
      provider,
    });
  });

  afterAll(async () => {
    background.stop();
    // FK-safe teardown: children before parents, everything scoped to this suite's ids.
    if (mappingIds.length > 0) {
      await db.delete(fieldMapping).where(inArray(fieldMapping.mappingId, mappingIds));
      await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
    }
    if (specIds.length > 0) {
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
    await db.delete(auditLog).where(eq(auditLog.actor, OPERATOR));
    if (appIds.length > 0) {
      await db.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
      await db.delete(registeredApp).where(inArray(registeredApp.id, appIds));
    }
    await closeDb(db);
  });

  it("records the scoped re-inclusion job + audit row in the replace tx, then the worker produces an ordinary proposal", async () => {
    const jobs = new DetectionJobRepository(db);
    const service = new AnalysisExclusionsService({ unitOfWork });

    // ── Removing `labels` from analysisExclusions (SL-9.1) ────────────────────
    const updated = await service.replace(specA.id, ["webhooks"], OPERATOR);
    expect(updated.analysisExclusions).toEqual(["webhooks"]);

    // The intent is recorded in-tx; NO proposal exists yet (the LLM work is off the tx).
    const pending = (await jobs.listByStatus("pending")).filter(
      (job) => job.apiSpecId === specA.id,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.scope).toEqual({
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels"],
    });
    const proposalRepo = new MappingProposalRepository(db);
    expect(await proposalRepo.listBySourceSpecId(specA.id)).toHaveLength(0);

    // SL-9.5 — a durable, countable, operator-attributed audit row exists.
    expect(await reInclusionAuditRows()).toHaveLength(1);
    expect((await reInclusionAuditRows())[0]?.details).toContain("labels");
    expect((await reInclusionAuditRows())[0]?.details).toContain(specA.id);

    // ── A SECOND removal while that job is still pending must not be swallowed ──
    // Only one un-finished job may exist per spec, and a scoped job's resource list is
    // frozen in the row, so an `ON CONFLICT DO NOTHING` collapse here would silently
    // drop `webhooks` forever. It merges into the pending job instead.
    await service.replace(specA.id, [], OPERATOR);

    const afterMerge = (await jobs.listByStatus("pending")).filter(
      (job) => job.apiSpecId === specA.id,
    );
    expect(afterMerge).toHaveLength(1);
    expect(afterMerge[0]?.id).toBe(pending[0]?.id); // the SAME row, rewritten
    expect(afterMerge[0]?.scope).toEqual({
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels", "webhooks"],
    });
    const merged = await reInclusionAuditRows();
    expect(merged).toHaveLength(2);
    expect(merged[1]?.details).toContain("merged into the pending re-inclusion job");

    // An identical replace re-includes nothing at all, so it records no job and no row.
    await service.replace(specA.id, [], OPERATOR);
    expect(
      (await jobs.listByStatus("pending")).filter((job) => job.apiSpecId === specA.id),
    ).toHaveLength(1);
    expect(await reInclusionAuditRows()).toHaveLength(2);

    // ── The real worker claims it and runs the scoped analysis off-transaction ──
    for (let pass = 0; pass < 10; pass += 1) {
      const stillPending = (await jobs.listByStatus("pending")).filter(
        (job) => job.apiSpecId === specA.id,
      );
      if (stillPending.length === 0) break;
      const result = await background.worker.runOnce();
      if (!result.claimed) break;
    }

    const completed = (await jobs.listByStatus("completed")).filter(
      (job) => job.apiSpecId === specA.id,
    );
    expect(completed).toHaveLength(1);

    // ── SL-9.1/9.2 — an ORDINARY, pending proposal for the re-included resource ──
    const forward = await proposalRepo.listBySourceSpecId(specA.id);
    const reverse = (await proposalRepo.listBySourceSpecId(specB.id)).filter(
      (proposal: MappingProposal) => proposal.targetSpecId === specA.id,
    );
    expect(forward).toHaveLength(1);
    expect(reverse).toHaveLength(1);
    for (const proposal of [...forward, ...reverse]) {
      // Nothing is auto-approved and nothing is silent: it goes to the Phase-3 queue.
      expect(proposal.status).toBe("pending");
      // An ORDINARY proposal — not an SL-6 re-review successor of some stale mapping.
      expect(proposal.reReviewOf).toBeUndefined();
      const pairs = proposal.shortlistResult?.candidatePairs ?? [];
      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.sourceResource).toBe("labels");
      expect(pairs[0]?.targetResource).toBe("tasks");
      // The analysis is SCOPED: the unrelated `issues` resource is not re-analyzed.
      expect(pairs.some((pair) => pair.sourceResource === "issues")).toBe(false);
      expect(await proposalRepo.listItems(proposal.id)).not.toHaveLength(0);
    }

    // The MERGED second removal was analyzed too — `webhooks` was summarized and
    // shortlisted (finding no counterpart), which is what would have been lost had the
    // collapsed enqueue been swallowed.
    const noCounterpart = forward[0]?.shortlistResult?.noCounterpartResources ?? [];
    expect(noCounterpart.some((resource) => resource.resourceRef === "webhooks")).toBe(true);

    // ── SL-9.3 — the pre-existing ApprovedMapping and its children are UNTOUCHED ──
    const mappingAfter = await new ApprovedMappingRepository(db).getById(seededMapping.id);
    expect(mappingAfter).toStrictEqual(seededMapping);
    const fieldsAfter = await new MappingArtifactsRepository(db).listFieldMappings(
      seededMapping.id,
    );
    expect(fieldsAfter).toStrictEqual([seededField]);
  });

  /**
   * SL-9 — the collapse that CANNOT be resolved. A `running` analysis already read the
   * spec's exclusions, so it can never pick up a newly re-included group, and its row
   * must not be rewritten underneath it. The `replace` is refused with a 409 and the
   * whole transaction rolls back — no exclusion change, and above all no audit row
   * claiming an analysis that would never have run.
   */
  it("refuses the re-inclusion with a 409 while an analysis is running, committing nothing", async () => {
    const service = new AnalysisExclusionsService({ unitOfWork });

    // Re-exclude `labels` first (an exclusion ADD never triggers anything), then stage a
    // running job for this spec — the state a mid-flight LLM analysis leaves behind.
    await service.replace(specA.id, ["labels"], OPERATOR);
    const auditBefore = await reInclusionAuditRows();
    await db
      .insert(mappingDetectionJob)
      .values({ apiSpecId: specA.id, status: "running", startedAt: new Date() });

    await expect(service.replace(specA.id, [], OPERATOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    // Rolled back: the exclusion still stands and no new audit row was written.
    const specAfter = await new ApiSpecRepository(db).getById(specA.id);
    expect(specAfter?.analysisExclusions).toEqual(["labels"]);
    expect(await reInclusionAuditRows()).toHaveLength(auditBefore.length);
  });

  /** This suite's re-inclusion audit rows, oldest first (SL-9.5's countable signal). */
  async function reInclusionAuditRows(): Promise<{ details: string | null }[]> {
    const rows = await db
      .select({ details: auditLog.details, timestamp: auditLog.timestamp })
      .from(auditLog)
      .where(eq(auditLog.actor, OPERATOR))
      .orderBy(auditLog.timestamp);
    return rows.filter((row) => row.details?.startsWith(RE_INCLUSION_AUDIT_PREFIX) === true);
  }
});
