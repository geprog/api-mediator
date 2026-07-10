import type { ApiSpec, Ir } from "@mediator/domain";

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

/** Replaces a spec's `analysisExclusions` list (SI-4). */
export interface ExclusionsReplacer {
  replace(specId: string, analysisExclusions: string[]): Promise<ApiSpec>;
}

export interface AnalysisExclusionsServiceDeps {
  readonly unitOfWork: UnitOfWork;
}

/**
 * Replace a spec's `analysisExclusions` (SI-4). Every `resourceRef` is validated
 * against the spec's IR resource groups — an unknown ref is rejected (crit 4).
 * Setting exclusions triggers no analysis in Phase 1 (crit 5): it only persists
 * the operator's declared scope. Read-validate-write run in one transaction.
 */
export class AnalysisExclusionsService implements ExclusionsReplacer {
  readonly #unitOfWork: UnitOfWork;

  public constructor(deps: AnalysisExclusionsServiceDeps) {
    this.#unitOfWork = deps.unitOfWork;
  }

  public replace(specId: string, analysisExclusions: string[]): Promise<ApiSpec> {
    return this.#unitOfWork.run(async (stores) => {
      const spec = await stores.apiSpecs.getById(specId);
      if (spec === undefined) {
        throw new NotFoundError(`ApiSpec ${specId} not found.`);
      }

      assertExclusionsInIr(spec.parsedIR, analysisExclusions, "analysisExclusions");

      const updated = await stores.apiSpecs.updateAnalysisExclusions(specId, analysisExclusions);
      if (updated === undefined) {
        throw new NotFoundError(`ApiSpec ${specId} not found.`);
      }
      return updated;
    });
  }
}
