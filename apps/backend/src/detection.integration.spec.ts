import { loadConfig, type AppConfig } from "@mediator/config";
import {
  ApiSpecRepository,
  DetectionJobRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  createDb,
  credential,
  eventOutbox,
  mappingDetectionJob,
  mappingProposal,
  processedEvent,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import type { ApiSpec, IrResourceGroup, RegisteredApp } from "@mediator/domain";
import { PostgresEventBus, createSpecIngested } from "@mediator/event-bus";
import { FakeProvider } from "@mediator/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildDetectionBackground,
  type DetectionBackground,
} from "./modules/detection/background.js";
import { createServerLogger } from "./composition-root.js";

/**
 * End-to-end detection-trigger integration test against a live Postgres (compose
 * `postgres` service). Excluded from `pnpm verify`; run with
 * `pnpm --filter @mediator/backend test:integration`. It self-skips when
 * `DATABASE_URL` is unresolvable, and uses the deterministic `FakeProvider` (NO
 * live Ollama) — the only external dependency is the database.
 *
 * It proves the crux of DT-2: on `SpecIngested`, the Event Bus dispatcher pass
 * creates a `mapping_detection_job` **and persists NO proposals** (the LLM work did
 * not run inside the dispatcher transaction); then the `DetectionWorker` claims the
 * job and runs the engine (FakeProvider) OUTSIDE that transaction, persisting the
 * proposals and completing the job. It also proves the reconciler re-enqueues an
 * active spec that has no job (bus loss degrades timeliness, not correctness).
 */

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

// Fixed ids: SPEC_GITEA < SPEC_VIKUNJA fixes the canonical shortlist orientation
// (Gitea `issues` is the canonical source), so the scripted shortlist is valid.
const APP_GITEA = "aaaaaaaa-0000-0000-0000-000000000001";
const APP_VIKUNJA = "aaaaaaaa-0000-0000-0000-000000000002";
const SPEC_GITEA = "11111111-0000-0000-0000-000000000001";
const SPEC_VIKUNJA = "22222222-0000-0000-0000-000000000002";
const CREATED_AT = new Date("2026-07-11T00:00:00.000Z");

const giteaIssues: IrResourceGroup = {
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
const vikunjaTasks: IrResourceGroup = {
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
  schemas: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }],
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
  };
  return loadConfig(env);
}

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string, group: IrResourceGroup): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [group],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}

/** FakeProvider scripted for the Gitea `issues` ↔ Vikunja `tasks` peer pair. */
function makeProvider(): FakeProvider {
  const peerDetail = (sourceOp: string, targetOp: string): unknown => ({
    variant: "peer-peer",
    operationMappings: [
      {
        sourceOperationId: sourceOp,
        targetOperationId: targetOp,
        confidence: 0.9,
        rationale: "list ↔ list",
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
        identityCandidate: true,
        confidence: 0.95,
        rationale: "shared title",
        ambiguousAlternatives: [],
        unmapped: false,
      },
    ],
  });
  return new FakeProvider({
    shortlist: {
      "issues=>tasks": [
        {
          candidatePairs: [
            { sourceResource: "issues", targetResource: "tasks", confidence: 0.8, rationale: "x" },
          ],
        },
      ],
    },
    detail: {
      "issues=>tasks@peer-peer": [peerDetail("listIssues", "listTasks")],
      "tasks=>issues@peer-peer": [peerDetail("listTasks", "listIssues")],
    },
  });
}

suite("detection-trigger integration (requires Postgres)", () => {
  let db: Database;
  let background: DetectionBackground;

  beforeAll(async () => {
    const config = integrationConfig();
    db = createDb(config.database.url);
    await runMigrations(db);

    // Clean slate so the reconciler's landscape-wide query sees only these specs.
    await db.delete(mappingDetectionJob);
    await db.delete(mappingProposal);
    await db.delete(resourceBinding);
    await db.delete(credential);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await db.delete(eventOutbox);
    await db.delete(processedEvent);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_GITEA, "gitea"));
      await apps.create(appOf(APP_VIKUNJA, "vikunja"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_GITEA, APP_GITEA, giteaIssues));
      await specs.create(specOf(SPEC_VIKUNJA, APP_VIKUNJA, vikunjaTasks));
    });

    // Vikunja is pre-existing; Gitea is the newly-ingested spec → emit its
    // SpecIngested into the outbox (transactional-outbox emit).
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createSpecIngested({ apiSpecId: SPEC_GITEA, appId: APP_GITEA, role: "PROVIDER" }),
        txn,
      ),
    );

    const logger = createServerLogger(config);
    background = buildDetectionBackground({ config, db, logger, provider: makeProvider() });
  });

  afterAll(async () => {
    background.stop();
    await db.delete(mappingDetectionJob);
    await db.delete(mappingProposal);
    await db.delete(resourceBinding);
    await db.delete(credential);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await db.delete(eventOutbox);
    await db.delete(processedEvent);
    await db.$client.end();
  });

  it("dispatcher pass enqueues a job but runs NO detection (LLM off the dispatcher tx)", async () => {
    const result = await background.dispatcher.runOnce();
    expect(result).toStrictEqual({ claimed: 1, published: 1, failed: 0 });

    // A pending detection job now exists for the ingested spec.
    const jobs = new DetectionJobRepository(db);
    const pending = await jobs.listByStatus("pending");
    expect(pending.map((job) => job.apiSpecId)).toStrictEqual([SPEC_GITEA]);

    // Crux of DT-2: NO proposals were persisted in the dispatcher transaction.
    const proposals = new MappingProposalRepository(db);
    expect(await proposals.listBySourceSpecId(SPEC_GITEA)).toStrictEqual([]);
    expect(await proposals.listBySourceSpecId(SPEC_VIKUNJA)).toStrictEqual([]);
  });

  it("worker claims the job, runs the engine outside the tx, and persists proposals", async () => {
    const outcome = await background.worker.runOnce();
    expect(outcome).toStrictEqual({ claimed: true, outcome: "completed" });

    const jobs = new DetectionJobRepository(db);
    expect(await jobs.listByStatus("pending")).toStrictEqual([]);
    const completed = await jobs.listByStatus("completed");
    expect(completed.map((job) => job.apiSpecId)).toStrictEqual([SPEC_GITEA]);
    expect(completed[0]?.finishedAt).not.toBeNull();

    // Both directional peer-peer proposals persisted, with items.
    const proposals = new MappingProposalRepository(db);
    const forward = (await proposals.listBySourceSpecId(SPEC_GITEA))[0];
    expect(forward?.targetSpecId).toBe(SPEC_VIKUNJA);
    expect(forward?.status).toBe("pending");
    expect(forward).toBeDefined();
    if (forward !== undefined) {
      const items = await proposals.listItems(forward.id);
      const title = items.find(
        (item) =>
          item.kind === "field" &&
          item.sourceRef.target.kind === "field" &&
          item.sourceRef.target.path === "title",
      );
      expect(title?.identityCandidate).toBe(true);
    }
    const reverse = (await proposals.listBySourceSpecId(SPEC_VIKUNJA))[0];
    expect(reverse?.status).toBe("pending");

    // Idempotent: no pending job left to re-run.
    expect(await background.worker.runOnce()).toStrictEqual({ claimed: false });
  });

  it("reconciler re-enqueues an active spec with no job, and leaves an analyzed spec alone", async () => {
    const jobs = new DetectionJobRepository(db);
    // Vikunja is active but never got a SpecIngested → no job. Gitea has a completed job.
    const missingBefore = await jobs.listActiveSpecIdsWithoutDetectionJob();
    expect(missingBefore).toStrictEqual([SPEC_VIKUNJA]);

    const sweepResult = await background.sweep.runSweep();
    expect(sweepResult.outcomes).toStrictEqual([{ name: "mapping-detection", status: "ok" }]);

    // Vikunja now has a pending job; Gitea was NOT re-enqueued (a recorded outcome
    // is an analysis result, not an absence — DT-2 crit 5).
    const pending = await jobs.listByStatus("pending");
    expect(pending.map((job) => job.apiSpecId)).toStrictEqual([SPEC_VIKUNJA]);
    expect((await jobs.listByStatus("completed")).map((job) => job.apiSpecId)).toStrictEqual([
      SPEC_GITEA,
    ]);
    expect(await jobs.listActiveSpecIdsWithoutDetectionJob()).toStrictEqual([]);

    // Idempotent re-run: sweeping again does not double-enqueue Vikunja.
    await background.sweep.runSweep();
    expect((await jobs.listByStatus("pending")).map((job) => job.apiSpecId)).toStrictEqual([
      SPEC_VIKUNJA,
    ]);
  });
});
