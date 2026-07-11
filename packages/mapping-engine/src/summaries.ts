import type { ApiSpec, IrOperation, IrResourceGroup } from "@mediator/domain";
import type { ResourceSummary, SpecSummaryIR } from "@mediator/llm";

/**
 * Resource-scope computation and stage-1 summary building.
 *
 * The **in-scope** resource set of a spec is its IR resource groups minus the ones
 * the operator excluded (`ApiSpec.analysisExclusions`, CE-4). Exclusions are
 * `resourceRef`s; a ref that no longer resolves to a group in the current IR is
 * simply ignored (CE-4 crit 4 — "a ref that no longer resolves is dropped"). Both
 * sides of a spec pair are scoped down before stage 1 ever sees them, so an
 * excluded resource appears in no shortlist prompt, gets no detail call, and is
 * distinct from a "no counterpart shortlisted" resource (CE-4 crit 2/5).
 */

/**
 * The IR resource groups of `spec` that are **in analysis scope** — every group
 * whose `resourceRef` is not listed in `spec.analysisExclusions`. Order follows
 * the IR. A stale exclusion ref (one that matches no group) excludes nothing.
 */
export function inScopeResources(spec: ApiSpec): IrResourceGroup[] {
  if (spec.analysisExclusions.length === 0) {
    return [...spec.parsedIR];
  }
  const excluded = new Set(spec.analysisExclusions);
  return spec.parsedIR.filter((group) => !excluded.has(group.resourceRef));
}

/** A single operation's summary line for the shortlist prompt (or a fallback label). */
function operationSummary(operation: IrOperation): string {
  if (operation.summary !== undefined && operation.summary.length > 0) {
    return operation.summary;
  }
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** The distinct top-level field names across a resource group's full schemas. */
function topLevelFields(group: IrResourceGroup): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const schema of group.schemas) {
    for (const field of schema.fields) {
      if (!seen.has(field.name)) {
        seen.add(field.name);
        fields.push(field.name);
      }
    }
  }
  return fields;
}

/**
 * Build the lightweight stage-1 {@link ResourceSummary} for one resource group:
 * name, operation summaries, and the top-level field list — metadata only, never
 * full operations/schemas (the shortlist call must stay cheap). `IrResourceGroup`
 * carries no group-level description, so the optional `description` is omitted.
 */
export function toResourceSummary(group: IrResourceGroup): ResourceSummary {
  return {
    resourceRef: group.resourceRef,
    name: group.name,
    operationSummaries: group.operations.map(operationSummary),
    topLevelFields: topLevelFields(group),
  };
}

/** Build the stage-1 summary IR for a spec's in-scope resource groups. */
export function buildSpecSummaryIR(groups: readonly IrResourceGroup[]): SpecSummaryIR {
  return groups.map(toResourceSummary);
}
