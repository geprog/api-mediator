import type { ApiSpec, MappingVariant } from "@mediator/domain";

/**
 * Candidate spec-pair enumeration (CE-1..4) — the deterministic, mechanical front
 * of the Mapping Engine. Given a newly ingested `ApiSpec` and the set of every
 * *other* app's active specs, it enumerates the candidate **directional** analyses
 * involving the new spec, before any LLM call is made. It is a pure function of
 * registry state: no I/O, no provider, no persistence (see
 * `docs/requirements/phase-2-candidate-enumeration.md`).
 */

/**
 * One directional candidate analysis: a fixed `sourceSpecId → targetSpecId`
 * orientation, its `variant` (derived from the two roles), and the
 * direction-agnostic `unorderedKey` that groups the two directions of a peer pair
 * so stage 1 (shortlist) runs **once** and is shared by both (CE-1 crit 2).
 *
 * - **peer-peer** (`PROVIDER` × `PROVIDER`): an unordered pair `{S, P}` yields
 *   **two** candidates (S→P and P→S), both carrying the same `unorderedKey`.
 * - **consumer-provider** (`CONSUMER` × `PROVIDER`): a single candidate, always
 *   consumer-as-source; its `unorderedKey` carries exactly that one candidate.
 */
export interface CandidateSpecPair {
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
  readonly variant: MappingVariant;
  /** Stable, direction-agnostic key for the unordered spec pair (sorted spec ids). */
  readonly unorderedKey: string;
}

/** The stable, direction-agnostic key for the unordered pair of two spec ids. */
export function unorderedPairKey(specIdA: string, specIdB: string): string {
  return [specIdA, specIdB].sort().join("::");
}

/**
 * Enumerate every candidate directional analysis a newly ingested spec introduces
 * (CE-1..3). Only pairs **involving the new spec** are produced — a registration
 * never re-analyzes pre-existing pairs (CE-3 crit 4).
 *
 * Guardrails applied to the counterpart set (CE-3):
 * - **active only** — counterparts whose `status` is not `active` are skipped;
 * - **never the same app** — a counterpart owned by the new spec's own app is
 *   skipped (an app's `CONSUMER` spec is never paired with its own `PROVIDER`
 *   spec), and so is the new spec itself if present;
 * - `sourceSpecId` and `targetSpecId` are therefore never equal.
 *
 * Role pairing fixes both direction and kind (CE-1/CE-2/CE-3 crit 5):
 * - `PROVIDER` new × `PROVIDER` other → **two** `peer-peer` candidates (S→P, P→S);
 * - `PROVIDER` new × `CONSUMER` other → **one** `consumer-provider` candidate,
 *   consumer (the other) as source;
 * - `CONSUMER` new × `PROVIDER` other → **one** `consumer-provider` candidate,
 *   consumer (the new spec) as source;
 * - `CONSUMER` × `CONSUMER` → **none** (the adapter only pairs a consumer with a
 *   provider; two consumers have nothing to analyze).
 */
export function enumerateCandidatePairs(
  newSpec: ApiSpec,
  otherActiveSpecs: readonly ApiSpec[],
): CandidateSpecPair[] {
  const candidates: CandidateSpecPair[] = [];

  for (const other of otherActiveSpecs) {
    if (other.status !== "active") continue;
    if (other.appId === newSpec.appId) continue; // never pair a spec with same-app specs
    if (other.id === newSpec.id) continue; // never a spec vs. itself

    const key = unorderedPairKey(newSpec.id, other.id);

    if (newSpec.role === "PROVIDER" && other.role === "PROVIDER") {
      // Peer-peer: both directions, sharing one unordered pair (one shortlist).
      candidates.push({
        sourceSpecId: newSpec.id,
        targetSpecId: other.id,
        variant: "peer-peer",
        unorderedKey: key,
      });
      candidates.push({
        sourceSpecId: other.id,
        targetSpecId: newSpec.id,
        variant: "peer-peer",
        unorderedKey: key,
      });
      continue;
    }

    if (newSpec.role === "PROVIDER" && other.role === "CONSUMER") {
      // The new provider becomes a backend candidate for an existing consumer.
      candidates.push({
        sourceSpecId: other.id, // consumer as source
        targetSpecId: newSpec.id,
        variant: "consumer-provider",
        unorderedKey: key,
      });
      continue;
    }

    if (newSpec.role === "CONSUMER" && other.role === "PROVIDER") {
      candidates.push({
        sourceSpecId: newSpec.id, // consumer as source
        targetSpecId: other.id,
        variant: "consumer-provider",
        unorderedKey: key,
      });
      continue;
    }

    // CONSUMER × CONSUMER: nothing to enumerate.
  }

  return candidates;
}
