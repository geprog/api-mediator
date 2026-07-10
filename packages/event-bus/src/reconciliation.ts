/**
 * The reconciliation sweep: the mechanism that makes "bus loss degrades
 * timeliness, never correctness" true (overview.md *Event Bus*). Because every
 * event is re-derivable from persisted state, a periodic sweep compares persisted
 * state against what should have been derived from it and re-triggers any missing
 * reaction — so a delivery the bus dropped is eventually recovered.
 *
 * This module is the **framework** only. Phase 1 registers no real reconcilers:
 * there is no downstream reaction to reconcile yet (mapping detection is Phase 2).
 * The concrete reconcilers plug in later at their composition roots via
 * {@link ReconciliationSweep.register} — see the `Phase 2+` note there.
 */

/**
 * One reconciler: finds persisted state that is missing its derived reaction and
 * re-emits / re-triggers it. `reconcile()` takes no arguments — a reconciler
 * closes over its own dependencies (repositories, the `EventBus`) at construction
 * — so the sweep stays agnostic of what any reconciler does.
 */
export interface Reconciler {
  readonly name: string;
  reconcile(): Promise<void>;
}

/** The result of running one reconciler within a sweep. */
export interface ReconcilerOutcome {
  readonly name: string;
  readonly status: "ok" | "error";
  /** Present only when `status` is `"error"`: the error the reconciler threw. */
  readonly error?: unknown;
}

/** The result of one {@link ReconciliationSweep.runSweep} pass. */
export interface ReconciliationSweepResult {
  readonly outcomes: readonly ReconcilerOutcome[];
}

/** Thrown when two reconcilers share a `name`. */
export class DuplicateReconcilerError extends Error {
  public constructor(name: string) {
    super(`A reconciler named "${name}" is already registered.`);
    this.name = "DuplicateReconcilerError";
  }
}

/**
 * Runs a set of registered {@link Reconciler}s. `runSweep` isolates failures: one
 * reconciler throwing is recorded as an `error` outcome and does not stop the
 * others, so a single broken derivation can't block the rest of the sweep.
 */
export class ReconciliationSweep {
  readonly #reconcilers = new Map<string, Reconciler>();

  /**
   * Register a reconciler.
   *
   * Phase 2+: this is where real reconcilers plug in — e.g. the "ingested
   * `ApiSpec` with no mapping-analysis run" reconciler (Phase 2) and the
   * "approved mapping with no `SyncRule`/`AdapterBinding`/`GraphEdge`" reconciler
   * (Phase 3+). A composition root constructs each with its repositories + the
   * `EventBus` and registers it here. Phase 1 registers none.
   */
  public register(reconciler: Reconciler): void {
    if (this.#reconcilers.has(reconciler.name)) {
      throw new DuplicateReconcilerError(reconciler.name);
    }
    this.#reconcilers.set(reconciler.name, reconciler);
  }

  /** Run every registered reconciler, collecting per-reconciler outcomes. */
  public async runSweep(): Promise<ReconciliationSweepResult> {
    const outcomes: ReconcilerOutcome[] = [];
    for (const reconciler of this.#reconcilers.values()) {
      try {
        await reconciler.reconcile();
        outcomes.push({ name: reconciler.name, status: "ok" });
      } catch (error) {
        outcomes.push({ name: reconciler.name, status: "error", error });
      }
    }
    return { outcomes };
  }
}
