import type {
  ClaimedDetectionJob,
  DetectionJobScope,
  DetectionJobWorkerOps,
  TransactionScope,
} from "@mediator/db";
import { describe, expect, it } from "vitest";

import { DetectionWorker } from "./worker.js";

/** A transaction scope that runs the callback inline (models a short DB tx). */
class FakeScope implements TransactionScope<FakeScope> {
  public transaction<T>(fn: (txn: FakeScope) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

type JobStatus = "pending" | "running" | "completed" | "failed";

interface FakeJob {
  id: string;
  apiSpecId: string;
  status: JobStatus;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastError: string | null;
  scope: DetectionJobScope | null;
}

/**
 * In-memory `DetectionJobWorkerOps` mirroring the real repository semantics: claim
 * bumps `attempts` + stamps `started_at`, reclaimStale returns `running` rows past
 * the threshold to `pending`, and the settle methods move the job to its terminal
 * (or retry) state. Kept faithful so it can't mask a bug the real repo would show.
 */
class FakeJobStore implements DetectionJobWorkerOps {
  public readonly jobs: FakeJob[];
  public constructor(jobs: readonly FakeJob[]) {
    this.jobs = jobs.map((job) => ({ ...job }));
  }

  public reclaimStale(olderThan: Date): Promise<number> {
    let count = 0;
    for (const job of this.jobs) {
      if (job.status === "running" && job.startedAt !== null && job.startedAt < olderThan) {
        job.status = "pending";
        job.startedAt = null;
        job.lastError = "reclaimed";
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  public claimNext(now: Date): Promise<ClaimedDetectionJob | undefined> {
    const job = this.jobs.find((candidate) => candidate.status === "pending");
    if (job === undefined) {
      return Promise.resolve(undefined);
    }
    job.attempts += 1;
    job.status = "running";
    job.startedAt = now;
    return Promise.resolve({
      id: job.id,
      apiSpecId: job.apiSpecId,
      attempts: job.attempts,
      scope: job.scope,
    });
  }

  public markCompleted(id: string, finishedAt: Date): Promise<void> {
    this.#patch(id, (job) => {
      job.status = "completed";
      job.finishedAt = finishedAt;
    });
    return Promise.resolve();
  }

  public markFailed(id: string, error: string, finishedAt: Date): Promise<void> {
    this.#patch(id, (job) => {
      job.status = "failed";
      job.finishedAt = finishedAt;
      job.lastError = error;
    });
    return Promise.resolve();
  }

  public recordRetry(id: string, error: string): Promise<void> {
    this.#patch(id, (job) => {
      job.status = "pending";
      job.startedAt = null;
      job.lastError = error;
    });
    return Promise.resolve();
  }

  #patch(id: string, update: (job: FakeJob) => void): void {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (job !== undefined) {
      update(job);
    }
  }
}

const NOW = new Date("2026-07-11T12:00:00.000Z");
const STALE_AFTER_MS = 60_000;

function pendingJob(
  id: string,
  apiSpecId: string,
  scope: DetectionJobScope | null = null,
): FakeJob {
  return {
    id,
    apiSpecId,
    status: "pending",
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    scope,
  };
}

interface RunSpy {
  readonly calls: string[];
  run: (apiSpecId: string) => Promise<void>;
}
function runSpy(behavior: (apiSpecId: string) => Promise<void>): RunSpy {
  const calls: string[] = [];
  return {
    calls,
    run: (apiSpecId) => {
      calls.push(apiSpecId);
      return behavior(apiSpecId);
    },
  };
}

function makeWorker(
  store: FakeJobStore,
  run: (apiSpecId: string) => Promise<void>,
  maxAttempts: number,
  runScopedDetection?: (job: ClaimedDetectionJob) => Promise<void>,
): DetectionWorker<FakeScope> {
  return new DetectionWorker<FakeScope>({
    scope: new FakeScope(),
    jobs: () => store,
    runDetection: run,
    ...(runScopedDetection !== undefined ? { runScopedDetection } : {}),
    maxAttempts,
    staleAfterMs: STALE_AFTER_MS,
    clock: () => NOW,
  });
}

const ADDITIVE_SCOPE: DetectionJobScope = {
  kind: "additive-delta",
  supersededSpecId: "spec-1-v1",
  newResourceGroups: ["invoices"],
  changedResources: [],
};

describe("DetectionWorker.runOnce", () => {
  it("claims a pending job, runs detection outside the tx, and marks it completed", async () => {
    const store = new FakeJobStore([pendingJob("job-1", "spec-1")]);
    const spy = runSpy(() => Promise.resolve());
    const worker = makeWorker(store, spy.run, 3);

    const result = await worker.runOnce();

    expect(result).toStrictEqual({ claimed: true, outcome: "completed" });
    expect(spy.calls).toStrictEqual(["spec-1"]);
    expect(store.jobs[0]?.status).toBe("completed");
    expect(store.jobs[0]?.attempts).toBe(1);
    expect(store.jobs[0]?.finishedAt).toStrictEqual(NOW);

    // Nothing left to claim on the next pass.
    expect(await worker.runOnce()).toStrictEqual({ claimed: false });
    expect(spy.calls).toHaveLength(1);
  });

  it("retries a failing run under the ceiling, then parks it as failed at the ceiling", async () => {
    const store = new FakeJobStore([pendingJob("job-1", "spec-1")]);
    const spy = runSpy(() => Promise.reject(new Error("detection boom")));
    const worker = makeWorker(store, spy.run, 2);

    const first = await worker.runOnce();
    expect(first).toStrictEqual({ claimed: true, outcome: "retry" });
    expect(store.jobs[0]?.status).toBe("pending");
    expect(store.jobs[0]?.attempts).toBe(1);
    expect(store.jobs[0]?.lastError).toBe("detection boom");

    const second = await worker.runOnce();
    expect(second).toStrictEqual({ claimed: true, outcome: "failed" });
    expect(store.jobs[0]?.status).toBe("failed");
    expect(store.jobs[0]?.attempts).toBe(2);
    expect(store.jobs[0]?.lastError).toBe("detection boom");

    // Parked → no longer claimable, and detection ran exactly twice.
    expect(await worker.runOnce()).toStrictEqual({ claimed: false });
    expect(spy.calls).toStrictEqual(["spec-1", "spec-1"]);
  });

  it("reclaims a stale running job (crash orphan) and re-runs its detection", async () => {
    const staleJob: FakeJob = {
      id: "job-1",
      apiSpecId: "spec-1",
      status: "running",
      attempts: 1,
      startedAt: new Date("2026-07-11T11:00:00.000Z"), // older than NOW - staleAfterMs
      finishedAt: null,
      lastError: null,
      scope: null,
    };
    const store = new FakeJobStore([staleJob]);
    const spy = runSpy(() => Promise.resolve());
    const worker = makeWorker(store, spy.run, 3);

    const result = await worker.runOnce();

    expect(result).toStrictEqual({ claimed: true, outcome: "completed" });
    expect(spy.calls).toStrictEqual(["spec-1"]);
    expect(store.jobs[0]?.status).toBe("completed");
    // Reclaim → re-claim bumped attempts from 1 to 2.
    expect(store.jobs[0]?.attempts).toBe(2);
  });

  it("routes a scoped job to the scoped runner (not full detection) and marks it completed", async () => {
    const store = new FakeJobStore([pendingJob("job-1", "spec-1-v2", ADDITIVE_SCOPE)]);
    const fullSpy = runSpy(() => Promise.resolve());
    const scopedCalls: ClaimedDetectionJob[] = [];
    const worker = makeWorker(store, fullSpy.run, 3, (job) => {
      scopedCalls.push(job);
      return Promise.resolve();
    });

    const result = await worker.runOnce();

    expect(result).toStrictEqual({ claimed: true, outcome: "completed" });
    // The scoped runner ran with the claimed job (incl. its scope); full detection did NOT.
    expect(fullSpy.calls).toHaveLength(0);
    expect(scopedCalls).toHaveLength(1);
    expect(scopedCalls[0]?.apiSpecId).toBe("spec-1-v2");
    expect(scopedCalls[0]?.scope).toStrictEqual(ADDITIVE_SCOPE);
    expect(store.jobs[0]?.status).toBe("completed");
  });

  it("surfaces (does not silently complete) a scoped job when no scoped runner is wired", async () => {
    const store = new FakeJobStore([pendingJob("job-1", "spec-1-v2", ADDITIVE_SCOPE)]);
    const fullSpy = runSpy(() => Promise.resolve());
    // No scoped runner wired, maxAttempts 1 → the misconfiguration parks the job `failed`.
    const worker = makeWorker(store, fullSpy.run, 1);

    const result = await worker.runOnce();

    expect(result).toStrictEqual({ claimed: true, outcome: "failed" });
    expect(fullSpy.calls).toHaveLength(0);
    expect(store.jobs[0]?.status).toBe("failed");
    expect(store.jobs[0]?.lastError).toContain("no scoped runner");
  });

  it("does not reclaim a running job that is still within the stale window", async () => {
    const freshJob: FakeJob = {
      id: "job-1",
      apiSpecId: "spec-1",
      status: "running",
      attempts: 1,
      startedAt: new Date("2026-07-11T11:59:30.000Z"), // newer than NOW - staleAfterMs
      finishedAt: null,
      lastError: null,
      scope: null,
    };
    const store = new FakeJobStore([freshJob]);
    const spy = runSpy(() => Promise.resolve());
    const worker = makeWorker(store, spy.run, 3);

    const result = await worker.runOnce();

    expect(result).toStrictEqual({ claimed: false });
    expect(spy.calls).toHaveLength(0);
    expect(store.jobs[0]?.status).toBe("running");
  });
});
