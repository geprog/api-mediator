import {
  recordRelativePath,
  type AcknowledgedIgnoredInput,
  type AdapterBindingRole,
  type AggregationStrategy,
} from "@mediator/domain";

/**
 * **CO-4 + CO-5 — the composition-time derivations the composer must see and confirm.**
 * Pure functions, no I/O: they take the facts the
 * {@link import("./context.js").CompositionContextLoader} loads and return the analysis
 * the composition presentation (and later CU-1) surfaces.
 *
 * - **CO-4** derives, per `supplement` binding of a `fanout-merge`, which consumer
 *   response fields it supplies and whether all are optional — i.e. whether a degraded
 *   response is even possible, or the supplement is **load-bearing** (its failure fails
 *   the whole request even in `degraded` mode). It **informs** the strict-vs-degraded
 *   decision; it never sets it (CO-4.3), and it is **re-derived at request time** from
 *   the consumer schema rather than persisted as authoritative state (CO-4.4).
 * - **CO-5** derives, per binding, which consumer inputs (operation parameters, request
 *   body fields) reach no backend — so the composer either lets the endpoint reject
 *   requests using them (RP-2.4) or **explicitly acknowledges** them as ignored. A
 *   **required** input reaching no backend is a blocking finding (CO-5.3), enforced by
 *   {@link import("./validate.js").validateComposition}; this module only derives.
 *
 * Both are **derivations the composer confirms** — nothing here is auto-applied
 * (CO-4.3 / CO-5.5). Executing degradation (AG-2) and executing the request drop are
 * out of scope.
 */

// ── shared: reduce a stored field path to its top-level record-relative segment ──

/**
 * The top-level record-relative field name of a stored field path — `todos/done` →
 * `done`, `todos/assignee.name` → `assignee`. Field mappings carry resource-qualified
 * paths ({@link recordRelativePath} strips the `resourceRef/` prefix) while an IR
 * schema flattens a body to **top-level** fields, so both consumer-response required-ness
 * (CO-4) and consumer-body coverage (CO-5) match on the top-level segment.
 */
export function topLevelConsumerFieldName(fieldPath: string): string {
  const relative = recordRelativePath(fieldPath);
  const dot = relative.indexOf(".");
  return dot === -1 ? relative : relative.slice(0, dot);
}

// ── CO-4 — supplement load-bearing analysis ──────────────────────────────────

/** One binding's role + the consumer response fields it supplies, for the CO-4 derivation. */
export interface SupplementAnalysisBinding {
  readonly bindingId: string;
  readonly role: AdapterBindingRole;
  /**
   * The consumer-shape response field paths this binding supplies — the `targetPath`s
   * of its `phase = response` `FieldMapping`s, already **scoped to the binding's
   * resource pair** by the loader (`fieldMappingsForResourcePair`).
   */
  readonly suppliedConsumerResponseFieldPaths: ReadonlySet<string>;
}

/** The CO-4 input: the composition's strategy + roles, plus the consumer schema's required fields. */
export interface SupplementAnalysisInput {
  readonly aggregationStrategy: AggregationStrategy;
  readonly bindings: readonly SupplementAnalysisBinding[];
  /**
   * The **required** field names of the consumer operation's response schema (bare,
   * top-level). Required-ness is re-derived from this schema at request time (AG-2), so
   * the CO-4 verdict is never persisted as authoritative — the schema governs (CO-4.4).
   */
  readonly requiredConsumerResponseFieldNames: ReadonlySet<string>;
}

/**
 * One binding's CO-4 verdict. A discriminated union on `kind`:
 * - `primary-always-fails` — a `primary`'s failure always fails the request, independent
 *   of strictness (CO-4.5).
 * - `supplement` — the fields it supplies, whether they are all optional, and the
 *   resulting `loadBearing` verdict (CO-4.1/CO-4.2).
 */
export type SupplementAnalysisEntry =
  | {
      readonly kind: "primary-always-fails";
      readonly bindingId: string;
      readonly role: AdapterBindingRole;
    }
  | {
      readonly kind: "supplement";
      readonly bindingId: string;
      /** The consumer response fields this supplement supplies (for display). */
      readonly suppliedConsumerResponseFields: readonly string[];
      /** Whether every supplied field is `optional` in the consumer response schema. */
      readonly allSuppliedFieldsOptional: boolean;
      /** ≥1 supplied field is `required` → the supplement is load-bearing (CO-4.2). */
      readonly loadBearing: boolean;
    };

/**
 * The CO-4 analysis. `applicable: false` for any strategy other than `fanout-merge` —
 * the load-bearing question is a `fanout-merge`-only concept (a `single` endpoint has no
 * supplement; `collection-union`/`fanout-first-success` have their own semantics).
 */
export type SupplementLoadBearingAnalysis =
  | { readonly applicable: false; readonly aggregationStrategy: AggregationStrategy }
  | { readonly applicable: true; readonly entries: readonly SupplementAnalysisEntry[] };

/**
 * **CO-4** — derive, per binding of a `fanout-merge` composition, whether a `supplement`
 * is load-bearing (CO-4.1/4.2) and state that a `primary`'s failure always fails the
 * request (CO-4.5). A supplement is load-bearing iff it supplies ≥1 field that is
 * **required** in the consumer response schema (matched by top-level record-relative
 * name); then even `degraded` mode cannot omit it, so its failure fails the whole
 * request. This is a **derivation** surfaced to the composer — it does not set strictness
 * (CO-4.3) and is not persisted (CO-4.4).
 */
export function analyzeSupplementLoadBearing(
  input: SupplementAnalysisInput,
): SupplementLoadBearingAnalysis {
  if (input.aggregationStrategy !== "fanout-merge") {
    return { applicable: false, aggregationStrategy: input.aggregationStrategy };
  }
  const entries = input.bindings.map((binding): SupplementAnalysisEntry => {
    if (binding.role !== "supplement") {
      // Under `fanout-merge` the only other valid role is `primary`, whose failure
      // always fails the request; any other role is invalid there (CO-2 rejects it) and
      // is treated as always-failing too — the safe reading for the analysis.
      return { kind: "primary-always-fails", bindingId: binding.bindingId, role: binding.role };
    }
    const suppliedConsumerResponseFields = [...binding.suppliedConsumerResponseFieldPaths];
    const requiredSupplied = suppliedConsumerResponseFields.filter((path) =>
      input.requiredConsumerResponseFieldNames.has(topLevelConsumerFieldName(path)),
    );
    const allSuppliedFieldsOptional = requiredSupplied.length === 0;
    return {
      kind: "supplement",
      bindingId: binding.bindingId,
      suppliedConsumerResponseFields,
      allSuppliedFieldsOptional,
      loadBearing: !allSuppliedFieldsOptional,
    };
  });
  return { applicable: true, entries };
}

// ── CO-5 — consumer-input coverage ───────────────────────────────────────────

/** One consumer operation parameter in the coverage universe (cookie params excluded). */
export interface CoverageParameter {
  /** The bare parameter name — what a `ParameterMapping` sources and RP-2 compares. */
  readonly name: string;
  readonly required: boolean;
}

/** One consumer request-phase body field in the coverage universe (top-level, bare). */
export interface CoverageBodyField {
  readonly name: string;
  readonly required: boolean;
}

/** The consumer operation's inputs — the universe the coverage report is derived against. */
export interface ConsumerInputUniverse {
  readonly parameters: readonly CoverageParameter[];
  readonly bodyFields: readonly CoverageBodyField[];
}

/** One binding's mapped consumer inputs (what it actually sources), for the CO-5 derivation. */
export interface CoverageBindingInput {
  readonly bindingId: string;
  /** Bare consumer parameter names this binding sources (ParameterMapping sources + additional inputs). */
  readonly mappedConsumerParamNames: ReadonlySet<string>;
  /** Top-level consumer body field names this binding maps (request-phase FieldMapping inputs, pair-scoped). */
  readonly mappedConsumerBodyFieldNames: ReadonlySet<string>;
}

/** The CO-5 input: the consumer input universe + one entry per composable binding. */
export interface ConsumerInputCoverageInput {
  readonly consumerInputs: ConsumerInputUniverse;
  readonly bindings: readonly CoverageBindingInput[];
}

/** One consumer input reaching no backend — its kind, name, and whether it is required. */
export interface UnmappedConsumerInput {
  readonly kind: "parameter" | "body-field";
  readonly name: string;
  readonly required: boolean;
}

/** One binding's unmapped inputs (CO-5.1 per-binding presentation). */
export interface BindingInputCoverage {
  readonly bindingId: string;
  readonly unmappedParameters: readonly string[];
  readonly unmappedBodyFields: readonly string[];
}

/** The CO-5 coverage report. */
export interface ConsumerInputCoverage {
  /** Per binding, the consumer inputs that binding does not receive (CO-5.1). */
  readonly perBinding: readonly BindingInputCoverage[];
  /**
   * The consumer inputs that reach **no** backend — unmapped by *every* binding. These
   * are the endpoint-level inputs a request "uses" that would go nowhere: a required one
   * blocks composition (CO-5.3); an optional one is either acknowledged (served, dropped)
   * or left to reject at request validation (RP-2.4).
   */
  readonly unmappedByAllBackends: readonly UnmappedConsumerInput[];
}

/**
 * **CO-5** — derive the consumer inputs no backend receives. Per binding (CO-5.1) it
 * lists the operation parameters that binding does not source and the request body fields
 * it does not map; endpoint-level it lists the inputs unmapped by **every** binding —
 * the ones that reach no backend at all, which the runtime rejects (RP-2.4) unless
 * acknowledged. This is a **derivation**: acknowledgements are never auto-applied
 * (CO-5.5) — the composer confirms each, and the required-input blocking is enforced by
 * {@link import("./validate.js").validateComposition}.
 */
export function deriveConsumerInputCoverage(
  input: ConsumerInputCoverageInput,
): ConsumerInputCoverage {
  const perBinding = input.bindings.map((binding): BindingInputCoverage => ({
    bindingId: binding.bindingId,
    unmappedParameters: input.consumerInputs.parameters
      .filter((parameter) => !binding.mappedConsumerParamNames.has(parameter.name))
      .map((parameter) => parameter.name),
    unmappedBodyFields: input.consumerInputs.bodyFields
      .filter((field) => !binding.mappedConsumerBodyFieldNames.has(field.name))
      .map((field) => field.name),
  }));

  // Endpoint-level: an input reaches a backend iff SOME binding maps it (the same union
  // the runtime's `collectMappedConsumerParams` computes). So an input is unmapped-by-all
  // iff no binding maps it. A composition with no composable binding leaves every input
  // unmapped-by-all.
  const mappedByAnyParam = unionOf(input.bindings.map((b) => b.mappedConsumerParamNames));
  const mappedByAnyBodyField = unionOf(input.bindings.map((b) => b.mappedConsumerBodyFieldNames));

  const unmappedByAllBackends: UnmappedConsumerInput[] = [];
  for (const parameter of input.consumerInputs.parameters) {
    if (!mappedByAnyParam.has(parameter.name)) {
      unmappedByAllBackends.push({
        kind: "parameter",
        name: parameter.name,
        required: parameter.required,
      });
    }
  }
  for (const field of input.consumerInputs.bodyFields) {
    if (!mappedByAnyBodyField.has(field.name)) {
      unmappedByAllBackends.push({
        kind: "body-field",
        name: field.name,
        required: field.required,
      });
    }
  }

  return { perBinding, unmappedByAllBackends };
}

/** Whether an acknowledgement targets a given unmapped input (matched by kind + name). */
export function acknowledgementMatchesInput(
  acknowledgement: AcknowledgedIgnoredInput,
  input: UnmappedConsumerInput,
): boolean {
  return acknowledgement.kind === "parameter"
    ? input.kind === "parameter" && acknowledgement.consumerParamName === input.name
    : input.kind === "body-field" && acknowledgement.consumerFieldPath === input.name;
}

/** The display name an acknowledgement refers to (for a payload-free rejection message). */
export function acknowledgementInputName(acknowledgement: AcknowledgedIgnoredInput): string {
  return acknowledgement.kind === "parameter"
    ? acknowledgement.consumerParamName
    : acknowledgement.consumerFieldPath;
}

function unionOf(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  const union = new Set<string>();
  for (const set of sets) {
    for (const value of set) {
      union.add(value);
    }
  }
  return union;
}
