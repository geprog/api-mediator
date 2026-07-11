import {
  ApiSpecRepository,
  type Database,
  type DbHandle,
  MappingProposalRepository,
  tx,
} from "@mediator/db";
import type { ApiSpec, MappingProposal, MappingProposalItem } from "@mediator/domain";

import { type CandidateAnalysisResult, type DetectionDeps, detectForSpec } from "./detection.js";

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
