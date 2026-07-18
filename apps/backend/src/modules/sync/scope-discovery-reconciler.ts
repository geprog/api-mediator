import type { ScopeCorrespondence, SyncRule } from "@mediator/domain";
import type { ScopeLinkStore } from "@mediator/db";

/**
 * **The scope-discovery reconciler** (SS-11.7) — the container analog of the
 * sync-execution reconciler's RS-1 backfill re-trigger
 * (`docs/requirements/scoped-resource-sync.md` SS-11.7;
 * `docs/architecture/sync-engine.md` *Reconciliation*). Container discovery is
 * **enablement-time + on-demand + sweep + manual — NOT a second continuous scheduler**;
 * this is the *sweep* leg: on each reconciliation pass it re-triggers a lost / crashed
 * enablement discovery pass. It is structurally a `Reconciler` (`readonly name` +
 * `reconcile()`), registered on the SHARED reconciliation sweep alongside the
 * `SyncExecutionReconciler` — it does **not** run its own loop.
 *
 * ## Detecting a "lost pass" (a judgment call, documented)
 *
 * SS-11 adds no persisted discovery-status column (that would be a migration, deferred),
 * so — unlike RS-1's precise `backfillStatus = running` + not-in-flight crash signal —
 * "lost" is re-derived from persisted state: a pair is re-triggered when
 *  1. an **enabled** rule references it (a bounded scan, deduped per pair),
 *  2. its `ScopeCorrespondence` is **confirmed** (discovery is viable), and
 *  3. it has **no active `ScopeLink`s yet** (no pass has successfully established one),
 *  4. and no discovery pass is currently **in flight** for it.
 *
 * The re-triggered pass is **idempotent** (establish is idempotent + conflict-guarded), so
 * re-running is safe (RS-1.5). Because condition (3) stops re-triggering once **any** link
 * exists, a converged pair is not re-enumerated every sweep — the sweep is not a second
 * scheduler; a truly-empty both-enumerable pair keeps being retried (the desired "keep
 * trying to discover" behavior), bounded by the enumeration + the sweep cadence.
 */
export const SCOPE_DISCOVERY_RECONCILER_NAME = "scope-discovery";

/** The bounded enabled-rule reader (the real `SyncRuleRepository.listEnabledForReconciliation`). */
export interface EnabledRuleReader {
  listEnabledForReconciliation(limit: number): Promise<readonly SyncRule[]>;
}

/** Re-run the enablement discovery pass for a pair (bracketed in-flight by the real impl). */
export interface ScopeDiscoveryRetrigger {
  retriggerDiscovery(resourcePairRef: string): Promise<void>;
}

/** Whether a discovery pass for a pair is being actively run by THIS process right now. */
export interface ScopeDiscoveryInFlightTracker {
  isDiscoveryInFlight(resourcePairRef: string): boolean;
}

/** Whether a pair still needs a discovery pass (confirmed correspondence + no active links). */
export interface ScopeDiscoveryReadiness {
  needsDiscovery(resourcePairRef: string): Promise<boolean>;
}

/** Optional metrics (default no-op) — counts/ids only, never a live value. */
export interface ScopeDiscoveryReconcilerMetrics {
  recordEvaluated(scopedPairCount: number): void;
  recordRetriggered(resourcePairRef: string): void;
}

export interface ScopeDiscoveryReconcilerDeps {
  readonly rules: EnabledRuleReader;
  readonly retrigger: ScopeDiscoveryRetrigger;
  readonly inFlight: ScopeDiscoveryInFlightTracker;
  readonly readiness: ScopeDiscoveryReadiness;
  readonly metrics?: ScopeDiscoveryReconcilerMetrics;
}

export interface ScopeDiscoveryReconcilerOptions {
  /** The bound on enabled rules scanned per pass (never replays history). */
  readonly limit?: number;
}

export const DEFAULT_SCOPE_DISCOVERY_RECONCILE_LIMIT = 500;

const NOOP_METRICS: ScopeDiscoveryReconcilerMetrics = {
  recordEvaluated: (): void => {},
  recordRetriggered: (): void => {},
};

export class ScopeDiscoveryReconciler {
  public readonly name = SCOPE_DISCOVERY_RECONCILER_NAME;
  readonly #rules: EnabledRuleReader;
  readonly #retrigger: ScopeDiscoveryRetrigger;
  readonly #inFlight: ScopeDiscoveryInFlightTracker;
  readonly #readiness: ScopeDiscoveryReadiness;
  readonly #metrics: ScopeDiscoveryReconcilerMetrics;
  readonly #limit: number;

  public constructor(
    deps: ScopeDiscoveryReconcilerDeps,
    options: ScopeDiscoveryReconcilerOptions = {},
  ) {
    this.#rules = deps.rules;
    this.#retrigger = deps.retrigger;
    this.#inFlight = deps.inFlight;
    this.#readiness = deps.readiness;
    this.#metrics = deps.metrics ?? NOOP_METRICS;
    this.#limit = options.limit ?? DEFAULT_SCOPE_DISCOVERY_RECONCILE_LIMIT;
  }

  /**
   * One reconciliation pass (SS-11.7): scan the bounded set of enabled rules, dedupe by
   * pair, and re-trigger the enablement discovery pass for each pair that still needs one
   * and is not already in flight. Everything else is left untouched (idempotent).
   */
  public async reconcile(): Promise<void> {
    const rules = await this.#rules.listEnabledForReconciliation(this.#limit);
    const seen = new Set<string>();
    let scopedPairs = 0;
    for (const rule of rules) {
      const pair = rule.resourcePairRef;
      if (seen.has(pair)) {
        continue;
      }
      seen.add(pair);
      if (this.#inFlight.isDiscoveryInFlight(pair)) {
        continue;
      }
      if (!(await this.#readiness.needsDiscovery(pair))) {
        continue;
      }
      scopedPairs += 1;
      await this.#retrigger.retriggerDiscovery(pair);
      this.#metrics.recordRetriggered(pair);
    }
    this.#metrics.recordEvaluated(scopedPairs);
  }
}

// ── Real readiness + in-flight registry (also the test doubles) ────────────────

/** The narrow reads {@link RepoScopeDiscoveryReadiness} needs. */
export interface ScopeDiscoveryReadinessDeps {
  readonly correspondences: {
    getByResourcePair(resourcePairRef: string): Promise<ScopeCorrespondence | undefined>;
  };
  readonly links: Pick<ScopeLinkStore, "listByCorrespondence">;
}

/**
 * The repo-backed {@link ScopeDiscoveryReadiness}: a pair needs discovery when its
 * `ScopeCorrespondence` is **confirmed** and no **active** `ScopeLink` exists under it yet
 * (no pass has successfully established one). An archived-only correspondence still counts
 * as "no active links".
 */
export class RepoScopeDiscoveryReadiness implements ScopeDiscoveryReadiness {
  readonly #deps: ScopeDiscoveryReadinessDeps;

  public constructor(deps: ScopeDiscoveryReadinessDeps) {
    this.#deps = deps;
  }

  public async needsDiscovery(resourcePairRef: string): Promise<boolean> {
    const correspondence = await this.#deps.correspondences.getByResourcePair(resourcePairRef);
    if (
      correspondence === undefined ||
      correspondence.confirmedBy === null ||
      correspondence.confirmedAt === null
    ) {
      return false;
    }
    const links = await this.#deps.links.listByCorrespondence(correspondence.id);
    return !links.some((link) => link.status === "active");
  }
}

/**
 * The single-instance {@link ScopeDiscoveryInFlightTracker}: the set of pair refs whose
 * discovery pass this process is actively running. The retrigger marks a pair in flight
 * before running and clears it in a `finally`, so the reconciler can tell a live pass from
 * a crash-orphaned one. After a restart the set is empty — every persisted "needs
 * discovery" pair is correctly seen as re-triggerable.
 */
export class InMemoryScopeDiscoveryInFlightRegistry implements ScopeDiscoveryInFlightTracker {
  readonly #inFlight = new Set<string>();

  public markInFlight(resourcePairRef: string): void {
    this.#inFlight.add(resourcePairRef);
  }

  public clear(resourcePairRef: string): void {
    this.#inFlight.delete(resourcePairRef);
  }

  public isDiscoveryInFlight(resourcePairRef: string): boolean {
    return this.#inFlight.has(resourcePairRef);
  }
}
