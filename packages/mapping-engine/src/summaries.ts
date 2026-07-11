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

/**
 * Caps that keep a stage-1 summary **bounded** so a large resource group cannot
 * blow up the shortlist prompt: a 60-operation, 100-field group is summarized to
 * at most this many distinct operation summaries and top-level field names. The
 * shortlist only needs enough metadata to judge plausible correspondence — a few
 * representative operations and the leading field names — not the whole group.
 */
export const MAX_OPERATION_SUMMARIES = 10;
export const MAX_TOP_LEVEL_FIELDS = 30;

/**
 * A single operation's summary line for the shortlist prompt: prefer the OpenAPI
 * `summary`, then the `description`, and only fall back to a `METHOD /path` label
 * when the operation carries no descriptive text at all.
 */
function operationSummary(operation: IrOperation): string {
  if (operation.summary !== undefined && operation.summary.length > 0) {
    return operation.summary;
  }
  if (operation.description !== undefined && operation.description.length > 0) {
    return operation.description;
  }
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/**
 * The **distinct** operation summaries of a group, capped at
 * {@link MAX_OPERATION_SUMMARIES}. Duplicate summaries (several CRUD operations
 * sharing one summary line) collapse to a single entry, so the cap counts
 * distinct lines rather than raw operations.
 */
function operationSummaries(group: IrResourceGroup): string[] {
  const seen = new Set<string>();
  const summaries: string[] = [];
  for (const operation of group.operations) {
    if (summaries.length >= MAX_OPERATION_SUMMARIES) {
      break;
    }
    const summary = operationSummary(operation);
    if (!seen.has(summary)) {
      seen.add(summary);
      summaries.push(summary);
    }
  }
  return summaries;
}

/**
 * The **distinct** top-level field names across a group's full schemas, capped at
 * {@link MAX_TOP_LEVEL_FIELDS}.
 */
function topLevelFields(group: IrResourceGroup): string[] {
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const schema of group.schemas) {
    for (const field of schema.fields) {
      if (fields.length >= MAX_TOP_LEVEL_FIELDS) {
        return fields;
      }
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
 * full operations/schemas (the shortlist call must stay cheap). Both lists are
 * distinct and **bounded** ({@link MAX_OPERATION_SUMMARIES} /
 * {@link MAX_TOP_LEVEL_FIELDS}) so a large group cannot produce a giant prompt.
 * `IrResourceGroup` carries no group-level description, so the optional
 * `description` is omitted.
 */
export function toResourceSummary(group: IrResourceGroup): ResourceSummary {
  return {
    resourceRef: group.resourceRef,
    name: group.name,
    operationSummaries: operationSummaries(group),
    topLevelFields: topLevelFields(group),
  };
}

/** Build the stage-1 summary IR for a spec's in-scope resource groups. */
export function buildSpecSummaryIR(groups: readonly IrResourceGroup[]): SpecSummaryIR {
  return groups.map(toResourceSummary);
}
