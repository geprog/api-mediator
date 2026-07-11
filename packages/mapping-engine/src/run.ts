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

/** Persists one proposal together with its items (transactionally). */
export interface ProposalStore {
  persist(proposal: MappingProposal, items: MappingProposalItem[]): Promise<void>;
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
 * each directional proposal (pending or failed) with its items. Persistence
 * happens after analysis so a persistence error never leaves a half-analyzed run.
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
  for (const analysis of analyses) {
    await deps.proposalStore.persist(analysis.proposal, analysis.items);
  }

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
 * A {@link ProposalStore} that persists each proposal + items in its own
 * transaction via `MappingProposalRepository.create`, matching the Phase-1
 * repository convention (`tx(db, (txn) => new Repo(txn).create(...))`).
 */
export function createDbProposalStore(db: Database): ProposalStore {
  return {
    persist: (proposal, items) =>
      tx(db, (txn) => new MappingProposalRepository(txn).create(proposal, items)),
  };
}
