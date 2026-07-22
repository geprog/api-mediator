import {
  ApiSpecRepository,
  type Database,
  type DbHandle,
  MappingProposalRepository,
  tx,
} from "@mediator/db";
import type { ApiSpec, MappingProposal, MappingProposalItem } from "@mediator/domain";

import { type CandidateAnalysisResult, type DetectionDeps, detectForSpec } from "./detection.js";
import { type CandidateSpecPair, enumerateCandidatePairs } from "./enumerate.js";
import {
  type AdditiveAnalysisScope,
  type EstablishedResourcePair,
  analyzeAdditiveDelta,
} from "./scoped.js";

/**
 * The thin **persisting** wrapper over the pure detection core (`detection.ts`).
 * `runDetectionForSpec` enumerates + analyzes + persists all proposals for a
 * newly ingested spec; the detection itself is the eval-harness-testable pure path
 * (`detectForSpec` / `analyzeCandidate`). Persistence goes through the injected
 * {@link SpecSource} + {@link ProposalStore} seams so unit tests use in-memory
 * fakes that mirror the real repos and the integration test uses real Postgres
 * ([[fakes-must-mirror-real-repos]]).
 */

/** Reads the registry state enumeration needs — mirrors `ApiSpecRepository`. */
export interface SpecSource {
  getById(id: string): Promise<ApiSpec | undefined>;
  /** Every `active` spec across the landscape (the eligible counterpart set). */
  listActive(): Promise<ApiSpec[]>;
}

/** One proposal together with its items, as produced by a directional analysis. */
export interface PersistableProposal {
  readonly proposal: MappingProposal;
  readonly items: readonly MappingProposalItem[];
}

/**
 * Persists **all** of one detection run's proposals (each with its items) in a
 * SINGLE transaction — all-or-nothing. Atomicity is what makes a re-run safe: a
 * DB fault or crash partway through commits **nothing**, so the worker's retry /
 * stale-reclaim re-runs `runDetectionForSpec` and produces the run's proposals
 * exactly once, never appending duplicates for pairs a partial run had already
 * committed (DT-2 crit 3).
 */
export interface ProposalStore {
  persistAll(proposals: readonly PersistableProposal[]): Promise<void>;
}

/** The full dependency set the persisting entry point needs. */
export interface RunDetectionDeps extends DetectionDeps {
  readonly specSource: SpecSource;
  readonly proposalStore: ProposalStore;
}

export interface DetectionRunResult {
  readonly newSpecId: string;
  readonly analyses: readonly CandidateAnalysisResult[];
}

/**
 * Enumerate, analyze, and **persist** every proposal for a newly ingested spec —
 * the `SpecIngested`-triggered entry point. Fetches the new spec + the active
 * counterpart set, runs the two-stage detection (`detectForSpec`), and persists
 * all of its directional proposals (pending or failed) with their items in **one
 * atomic** `persistAll`. Persistence happens after analysis so a persistence error
 * never leaves a half-analyzed run, and is all-or-nothing so a fault mid-persist
 * leaves nothing to duplicate on the worker's retry (DT-2 crit 3).
 */
export async function runDetectionForSpec(
  specId: string,
  deps: RunDetectionDeps,
): Promise<DetectionRunResult> {
  const newSpec = await deps.specSource.getById(specId);
  if (newSpec === undefined) {
    throw new Error(`runDetectionForSpec: no ApiSpec with id ${specId}`);
  }

  const active = await deps.specSource.listActive();
  const otherActiveSpecs = active.filter((spec) => spec.id !== specId);

  const analyses = await detectForSpec(newSpec, otherActiveSpecs, deps);
  await deps.proposalStore.persistAll(
    analyses.map((analysis) => ({ proposal: analysis.proposal, items: analysis.items })),
  );

  return { newSpecId: specId, analyses };
}

// ── Default DB-backed adapters ───────────────────────────────────────────────

/** A {@link SpecSource} over `ApiSpecRepository` bound to a db handle. */
export function createDbSpecSource(db: DbHandle): SpecSource {
  const repo = new ApiSpecRepository(db);
  return {
    getById: (id) => repo.getById(id),
    listActive: () => repo.listActive(),
  };
}

/**
 * A {@link ProposalStore} that persists a whole run's proposals + items in **one**
 * transaction via `MappingProposalRepository.create` on the shared handle — so the
 * run's writes commit together or not at all. A failure on any proposal rolls the
 * whole batch back (`tx` re-throws → Drizzle rolls back), leaving no partial set.
 */
export function createDbProposalStore(db: Database): ProposalStore {
  return {
    persistAll: (proposals) =>
      tx(db, async (txn) => {
        const repo = new MappingProposalRepository(txn);
        for (const { proposal, items } of proposals) {
          await repo.create(proposal, [...items]);
        }
      }),
  };
}

// ── SL-3 scoped additive-delta analysis (persisting, worker-triggered) ─────────

/**
 * Reads the prior proposals a scoped analysis needs to find the **already-shortlisted**
 * resource pairs a changed resource belongs to (SL-3.2). `listForSpecPair` returns every
 * proposal for the unordered pair {specIdA, specIdB} in either direction — their
 * `shortlistResult.candidatePairs` are the established correspondences the detail-only
 * call re-analyzes.
 */
export interface PriorProposalSource {
  listForSpecPair(specIdA: string, specIdB: string): Promise<MappingProposal[]>;
}

/** The scoped-analysis job the worker hands to {@link runScopedAdditiveAnalysis}. */
export interface ScopedAnalysisJob {
  /** The newly-ingested (now-`active`) additive version to analyze the delta of. */
  readonly newSpecId: string;
  /** The prior (now-`superseded`) version, whose established shortlists SL-3.2 reuses. */
  readonly supersededSpecId: string;
  /** The structural scope the additive diff produced (SL-3.1 groups / SL-3.2 changed resources). */
  readonly scope: AdditiveAnalysisScope;
}

/** The dependency set the scoped-analysis entry point needs. */
export interface RunScopedDeps extends DetectionDeps {
  readonly specSource: SpecSource;
  readonly proposalStore: ProposalStore;
  readonly priorProposals: PriorProposalSource;
}

/**
 * **SL-3.2 — the established resource pairs a changed resource belongs to**, read out of
 * the prior proposals' `shortlistResult`. A proposal's `candidatePairs` are stored in the
 * shortlist's **canonical** orientation (specs ordered by id), so this resolves which side
 * is the new lineage from `supersededSpecId <= counterpartSpecId` — matching
 * `resolveShortlist`'s `canonicalOrder` — before reading the changed resource off it. Pure;
 * deduped, so the two directional proposals of a peer pair collapse to one pair each. Only
 * pairs whose **new-lineage** side is a `changedResources` ref are returned.
 */
export function deriveEstablishedPairs(
  proposals: readonly MappingProposal[],
  supersededSpecId: string,
  counterpartSpecId: string,
  changedResources: readonly string[],
): EstablishedResourcePair[] {
  const changed = new Set(changedResources);
  // `resolveShortlist` canonicalizes with `specA.id <= specB.id`; mirror that exactly.
  const newLineageIsCanonicalSource = supersededSpecId <= counterpartSpecId;
  const pairs: EstablishedResourcePair[] = [];
  const seen = new Set<string>();
  for (const proposal of proposals) {
    const shortlist = proposal.shortlistResult;
    if (shortlist === null) continue;
    for (const pair of shortlist.candidatePairs) {
      const newResourceRef = newLineageIsCanonicalSource
        ? pair.sourceResource
        : pair.targetResource;
      const counterpartResourceRef = newLineageIsCanonicalSource
        ? pair.targetResource
        : pair.sourceResource;
      if (!changed.has(newResourceRef)) continue;
      const key = JSON.stringify([newResourceRef, counterpartResourceRef]);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ newResourceRef, counterpartResourceRef });
    }
  }
  return pairs;
}

/**
 * **SL-3 — enumerate, analyze (scoped), and persist the additive delta for a newly
 * ingested additive version.** Fetches the new spec + the active counterpart set and reuses
 * the Phase-2 candidate enumeration (`enumerateCandidatePairs`) to get exactly the same
 * counterparts/directions full detection would, then runs {@link analyzeAdditiveDelta} per
 * unordered pair — a scoped stage-1 shortlist for new groups and detail-only for changed
 * resources — and persists all resulting delta proposals in **one atomic** `persistAll`.
 *
 * Idempotent to re-run (DT-2/SL-3.5): the worker only ever re-runs this after a crash
 * reclaim, and the enqueue's partial-unique index already guarantees a redelivered ingest
 * produces one job. Persistence is all-or-nothing, so a fault mid-persist leaves nothing to
 * duplicate on the retry. Nothing here approves anything — every delta proposal is `pending`
 * (or `failed`), reviewed through the ordinary Phase-3 flow (SL-3.3).
 */
export async function runScopedAdditiveAnalysis(
  job: ScopedAnalysisJob,
  deps: RunScopedDeps,
): Promise<DetectionRunResult> {
  const newSpec = await deps.specSource.getById(job.newSpecId);
  if (newSpec === undefined) {
    throw new Error(`runScopedAdditiveAnalysis: no ApiSpec with id ${job.newSpecId}`);
  }

  const active = await deps.specSource.listActive();
  const otherActive = active.filter((spec) => spec.id !== newSpec.id);
  const specsById = new Map<string, ApiSpec>(otherActive.map((spec) => [spec.id, spec]));

  // Same counterparts/directions as full detection — the scope only restricts which
  // resources within each pair are analyzed.
  const candidates = enumerateCandidatePairs(newSpec, otherActive);
  const byCounterpart = new Map<string, CandidateSpecPair[]>();
  for (const candidate of candidates) {
    const counterpartId =
      candidate.sourceSpecId === newSpec.id ? candidate.targetSpecId : candidate.sourceSpecId;
    const bucket = byCounterpart.get(counterpartId);
    if (bucket === undefined) {
      byCounterpart.set(counterpartId, [candidate]);
    } else {
      bucket.push(candidate);
    }
  }

  const analyses: CandidateAnalysisResult[] = [];
  for (const [counterpartId, pairCandidates] of byCounterpart) {
    const counterpart = specsById.get(counterpartId);
    if (counterpart === undefined) {
      continue; // defensive: enumeration only yields active counterparts
    }
    const priorProposals = await deps.priorProposals.listForSpecPair(
      job.supersededSpecId,
      counterpartId,
    );
    const establishedPairs = deriveEstablishedPairs(
      priorProposals,
      job.supersededSpecId,
      counterpartId,
      job.scope.changedResources,
    );
    const results = await analyzeAdditiveDelta({
      newSpec,
      counterpart,
      candidates: pairCandidates,
      scope: job.scope,
      establishedPairs,
      deps,
    });
    analyses.push(...results);
  }

  await deps.proposalStore.persistAll(
    analyses.map((analysis) => ({ proposal: analysis.proposal, items: analysis.items })),
  );

  return { newSpecId: job.newSpecId, analyses };
}

/**
 * A {@link PriorProposalSource} over `MappingProposalRepository` bound to a db handle: the
 * union of both directions of the unordered spec pair (a peer pair has two proposals whose
 * `candidatePairs` are identical; a consumer-provider pair has one), so a changed resource's
 * established counterpart is found regardless of which side the new lineage was.
 */
export function createDbPriorProposalSource(db: DbHandle): PriorProposalSource {
  const repo = new MappingProposalRepository(db);
  return {
    async listForSpecPair(specIdA, specIdB) {
      const [fromA, fromB] = await Promise.all([
        repo.listBySourceSpecId(specIdA),
        repo.listBySourceSpecId(specIdB),
      ]);
      return [
        ...fromA.filter((proposal) => proposal.targetSpecId === specIdB),
        ...fromB.filter((proposal) => proposal.targetSpecId === specIdA),
      ];
    },
  };
}
