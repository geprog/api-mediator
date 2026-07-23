import { randomUUID } from "node:crypto";

import type { ReInclusionScope } from "@mediator/db";
import type { ApiSpec, AuditLogEntry, Ir } from "@mediator/domain";

import { BadRequestError, NotFoundError } from "../app-errors.js";
import type { ValidationIssue } from "@mediator/contracts";
import type { UnitOfWork } from "./persistence.js";

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
        // already in scope. `enqueueScoped` is idempotent under the same partial-unique
        // index as the full enqueue (DT-2), so a retried replace produces one job.
        const scope: ReInclusionScope = {
          kind: "re-inclusion",
          reincludedResourceGroups: reincluded,
        };
        await stores.detectionJobs.enqueueScoped(specId, scope);
        await stores.audit.insert(reInclusionAuditEntry(updated, reincluded, actor));
      }

      return updated;
    });
  }
}

/**
 * **SL-9.5 — the durable, countable record that a re-inclusion triggered an analysis**
 * (the OB-2 "`analysisExclusions` re-inclusions" metric). Written in the same
 * transaction as the exclusions change and the scoped job, so the count can never drift
 * from what was actually triggered.
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
): AuditLogEntry {
  return {
    id: randomUUID(),
    type: "mapping-decision",
    actor,
    details: `${RE_INCLUSION_AUDIT_PREFIX} re-included ${reincluded.join(", ")} on spec ${spec.id} (v${String(spec.version)}) — scoped incremental analysis triggered`,
    timestamp: new Date(),
  };
}
