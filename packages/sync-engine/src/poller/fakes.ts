import type {
  ObservedRecord,
  PollAdvance,
  PollCandidateSource,
  PollCandidateView,
  PollPlanResolution,
  PollPlanResolver,
  PollRunOutcome,
  PollScope,
  PollSnapshotState,
  PollStateStore,
  PollerMetrics,
  SchedulerMetrics,
  SourceReader,
  DeltaOutcome,
  PageOutcome,
} from "./types.js";

/** The fake's cross-scope bucket key (mirrors the real store's `CROSS_SCOPE_SCOPE_KEY` sentinel). */
const CROSS_SCOPE = "__cross_scope__";

/** Compose the per-`(rule, scope)` bucket key the fakes store under; `undefined` = cross-scope. */
function scopedKey(ruleId: string, scopeKey: string | undefined): string {
  return `${ruleId}::${scopeKey ?? CROSS_SCOPE}`;
}

/**
 * In-memory fakes for the Scheduler + Poller unit tests (SP-1..SP-5). Each **mirrors**
 * the real component's contract ([[fakes-must-mirror-real-repos]]) so the sacred
 * invariants (SP-4 abort-on-partial, SP-5 enqueue-then-advance) are proven against the
 * same semantics the production wiring enforces — the `FakePollStateStore` advance is
 * atomic (mutates with no intervening `await`), the `FakeSourceReader` supports canned
 * pages + **injectable page failures**, and the plan resolver / candidate source are
 * plain configurable maps.
 */

// ── FakeSourceReader (canned pages/delta + injectable failures) ──────────────

/** One canned full-fetch page: either its records, or an injected failure (SP-4). */
export type FakePage = { readonly records: readonly ObservedRecord[] } | { readonly fail: string };

/** One canned delta batch: changed records + reported deletions + next cursor, or a failure. */
export type FakeDeltaBatch =
  | {
      readonly records?: readonly ObservedRecord[];
      readonly deletedNativeIds?: readonly string[];
      readonly nextCursor?: string;
    }
  | { readonly fail: string };

/**
 * A configurable {@link SourceReader}. Full-fetch pages are keyed by rule and served in
 * order via the opaque continuation the Poller hands back; delta batches are consumed
 * one per `readDelta` call. Either kind can inject a failure to drive SP-4's
 * abort-on-partial. An empty collection is one empty page (`{ records: [] }`).
 */
export class FakeSourceReader implements SourceReader {
  readonly #fullFetch = new Map<string, readonly FakePage[]>();
  readonly #delta = new Map<string, readonly FakeDeltaBatch[]>();
  readonly #deltaCalls = new Map<string, number>();
  /** Records every scope passed to a per-scope read, for asserting the container fill (SS-13.2). */
  public readonly scopeCalls: { ruleId: string; scopeLinkId: string; kind: "page" | "delta" }[] =
    [];

  /**
   * Configure the canned full-fetch pages for a rule (served in order, to exhaustion).
   * SS-13 — pass `scopeLinkId` to configure a **per-scope** container's pages; omit it
   * for the cross-scope read. So one fake serves both a cross-scope rule and a per-scope
   * rule's several containers independently.
   */
  public setFullFetch(ruleId: string, pages: readonly FakePage[], scopeLinkId?: string): void {
    this.#fullFetch.set(scopedKey(ruleId, scopeLinkId), pages);
  }

  /** Configure the canned delta batches for a rule/scope (one consumed per `readDelta` call). */
  public setDelta(ruleId: string, batches: readonly FakeDeltaBatch[], scopeLinkId?: string): void {
    const key = scopedKey(ruleId, scopeLinkId);
    this.#delta.set(key, batches);
    this.#deltaCalls.set(key, 0);
  }

  public readCollectionPage(
    ruleId: string,
    continuation: string | undefined,
    scope?: PollScope,
  ): Promise<PageOutcome> {
    if (scope !== undefined) {
      this.scopeCalls.push({ ruleId, scopeLinkId: scope.scopeLinkId, kind: "page" });
    }
    const pages = this.#fullFetch.get(scopedKey(ruleId, scope?.scopeLinkId));
    if (pages === undefined) {
      return Promise.resolve({ ok: false, reason: `no full-fetch config for ${ruleId}` });
    }
    const index = continuation === undefined ? 0 : Number(continuation);
    const page = pages[index];
    if (page === undefined) {
      return Promise.resolve({ ok: false, reason: `page ${String(index)} out of range` });
    }
    if ("fail" in page) {
      return Promise.resolve({ ok: false, reason: page.fail });
    }
    const isLast = index >= pages.length - 1;
    return Promise.resolve({
      ok: true,
      records: page.records,
      next: isLast ? { done: true } : { done: false, continuation: String(index + 1) },
    });
  }

  public readDelta(
    ruleId: string,
    _cursor: string | undefined,
    scope?: PollScope,
  ): Promise<DeltaOutcome> {
    if (scope !== undefined) {
      this.scopeCalls.push({ ruleId, scopeLinkId: scope.scopeLinkId, kind: "delta" });
    }
    const key = scopedKey(ruleId, scope?.scopeLinkId);
    const batches = this.#delta.get(key);
    if (batches === undefined) {
      return Promise.resolve({ ok: false, reason: `no delta config for ${ruleId}` });
    }
    const call = this.#deltaCalls.get(key) ?? 0;
    // Past the configured batches, report an empty (no-change) batch that keeps the cursor.
    const batch = batches[call] ?? {};
    this.#deltaCalls.set(key, call + 1);
    if ("fail" in batch) {
      return Promise.resolve({ ok: false, reason: batch.fail });
    }
    return Promise.resolve({
      ok: true,
      records: batch.records ?? [],
      deletedNativeIds: batch.deletedNativeIds ?? [],
      nextCursor: batch.nextCursor,
    });
  }
}

// ── FakePollPlanResolver ─────────────────────────────────────────────────────

/** A plan resolver backed by a plain map: `set(ruleId, resolution)` then `resolve(ruleId)`. */
export class FakePollPlanResolver implements PollPlanResolver {
  readonly #plans = new Map<string, PollPlanResolution>();

  public set(ruleId: string, resolution: PollPlanResolution): void {
    this.#plans.set(ruleId, resolution);
  }

  public resolve(ruleId: string): Promise<PollPlanResolution> {
    return Promise.resolve(
      this.#plans.get(ruleId) ?? { pollable: false, reason: "rule-not-found" },
    );
  }
}

// ── FakePollStateStore (atomic advance mirror) ───────────────────────────────

/** The mutable per-rule state the fake tracks (tests assert against it). */
export interface FakePollState {
  snapshotRef: string | undefined;
  entries: Map<string, string>;
  cursor: string | undefined;
  lastRunAt: Date | undefined;
  advanceCount: number;
}

/**
 * An in-memory {@link PollStateStore} whose {@link advance} is **atomic** — it mutates
 * cursor/snapshot/`lastRunAt` synchronously with no intervening `await`, mirroring the
 * real `DbPollStateStore`'s single-transaction advance. {@link throwOnNextAdvance}
 * simulates a **crash before the advance** (SP-5): it throws *before* any mutation, so
 * the state is left exactly as if the advance never ran — the next poll re-detects.
 */
export class FakePollStateStore implements PollStateStore {
  // Keyed per-`(rule, scope)` (SS-13.3): `undefined` scope = the cross-scope bucket, a
  // `scopeLinkId` = that scope's bucket, so a per-scope advance/abort never touches
  // another scope's — nor the cross-scope — state (the isolation invariant to test).
  readonly #state = new Map<string, FakePollState>();
  // The rule-level `SyncRule.lastRunAt` (SP-1 due-ness), separate from every `(rule, scope)`
  // bucket — the real store writes it to `sync_rule`, not to any scope's row.
  readonly #ruleLastRunAt = new Map<string, Date>();
  #snapshotIds = 0;
  readonly #throwOn = new Set<string>();

  /** Seed a rule/scope's prior snapshot (full-fetch diff tests). `scopeKey` omitted = cross-scope. */
  public seedSnapshot(
    ruleId: string,
    entries: ReadonlyMap<string, string>,
    scopeKey?: string,
  ): void {
    this.#snapshotIds += 1;
    this.#state.set(scopedKey(ruleId, scopeKey), {
      snapshotRef: `snap-${String(this.#snapshotIds)}`,
      entries: new Map(entries),
      cursor: undefined,
      lastRunAt: undefined,
      advanceCount: 0,
    });
  }

  /** Seed a delta rule/scope's stored cursor (delta advance tests). */
  public seedCursor(ruleId: string, cursor: string, scopeKey?: string): void {
    const state = this.#ensure(scopedKey(ruleId, scopeKey));
    state.cursor = cursor;
  }

  /**
   * Make the NEXT `advance` for a given `(rule, scope)` throw before mutating
   * (crash-before-advance, SP-5) — scoped so one scope's failure can be injected without
   * touching the others (per-scope isolation tests). `scopeKey` omitted = cross-scope.
   */
  public throwOnNextAdvance(ruleId?: string, scopeKey?: string): void {
    this.#throwOn.add(ruleId === undefined ? "*" : scopedKey(ruleId, scopeKey));
  }

  public loadSnapshot(ruleId: string, scopeKey?: string): Promise<PollSnapshotState | undefined> {
    const state = this.#state.get(scopedKey(ruleId, scopeKey));
    if (state === undefined || state.snapshotRef === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ snapshotRef: state.snapshotRef, entries: new Map(state.entries) });
  }

  public loadScopeCursor(ruleId: string, scopeKey: string): Promise<string | undefined> {
    return Promise.resolve(this.#state.get(scopedKey(ruleId, scopeKey))?.cursor);
  }

  public advance(advance: PollAdvance): Promise<void> {
    const key = scopedKey(advance.ruleId, advance.scopeKey);
    if (this.#throwOn.has("*") || this.#throwOn.has(key)) {
      this.#throwOn.delete("*");
      this.#throwOn.delete(key);
      // Throw BEFORE any mutation: the advance did not happen (crash-before-advance).
      return Promise.reject(new Error("simulated crash before advance"));
    }
    // Atomic: all fields move together, no `await` between them (mirrors the real tx).
    const state = this.#ensure(key);
    if (advance.snapshotEntries !== undefined) {
      if (state.snapshotRef === undefined) {
        this.#snapshotIds += 1;
        state.snapshotRef = `snap-${String(this.#snapshotIds)}`;
      }
      state.entries = new Map(advance.snapshotEntries);
    }
    if (advance.cursor !== undefined) {
      state.cursor = advance.cursor;
    }
    state.lastRunAt = advance.lastRunAt;
    state.advanceCount += 1;
    return Promise.resolve();
  }

  /**
   * SS-13.3 — the rule-level `lastRunAt` stamp a per-scope fan-out makes. Mirrors the real
   * store, which updates only `sync_rule.last_run_at`: it is tracked in its OWN map, not in
   * any `(rule, scope)` bucket, so a per-scope run still leaves the cross-scope bucket
   * absent (`stateOf(ruleId)` stays `undefined`) — the per-scope isolation invariant.
   */
  public advanceRuleRun(ruleId: string, lastRunAt: Date): Promise<void> {
    this.#ruleLastRunAt.set(ruleId, lastRunAt);
    return Promise.resolve();
  }

  /** The rule-level `SyncRule.lastRunAt` the Scheduler's due-ness gate reads (SP-1; tests). */
  public ruleLastRunAt(ruleId: string): Date | undefined {
    return this.#ruleLastRunAt.get(ruleId);
  }

  /** The current state for a rule/scope (tests). `scopeKey` omitted = cross-scope. */
  public stateOf(ruleId: string, scopeKey?: string): FakePollState | undefined {
    return this.#state.get(scopedKey(ruleId, scopeKey));
  }

  #ensure(key: string): FakePollState {
    let state = this.#state.get(key);
    if (state === undefined) {
      state = {
        snapshotRef: undefined,
        entries: new Map(),
        cursor: undefined,
        lastRunAt: undefined,
        advanceCount: 0,
      };
      this.#state.set(key, state);
    }
    return state;
  }
}

// ── FakePollCandidateSource + metric recorders ───────────────────────────────

/** A candidate source backed by a mutable list (the Scheduler's `listPollCandidates`). */
export class FakePollCandidateSource implements PollCandidateSource {
  public candidates: PollCandidateView[] = [];

  public constructor(candidates: PollCandidateView[] = []) {
    this.candidates = candidates;
  }

  public listPollCandidates(): Promise<PollCandidateView[]> {
    return Promise.resolve([...this.candidates]);
  }
}

/** Records poller-lag + stuck-poller signals for assertions (SP-1.5). */
export class FakeSchedulerMetrics implements SchedulerMetrics {
  public readonly lag: { ruleId: string; lagMs: number; intervalMs: number }[] = [];
  public readonly stuck: { ruleId: string; lagMs: number; intervalMs: number }[] = [];

  public recordPollerLag(ruleId: string, lagMs: number, intervalMs: number): void {
    this.lag.push({ ruleId, lagMs, intervalMs });
  }

  public recordStuckPoller(ruleId: string, lagMs: number, intervalMs: number): void {
    this.stuck.push({ ruleId, lagMs, intervalMs });
  }
}

/** Records poll-run outcomes for assertions. */
export class FakePollerMetrics implements PollerMetrics {
  public readonly runs: { ruleId: string; outcome: PollRunOutcome }[] = [];

  public recordPollRun(ruleId: string, outcome: PollRunOutcome): void {
    this.runs.push({ ruleId, outcome });
  }
}
