import type { ApiSpec, Ir, RegisteredApp } from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  DetectionJobRepository,
  RegisteredAppRepository,
} from "./repositories/index.js";
import { apiSpec, mappingDetectionJob, registeredApp } from "./schema.js";

/**
 * Live-database integration test for the `mapping_detection_job` durability
 * surface (the Phase-2 detection-trigger worker's persistence contract). Requires
 * the compose `postgres` service and a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 *
 * It exercises the exact mutations the worker/consumer/reconciler drive against
 * REAL Postgres — `enqueue` idempotency (partial-unique index), `claimNext`
 * (`FOR UPDATE SKIP LOCKED`, pending→running, attempts++, `started_at` stamped),
 * `reclaimStale`, `recordRetry`, `markFailed`, and re-enqueue-after-terminal — so
 * the in-memory `FakeJobStore` used in the worker unit tests is proven to mirror
 * real repo semantics ([[fakes-must-mirror-real-repos]]).
 */

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_ID = "dddddddd-0000-0000-0000-000000000001";
const SPEC_A = "dddddddd-0000-0000-0000-0000000000a1";
const SPEC_B = "dddddddd-0000-0000-0000-0000000000b2";
const CREATED_AT = new Date("2026-07-11T00:00:00.000Z");
const NOW = new Date("2026-07-11T12:00:00.000Z");
const OLD = new Date("2026-07-11T10:00:00.000Z");
const LEASE_CUTOFF = new Date("2026-07-11T11:00:00.000Z"); // OLD < cutoff < NOW

const ir: Ir = [
  {
    resourceRef: "issues",
    name: "Issues",
    operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
    schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
    crossResourceRefs: [],
  },
];

const app: RegisteredApp = {
  id: APP_ID,
  name: "Gitea",
  status: "active",
  baseUrl: "https://gitea.example.test",
  capabilities: {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: true,
    defaultPollInterval: 60000,
  },
  createdAt: CREATED_AT,
};
const specOf = (id: string, contentHash: string): ApiSpec => ({
  id,
  appId: APP_ID,
  role: "PROVIDER",
  rawDocument: { openapi: "3.1.0" },
  parsedIR: ir,
  analysisExclusions: [],
  version: 1,
  contentHash,
  status: "active",
  createdAt: CREATED_AT,
});

suite("Phase-2 detection-job durability integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, "sha256:a"));
      await specs.create(specOf(SPEC_B, "sha256:b"));
    });
  });

  beforeEach(async () => {
    // Isolate each case: clear the job table (its FK'd specs stay).
    await db.delete(mappingDetectionJob);
  });

  afterAll(async () => {
    await db.delete(mappingDetectionJob);
    await db.delete(apiSpec).where(eq(apiSpec.appId, APP_ID));
    await db.delete(registeredApp).where(eq(registeredApp.id, APP_ID));
    await closeDb(db);
  });

  it("enqueue is idempotent: two enqueues for the same spec yield ONE pending job", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    await jobs.enqueue(SPEC_A);

    const pending = await jobs.listByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.apiSpecId).toBe(SPEC_A);
    expect(pending[0]?.attempts).toBe(0);
    expect(pending[0]?.startedAt).toBeNull();
    expect(pending[0]?.finishedAt).toBeNull();
  });

  it("claimNext flips pending→running, bumps attempts, and stamps started_at", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);

    const claimed = await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    expect(claimed?.apiSpecId).toBe(SPEC_A);
    expect(claimed?.attempts).toBe(1);

    const running = await jobs.listByStatus("running");
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
    expect(running[0]?.attempts).toBe(1);
    expect(running[0]?.startedAt).toStrictEqual(NOW);
    expect(await jobs.listByStatus("pending")).toHaveLength(0);
  });

  it("claimNext returns undefined when nothing is pending", async () => {
    const claimed = await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    expect(claimed).toBeUndefined();
  });

  it("concurrent claimNext with SKIP LOCKED never hands the same job to two workers", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    await jobs.enqueue(SPEC_B);

    const [first, second] = await Promise.all([
      tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW)),
      tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW)),
    ]);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Two distinct jobs — neither worker grabbed the row the other locked.
    expect(new Set([first?.id, second?.id]).size).toBe(2);
    expect(new Set([first?.apiSpecId, second?.apiSpecId])).toStrictEqual(new Set([SPEC_A, SPEC_B]));
    expect(await jobs.listByStatus("running")).toHaveLength(2);
  });

  it("reclaimStale returns a stale running job to pending and clears started_at", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    // Claim with an OLD clock so started_at predates the lease cutoff.
    await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(OLD));

    const reclaimed = await jobs.reclaimStale(LEASE_CUTOFF);
    expect(reclaimed).toBe(1);

    const pending = await jobs.listByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.startedAt).toBeNull();
    expect(pending[0]?.attempts).toBe(1); // the earlier claim's bump survives
    expect(await jobs.listByStatus("running")).toHaveLength(0);
  });

  it("reclaimStale does NOT reclaim a running job still within the lease", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW)); // started_at = NOW

    const reclaimed = await jobs.reclaimStale(LEASE_CUTOFF); // NOW > cutoff → not stale
    expect(reclaimed).toBe(0);
    expect(await jobs.listByStatus("running")).toHaveLength(1);
    expect(await jobs.listByStatus("pending")).toHaveLength(0);
  });

  it("recordRetry returns a job to pending with last_error, attempts unchanged", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    const claimed = await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    expect(claimed).toBeDefined();
    if (claimed === undefined) return;

    await jobs.recordRetry(claimed.id, "detection boom");

    const pending = await jobs.listByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.lastError).toBe("detection boom");
    expect(pending[0]?.startedAt).toBeNull();
    expect(pending[0]?.attempts).toBe(1); // bumped by the claim, not by recordRetry
    expect(pending[0]?.finishedAt).toBeNull();
  });

  it("markFailed parks a job: failed, finished_at set, last_error recorded", async () => {
    const jobs = new DetectionJobRepository(db);
    await jobs.enqueue(SPEC_A);
    const claimed = await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    expect(claimed).toBeDefined();
    if (claimed === undefined) return;

    await jobs.markFailed(claimed.id, "ceiling reached", NOW);

    const failed = await jobs.listByStatus("failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.lastError).toBe("ceiling reached");
    expect(failed[0]?.finishedAt).toStrictEqual(NOW);
  });

  it("a terminal (failed/completed) job does not block re-enqueue; an in-flight one does", async () => {
    const jobs = new DetectionJobRepository(db);

    // Park a job for SPEC_A, then re-enqueue: the partial-unique index only covers
    // pending/running, so a fresh pending job IS created alongside the failed one.
    await jobs.enqueue(SPEC_A);
    const first = await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    expect(first).toBeDefined();
    if (first === undefined) return;
    await jobs.markFailed(first.id, "boom", NOW);

    await jobs.enqueue(SPEC_A);
    expect((await jobs.listByStatus("pending")).map((job) => job.apiSpecId)).toStrictEqual([
      SPEC_A,
    ]);
    expect(await jobs.listByStatus("failed")).toHaveLength(1);

    // While that fresh job is pending (in-flight), a further enqueue is a no-op.
    await jobs.enqueue(SPEC_A);
    expect(await jobs.listByStatus("pending")).toHaveLength(1);

    // And once it is running, still a no-op.
    await tx(db, (txn) => new DetectionJobRepository(txn).claimNext(NOW));
    await jobs.enqueue(SPEC_A);
    expect(await jobs.listByStatus("running")).toHaveLength(1);
    expect(await jobs.listByStatus("pending")).toHaveLength(0);
  });

  it("listActiveSpecIdsWithoutDetectionJob returns only active specs with no job", async () => {
    const jobs = new DetectionJobRepository(db);
    // Both specs active with no jobs → both missing.
    expect(new Set(await jobs.listActiveSpecIdsWithoutDetectionJob())).toStrictEqual(
      new Set([SPEC_A, SPEC_B]),
    );

    await jobs.enqueue(SPEC_A);
    // SPEC_A now has a job (pending) → no longer missing; SPEC_B still missing.
    expect(await jobs.listActiveSpecIdsWithoutDetectionJob()).toStrictEqual([SPEC_B]);
  });
});
