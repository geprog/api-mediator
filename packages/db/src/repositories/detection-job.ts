import { and, eq, lt, notExists, sql } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  apiSpec,
  mappingDetectionJob,
  type DetectionJobScope,
  type DetectionJobStatus,
} from "../schema.js";

/**
 * The durable `mapping_detection_job` record in domain-facing shape. Infrastructure
 * (durability/scheduling), not a glossary entity — so it lives here in `@mediator/db`
 * next to its table, like `OutboxRecord`.
 */
export interface DetectionJob {
  readonly id: string;
  readonly apiSpecId: string;
  readonly status: DetectionJobStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** `null` for a full detection job (DT-1/DT-2); a scope descriptor for a scoped job (SL-3/SL-6/SL-9). */
  readonly scope: DetectionJobScope | null;
}

/** The minimum a worker needs about a job it just claimed. */
export interface ClaimedDetectionJob {
  readonly id: string;
  readonly apiSpecId: string;
  /** The **post-increment** attempt count (the claim bumped `attempts`). */
  readonly attempts: number;
  /**
   * `null` → a **full** detection job (the worker runs `runDetectionForSpec`); a
   * {@link DetectionJobScope} → a **scoped** job (SL-3 additive delta, SL-6 re-review,
   * SL-9 re-inclusion), whose `kind` selects the scoped analysis the worker runs over
   * the descriptor's elements.
   */
  readonly scope: DetectionJobScope | null;
}

/**
 * The enqueue operation the `SpecIngested` consumer drives, bound to one
 * transaction handle. A narrow interface (rather than the whole
 * {@link DetectionJobRepository}) so the consumer is unit-testable against an
 * in-memory fake.
 */
export interface DetectionJobEnqueueOps {
  /**
   * Record intent to run detection for `apiSpecId`, idempotently. A no-op when the
   * spec already has an un-finished (`pending`/`running`) job — the partial UNIQUE
   * index + `ON CONFLICT DO NOTHING` collapse a redelivered event or a concurrent
   * reconciler enqueue to a single job.
   */
  enqueue(apiSpecId: string): Promise<void>;
  /**
   * Record intent to run a **scoped** analysis for `apiSpecId`, carrying the
   * {@link DetectionJobScope} descriptor, idempotently under the same partial UNIQUE
   * index as {@link enqueue}: a redelivered ingest / a re-derivation collapses to one
   * job, so the scoped proposal is produced once (SL-3.5). Recorded inside the
   * transaction that caused it — the additive version-advance (SL-3/SL-6) or the
   * `analysisExclusions` replace (SL-9 re-inclusion).
   */
  enqueueScoped(apiSpecId: string, scope: DetectionJobScope): Promise<void>;
}

/**
 * The claim/complete/fail/reclaim operations the {@link DetectionWorker} drives,
 * bound to one transaction handle. A narrow interface so the worker is
 * unit-testable against an in-memory fake that mirrors these semantics.
 */
export interface DetectionJobWorkerOps {
  /**
   * Return any `running` job whose `started_at` is older than `olderThan` to
   * `pending` (a crashed worker left it `running`), so it is re-claimed and the
   * detection re-runs. Returns how many were reclaimed.
   */
  reclaimStale(olderThan: Date): Promise<number>;
  /**
   * Claim the oldest `pending` job with `FOR UPDATE SKIP LOCKED` (concurrent
   * workers never take the same row), flip it to `running`, stamp `started_at`, and
   * bump `attempts`. Must run inside a transaction; the lock is held until it
   * commits. Returns `undefined` when no job is claimable.
   */
  claimNext(now: Date): Promise<ClaimedDetectionJob | undefined>;
  /** Mark a claimed job `completed` (the detection run finished). */
  markCompleted(id: string, finishedAt: Date): Promise<void>;
  /**
   * Park a job as `failed` after it exhausted the worker's attempt ceiling —
   * surfaced for an operator, never silently retried further.
   */
  markFailed(id: string, error: string, finishedAt: Date): Promise<void>;
  /**
   * Return a claimed job to `pending` after a failed run that is still under the
   * ceiling, recording `last_error`, so it is re-claimed and retried. `attempts`
   * was already bumped by the claim.
   */
  recordRetry(id: string, error: string): Promise<void>;
}

function mapRow(row: typeof mappingDetectionJob.$inferSelect): DetectionJob {
  return {
    id: row.id,
    apiSpecId: row.apiSpecId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    scope: row.scope ?? null,
  };
}

/**
 * Persistence for the `mapping_detection_job` durable-job table. Constructor-bound
 * to a {@link DbHandle} (the pooled db or a `tx()` transaction), matching the repo
 * convention. It implements the two narrow ops interfaces the consumer and worker
 * depend on, plus the reconciler's "active specs with no detection job" query and
 * a `listByStatus` read for observability/tests.
 */
export class DetectionJobRepository implements DetectionJobEnqueueOps, DetectionJobWorkerOps {
  public constructor(private readonly db: DbHandle) {}

  public async enqueue(apiSpecId: string): Promise<void> {
    // `ON CONFLICT DO NOTHING` (no target) collapses the partial-unique violation
    // when a `pending`/`running` job already exists for the spec — idempotent.
    await this.db
      .insert(mappingDetectionJob)
      .values({ apiSpecId, status: "pending" })
      .onConflictDoNothing();
  }

  public async enqueueScoped(apiSpecId: string, scope: DetectionJobScope): Promise<void> {
    // Same idempotency as {@link enqueue} — the partial UNIQUE index over
    // `(api_spec_id) WHERE status in ('pending','running')` collapses a redelivered
    // ingest / a re-derivation to one job, so the scoped delta proposal is produced
    // once (SL-3.5). The only difference from a full job is the carried `scope`.
    await this.db
      .insert(mappingDetectionJob)
      .values({ apiSpecId, status: "pending", scope })
      .onConflictDoNothing();
  }

  public async reclaimStale(olderThan: Date): Promise<number> {
    const rows = await this.db
      .update(mappingDetectionJob)
      .set({
        status: "pending",
        startedAt: null,
        lastError: "reclaimed: worker did not finish before the stale timeout",
      })
      .where(
        and(
          eq(mappingDetectionJob.status, "running"),
          lt(mappingDetectionJob.startedAt, olderThan),
        ),
      )
      .returning({ id: mappingDetectionJob.id });
    return rows.length;
  }

  public async claimNext(now: Date): Promise<ClaimedDetectionJob | undefined> {
    const [row] = await this.db
      .select({
        id: mappingDetectionJob.id,
        apiSpecId: mappingDetectionJob.apiSpecId,
        attempts: mappingDetectionJob.attempts,
        scope: mappingDetectionJob.scope,
      })
      .from(mappingDetectionJob)
      .where(eq(mappingDetectionJob.status, "pending"))
      .orderBy(mappingDetectionJob.createdAt, mappingDetectionJob.id)
      .limit(1)
      .for("update", { skipLocked: true });
    if (row === undefined) {
      return undefined;
    }
    const attempts = row.attempts + 1;
    await this.db
      .update(mappingDetectionJob)
      .set({ status: "running", startedAt: now, attempts })
      .where(eq(mappingDetectionJob.id, row.id));
    return { id: row.id, apiSpecId: row.apiSpecId, attempts, scope: row.scope ?? null };
  }

  public async markCompleted(id: string, finishedAt: Date): Promise<void> {
    await this.db
      .update(mappingDetectionJob)
      .set({ status: "completed", finishedAt })
      .where(eq(mappingDetectionJob.id, id));
  }

  public async markFailed(id: string, error: string, finishedAt: Date): Promise<void> {
    await this.db
      .update(mappingDetectionJob)
      .set({ status: "failed", finishedAt, lastError: error })
      .where(eq(mappingDetectionJob.id, id));
  }

  public async recordRetry(id: string, error: string): Promise<void> {
    await this.db
      .update(mappingDetectionJob)
      .set({ status: "pending", startedAt: null, lastError: error })
      .where(eq(mappingDetectionJob.id, id));
  }

  /** Every job in a given lifecycle state (observability / tests). */
  public async listByStatus(status: DetectionJobStatus): Promise<DetectionJob[]> {
    const rows = await this.db
      .select()
      .from(mappingDetectionJob)
      .where(eq(mappingDetectionJob.status, status));
    return rows.map(mapRow);
  }

  /**
   * The ids of `active` specs that have **no** `mapping_detection_job` at all — the
   * reconciliation sweep's "an ingested spec with no analysis run" derivation
   * (DT-2). A job in *any* status (including a `completed` job that produced zero
   * proposals — the first-spec-in-the-landscape case — or a `failed` one) means
   * analysis was already run/attempted, so it is deliberately NOT re-triggered: a
   * recorded outcome is an analysis result, not an absence.
   */
  public async listActiveSpecIdsWithoutDetectionJob(): Promise<string[]> {
    const rows = await this.db
      .select({ id: apiSpec.id })
      .from(apiSpec)
      .where(
        and(
          eq(apiSpec.status, "active"),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(mappingDetectionJob)
              .where(eq(mappingDetectionJob.apiSpecId, apiSpec.id)),
          ),
        ),
      );
    return rows.map((row) => row.id);
  }
}
