import {
  type AggregateConfig,
  type CoerceConfig,
  type FieldMapping,
  recordRelativePath,
} from "@mediator/domain";

import { applyAggregate } from "./aggregate.js";
import { applyCoerce } from "./coerce.js";
import { TransformError } from "./errors.js";
import {
  compileExpression,
  evaluateSafeExpr,
  resolveSandboxLimits,
  type SandboxLimits,
} from "./expression.js";
import { pathSegments, readPath, setPath, SetPathError } from "./json.js";
import type { JsonRecord, JsonValue, PathRead } from "./json.js";

/**
 * The Transformation Executor (TX-1..TX-5) — pure, deterministic, side-effect-free
 * application of an `ApprovedMapping`'s `FieldMapping`s to convert one app's payload
 * shape into another's. No credential access, no network, no persistence; it reasons
 * only over data already in memory, so it is reused unchanged by the Sync Engine and
 * the Adapter Engine (`docs/architecture/sync-engine.md`, `docs/flows/sync-polling-pull.md`
 * step 3.5).
 *
 * A `FieldMapping` is applied **only in its declared direction** — reading `sourcePath`
 * (plus any additional inputs) and writing `targetPath` — and is never inverted
 * (TX-1 criterion 5): there is no inverse code path.
 */

// ── which-fields-touched accounting (TX-2 criterion 2) ──────────────────────

/** The declared field participation of one `FieldMapping`, in declared order. */
export interface FieldParticipation {
  readonly fieldMappingId: string;
  /** Input paths the transform reads: the primary `sourcePath` then the additional paths. */
  readonly inputs: readonly string[];
  /** The output path the transform writes: `targetPath`. */
  readonly output: string;
}

/**
 * The paths a set of `FieldMapping`s reads and writes. The `SyncFieldState` slice
 * consumes `inputs ∪ outputs` to know exactly which per-side field rows to create —
 * one for every field that participates as a primary input, an additional
 * `aggregate`/`expression` input, or an output (TX-2 criterion 2;
 * `docs/architecture/data-model.md` `SyncFieldState`).
 */
export interface TransformTrace {
  /** Every input path read, de-duplicated, in first-seen order. */
  readonly inputs: readonly string[];
  /** Every output path written, de-duplicated, in first-seen order. */
  readonly outputs: readonly string[];
  /** Per-field breakdown, in the order the field mappings were supplied. */
  readonly perField: readonly FieldParticipation[];
}

/** The assembled target payload plus the field-participation trace. */
export interface AppliedMapping {
  readonly output: JsonRecord;
  readonly trace: TransformTrace;
}

/** Options common to the apply functions. */
export interface ApplyOptions {
  /** Overrides for the `expression` sandbox bounds; defaults are used otherwise. */
  readonly sandboxLimits?: Partial<SandboxLimits>;
}

function additionalInputPaths(field: FieldMapping): readonly string[] {
  return field.transformConfig?.additionalInputPaths ?? [];
}

function fieldParticipation(field: FieldMapping): FieldParticipation {
  return {
    fieldMappingId: field.id,
    inputs: [field.sourcePath, ...additionalInputPaths(field)],
    output: field.targetPath,
  };
}

/**
 * Account for the field paths a set of `FieldMapping`s reads and writes — purely
 * from the mappings, independent of any record. This is the accounting the
 * `SyncFieldState` slice needs (it runs whether or not a later transform errors),
 * so it never evaluates a transform and never raises.
 */
export function collectTouchedFields(fields: readonly FieldMapping[]): TransformTrace {
  const perField = fields.map(fieldParticipation);
  const inputs = dedupe(perField.flatMap((entry) => entry.inputs));
  const outputs = dedupe(perField.map((entry) => entry.output));
  return { inputs, outputs, perField };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// ── per-kind config resolution (discriminated on `transform`) ────────────────

/**
 * The strict, discriminated-on-`transform` config the executor needs, resolved
 * from a `FieldMapping`'s `transform` + permissive persisted `transformConfig`.
 * A persisted config that does not match its kind (an `expression` with no text, a
 * `coerce` with no conversion spec, an `aggregate` with no combine spec or no
 * additional inputs) is an `invalid-config` transform error.
 */
type TransformSpec =
  | { readonly kind: "rename" }
  | { readonly kind: "coerce"; readonly conversion: CoerceConfig }
  | { readonly kind: "aggregate"; readonly combine: AggregateConfig }
  | { readonly kind: "expression"; readonly expression: string };

function resolveTransformSpec(field: FieldMapping): TransformSpec {
  switch (field.transform) {
    case "rename":
      return { kind: "rename" };
    case "coerce": {
      const conversion = field.transformConfig?.coerce;
      if (conversion === undefined) {
        throw new TransformError(
          "invalid-config",
          "coerce field is missing its transformConfig.coerce spec",
        );
      }
      return { kind: "coerce", conversion };
    }
    case "aggregate": {
      const combine = field.transformConfig?.aggregate;
      if (combine === undefined) {
        throw new TransformError(
          "invalid-config",
          "aggregate field is missing its transformConfig.aggregate spec",
        );
      }
      if (additionalInputPaths(field).length === 0) {
        throw new TransformError(
          "invalid-config",
          "aggregate field declares no additional input paths (aggregate is multi-input)",
        );
      }
      return { kind: "aggregate", combine };
    }
    case "expression": {
      const expression = field.transformConfig?.expression;
      if (expression === undefined || expression.trim().length === 0) {
        throw new TransformError(
          "invalid-config",
          "expression field is missing its transformConfig.expression text",
        );
      }
      return { kind: "expression", expression };
    }
  }
}

// ── apply one field ─────────────────────────────────────────────────────────

/** The value one `FieldMapping` produced, plus its declared participation. */
export interface FieldTransformResult {
  readonly value: JsonValue;
  readonly participation: FieldParticipation;
}

/**
 * Apply a single `FieldMapping` to a source record, producing the target value.
 * Raises a {@link TransformError} (attributed to the field's id) if the transform
 * cannot produce a valid output — never a fabricated or partial value (TX-5).
 */
export function applyFieldMapping(
  field: FieldMapping,
  source: JsonRecord,
  options?: ApplyOptions,
): FieldTransformResult {
  try {
    const value = computeValue(field, source, options);
    return { value, participation: fieldParticipation(field) };
  } catch (error) {
    throw attributeToField(error, field.id);
  }
}

function computeValue(field: FieldMapping, source: JsonRecord, options?: ApplyOptions): JsonValue {
  const spec = resolveTransformSpec(field);
  switch (spec.kind) {
    case "rename":
      return applyRename(field, source);
    case "coerce":
      return applyCoerceField(field, source, spec.conversion);
    case "aggregate":
      return applyAggregate(spec.combine, readAllInputs(field, source));
    case "expression":
      return applyExpressionField(field, source, spec.expression, options);
  }
}

function applyRename(field: FieldMapping, source: JsonRecord): JsonValue {
  const read = readPath(source, recordRelativePath(field.sourcePath));
  if (!read.present) {
    throw new TransformError(
      "missing-input",
      `rename: source path '${field.sourcePath}' is absent`,
    );
  }
  // Value-preserving carry: the value (including null) is passed through unchanged
  // (TX-1 criterion 2) — the property that makes rename the only identity-key transform.
  return read.value;
}

function applyCoerceField(
  field: FieldMapping,
  source: JsonRecord,
  conversion: CoerceConfig,
): JsonValue {
  const read = readPath(source, recordRelativePath(field.sourcePath));
  if (!read.present || read.value === null) {
    throw new TransformError(
      "missing-input",
      `coerce: source path '${field.sourcePath}' is absent or null`,
    );
  }
  return applyCoerce(conversion, read.value);
}

function readAllInputs(field: FieldMapping, source: JsonRecord): PathRead[] {
  return [field.sourcePath, ...additionalInputPaths(field)].map((path) =>
    readPath(source, recordRelativePath(path)),
  );
}

function applyExpressionField(
  field: FieldMapping,
  source: JsonRecord,
  expression: string,
  options?: ApplyOptions,
): JsonValue {
  const limits = resolveSandboxLimits(options?.sandboxLimits);
  const bindings = new Map<string, JsonValue>();
  for (const path of [field.sourcePath, ...additionalInputPaths(field)]) {
    const relative = recordRelativePath(path);
    const name = leafName(relative);
    if (bindings.has(name)) {
      throw new TransformError(
        "invalid-config",
        `expression: input paths collide on binding name '${name}' (last path segment must be unique)`,
      );
    }
    const read = readPath(source, relative);
    // A declared input that is absent resolves to the documented null placeholder
    // (TX-3 criterion 4), so every declared name always resolves during evaluation.
    bindings.set(name, read.present ? read.value : null);
  }
  const compiled = compileExpression(expression, {
    maxNodes: limits.maxNodes,
    identifierNames: new Set(bindings.keys()),
  });
  return evaluateSafeExpr(compiled, bindings, limits);
}

function leafName(path: string): string {
  const segments = pathSegments(path);
  const leaf = segments[segments.length - 1];
  if (leaf === undefined) {
    throw new TransformError("invalid-config", "an input path is empty");
  }
  return leaf;
}

// ── apply a whole mapping ────────────────────────────────────────────────────

/**
 * Apply every `FieldMapping` to a source record, assembling the target payload.
 * The whole assembly fails on the first field that cannot produce a valid output —
 * the executor never emits a corrupted or partial payload (TX-5 criterion 2). On
 * success it returns the assembled payload and the field-participation trace.
 */
export function applyFieldMappings(
  fields: readonly FieldMapping[],
  source: JsonRecord,
  options?: ApplyOptions,
): AppliedMapping {
  const output: JsonRecord = {};
  for (const field of fields) {
    const { value } = applyFieldMapping(field, source, options);
    try {
      setPath(output, recordRelativePath(field.targetPath), value);
    } catch (error) {
      if (error instanceof SetPathError) {
        throw new TransformError("invalid-config", error.message, {
          fieldMappingId: field.id,
          cause: error,
        });
      }
      throw error;
    }
  }
  return { output, trace: collectTouchedFields(fields) };
}

/**
 * Re-raise a transform failure attributed to the failing `FieldMapping`. A
 * {@link TransformError} that already names a field is passed through; an
 * unattributed one is re-stamped with the field id (keeping its kind and cause).
 * A non-`TransformError` is unexpected and rethrown untouched.
 */
function attributeToField(error: unknown, fieldMappingId: string): unknown {
  if (error instanceof TransformError) {
    if (error.fieldMappingId !== undefined) {
      return error;
    }
    return new TransformError(error.kind, error.message, { fieldMappingId, cause: error.cause });
  }
  return error;
}
