import { randomUUID } from "node:crypto";

import type { ReInclusionScope } from "@mediator/db";
import type { ApiSpec, AuditLogEntry, Ir } from "@mediator/domain";

import { BadRequestError, ConflictError, NotFoundError } from "../app-errors.js";
import type { ValidationIssue } from "@mediator/contracts";
import type { TxStores, UnitOfWork } from "./persistence.js";

/**
 * Reject `analysisExclusions` referencing a resource group not present in `ir`
 * (SI-4 crit 4). Shared by both surfaces that set exclusions — the registration
 * path and the `PATCH …/analysis-exclusions` edit — so the IR-membership rule is
 * enforced identically. `issuePath` scopes the reported field path to the caller
 * (`analysisExclusions` vs. `specs.<i>.analysisExclusions`).
 */
export function assertExclusionsInIr(
  ir: Ir,
  analysisExclusions: readonly string[],
  issuePath: string,
): void {
  const knownRefs = new Set(ir.map((group) => group.resourceRef));
  const unknownRefs = analysisExclusions.filter((ref) => !knownRefs.has(ref));
  if (unknownRefs.length === 0) {
    return;
  }
  const issues: ValidationIssue[] = unknownRefs.map((ref) => ({
    path: issuePath,
    message: `resourceRef '${ref}' is not a resource group of this spec's IR`,
  }));
  throw new BadRequestError(
    `Unknown resourceRef(s) in analysisExclusions: ${unknownRefs.join(", ")}.`,
    issues,
  );
}

/**
 * **SL-9 — the resource groups a `replace` puts back in analysis scope**: the
 * set-difference `previous \ next`, i.e. every ref the operator **removed** from
 * `analysisExclusions`. Pure and total, so the trigger condition is unit-testable on
 * its own.
 *
 * Only a genuine *removal* is a re-inclusion: adding an exclusion yields nothing (the
 * refs only grow), and a no-op replace (same set, any order) yields nothing. Order
 * follows `previous` and duplicates collapse, so the recorded scope is stable.
 */
export function reincludedResourceRefs(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  const stillExcluded = new Set(next);
  const seen = new Set<string>();
  const reincluded: string[] = [];
  for (const ref of previous) {
    if (stillExcluded.has(ref) || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    reincluded.push(ref);
  }
  return reincluded;
}

/**
 * Replaces a spec's `analysisExclusions` list (SI-4), attributing the change — and any
 * SL-9 re-inclusion it triggers — to the authenticated operator.
 */
export interface ExclusionsReplacer {
  replace(specId: string, analysisExclusions: string[], actor: string): Promise<ApiSpec>;
}

export interface AnalysisExclusionsServiceDeps {
  readonly unitOfWork: UnitOfWork;
}

/**
 * Replace a spec's `analysisExclusions` (SI-4). Every `resourceRef` is validated
 * against the spec's IR resource groups — an unknown ref is rejected (crit 4).
 * Read-validate-write run in one transaction.
 *
 * **SL-9 — removing an exclusion re-opens that resource for mapping.** Adding an
 * exclusion (or replacing the list with the same set) still triggers no analysis; a
 * *removal* records, in this same transaction:
 *
 *  - a **scoped** `mapping_detection_job` carrying the `re-inclusion`
 *    {@link ReInclusionScope} — the worker later runs the same scoped incremental
 *    analysis SL-3.1 runs for an additively-added group (one shortlist for the
 *    re-included resource's summary against each counterpart, then detail calls for
 *    whatever gets shortlisted), producing an **ordinary** `MappingProposal` reviewed
 *    through the Phase-3 flow — nothing auto-approved, nothing silent (SL-9.1/9.2);
 *  - an **audit row** making the re-inclusion countable for the mapping dashboard's
 *    "`analysisExclusions` re-inclusions" metric (SL-9.5 / OB-2).
 *
 * The slow LLM/network work is deliberately NOT done here: only the intent is recorded
 * in-tx (the DT-2 discipline), so this transaction stays short and the analysis runs in
 * the detection worker outside it. Exclusions govern **analysis only** — this method
 * never touches a `MappingProposal` or an `ApprovedMapping`, so re-inclusion strictly
 * adds new review surface (SL-9.3).
 *
 * **The re-inclusion never silently succeeds.** One un-finished detection job is allowed
 * per spec, so a removal made while an analysis is already queued or running would
 * otherwise be swallowed by the enqueue's `ON CONFLICT DO NOTHING` — committing the
 * scope change, and an audit row claiming an analysis, while that group is in fact never
 * analyzed. {@link recordReInclusionAnalysis} resolves that collapse instead: it merges
 * into a pending re-inclusion job, accepts a pending full run (which re-derives from
 * current state), and otherwise rejects the whole `replace` with a 409.
 */
export class AnalysisExclusionsService implements ExclusionsReplacer {
  readonly #unitOfWork: UnitOfWork;

  public constructor(deps: AnalysisExclusionsServiceDeps) {
    this.#unitOfWork = deps.unitOfWork;
  }

  public replace(specId: string, analysisExclusions: string[], actor: string): Promise<ApiSpec> {
    return this.#unitOfWork.run(async (stores) => {
      const spec = await stores.apiSpecs.getById(specId);
      if (spec === undefined) {
        throw new NotFoundError(`ApiSpec ${specId} not found.`);
      }

      assertExclusionsInIr(spec.parsedIR, analysisExclusions, "analysisExclusions");

      // SL-9 — computed against the PRE-update list; the refs removed here are the ones
      // put back in scope. Every re-included ref resolved in this spec's IR when it was
      // excluded, and the IR cannot change without a version advance (which resets
      // exclusions), so a re-included ref always still resolves.
      const reincluded = reincludedResourceRefs(spec.analysisExclusions, analysisExclusions);

      const updated = await stores.apiSpecs.updateAnalysisExclusions(specId, analysisExclusions);
      if (updated === undefined) {
        throw new NotFoundError(`ApiSpec ${specId} not found.`);
      }

      if (reincluded.length > 0) {
        // Recorded AFTER the exclusions are persisted, in the same transaction: the
        // worker reads the spec outside this tx and must see the re-included resource
        // already in scope. An identical repeated replace never reaches here (it
        // re-includes nothing), so this path always describes genuinely new work — which
        // is exactly why a collapsed enqueue must be resolved rather than swallowed.
        const resolution = await recordReInclusionAnalysis(stores, specId, reincluded);
        // Only now — a resolution that could not guarantee the analysis has already
        // thrown, so the audit row never claims an analysis that will not happen.
        await stores.audit.insert(reInclusionAuditEntry(updated, reincluded, actor, resolution));
      }

      return updated;
    });
  }
}

/**
 * How the re-inclusion's analysis was secured — recorded in the audit row so the OB-2
 * count states what actually happened rather than assuming a fresh job.
 */
type ReInclusionResolution =
  | "scoped job recorded"
  | "merged into the pending re-inclusion job"
  | "folded into the pending full detection run";

/**
 * **SL-9 — guarantee the re-included groups WILL be analyzed, or refuse the edit.**
 *
 * The `mapping_detection_job` partial UNIQUE index allows only one un-finished
 * (`pending`/`running`) job per spec, and a *scoped* job freezes its resource list in
 * the row. So an `ON CONFLICT DO NOTHING` collapse here would not deduplicate work, it
 * would **discard** it: the re-included group would sit in analysis scope and never be
 * summarized, shortlisted or detailed, with no operator-visible signal and nothing for
 * the reconciliation sweep to recover (it only re-derives specs with *no* job at all).
 *
 * The un-finished job is therefore locked `FOR UPDATE` first — which is what makes this
 * race-free against the worker's `SKIP LOCKED` claim — and the collapse resolved:
 *
 * - **no un-finished job** → insert the scoped job (the ordinary path);
 * - **pending re-inclusion job** → merge these refs into its frozen scope, so a second
 *   removal made while the first is still queued loses nothing;
 * - **pending full detection job** → accept: a full job re-derives its work from
 *   *current* state when the worker runs it (`runDetectionForSpec` re-reads the spec and
 *   `inScopeResources` re-reads `analysisExclusions`), so it will analyze the re-included
 *   group as a matter of course;
 * - **anything else** (a `running` job of any kind — it already read the spec — or a
 *   pending scoped job whose frozen descriptor cannot absorb these refs) → **409**, so
 *   the whole `replace` rolls back and the operator gets a real signal to retry rather
 *   than a false success.
 */
async function recordReInclusionAnalysis(
  stores: TxStores,
  specId: string,
  reincluded: readonly string[],
): Promise<ReInclusionResolution> {
  const scope: ReInclusionScope = {
    kind: "re-inclusion",
    reincludedResourceGroups: reincluded,
  };

  const blocking = await stores.detectionJobs.lockUnfinishedJob(specId);
  if (blocking === undefined) {
    const inserted = await stores.detectionJobs.enqueueScoped(specId, scope);
    if (!inserted) {
      // A concurrent transaction inserted between the lock attempt and this insert.
      throw reInclusionConflict(reincluded, "another analysis job was recorded concurrently");
    }
    return "scoped job recorded";
  }

  if (blocking.status === "pending" && blocking.scope !== null) {
    if (blocking.scope.kind === "re-inclusion") {
      const merged = mergeResourceRefs(blocking.scope.reincludedResourceGroups, reincluded);
      await stores.detectionJobs.updateScope(blocking.id, {
        kind: "re-inclusion",
        reincludedResourceGroups: merged,
      });
      return "merged into the pending re-inclusion job";
    }
    // A pending additive-delta / re-review job: its frozen scope describes different
    // work and must not be overwritten, so the re-inclusion cannot be guaranteed here.
    throw reInclusionConflict(
      reincluded,
      `a ${blocking.scope.kind} analysis is already queued for this spec`,
    );
  }

  if (blocking.status === "pending") {
    // A pending FULL detection job (scope === null) — re-derived from current state.
    return "folded into the pending full detection run";
  }

  // `running`: the analysis already read the spec's exclusions, so it cannot pick these
  // groups up, and its row must not be rewritten underneath it.
  throw reInclusionConflict(reincluded, "an analysis is already running for this spec");
}

/** Union of two `resourceRef` lists, order-stable and deduped (never a NUL-joined key). */
function mergeResourceRefs(existing: readonly string[], added: readonly string[]): string[] {
  const merged = [...existing];
  const seen = new Set(existing);
  for (const ref of added) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    merged.push(ref);
  }
  return merged;
}

function reInclusionConflict(reincluded: readonly string[], reason: string): ConflictError {
  return new ConflictError(
    `Cannot re-include ${reincluded.join(", ")} right now: ${reason}. Nothing was changed — retry once the current analysis finishes.`,
  );
}

/**
 * **SL-9.5 — the durable, countable record that a re-inclusion triggered an analysis**
 * (the OB-2 "`analysisExclusions` re-inclusions" metric). Written in the same
 * transaction as the exclusions change and the job that secures the analysis, and only
 * once that analysis is guaranteed (an unresolvable collapse throws first and rolls the
 * whole transaction back) — so the count can never claim an analysis that did not
 * happen. `resolution` records *how* it was secured, since a merge or a fold means no
 * new job row exists to count.
 *
 * Written as a `mapping-decision` entry, attributed to the operator who made the scope
 * edit: the existing audit vocabulary carries no dedicated re-inclusion type and adding
 * one is a schema migration this slice deliberately avoids — the same reasoning (and
 * shape) as the SL-2 re-pin / SL-4 stale rows. `details` opens with the stable
 * {@link RE_INCLUSION_AUDIT_PREFIX} marker so the rows are countable by prefix, and is
 * metadata only — the spec id/version and the re-included `resourceRef`s, never a secret.
 */
export const RE_INCLUSION_AUDIT_PREFIX = "analysisExclusions re-inclusion:";

function reInclusionAuditEntry(
  spec: ApiSpec,
  reincluded: readonly string[],
  actor: string,
  resolution: ReInclusionResolution,
): AuditLogEntry {
  return {
    id: randomUUID(),
    type: "mapping-decision",
    actor,
    details: `${RE_INCLUSION_AUDIT_PREFIX} re-included ${reincluded.join(", ")} on spec ${spec.id} (v${String(spec.version)}) — scoped incremental analysis triggered (${resolution})`,
    timestamp: new Date(),
  };
}
