import type { FieldMapping, ScopePathBinding, ScopeTransform } from "@mediator/domain";
import { isValuePreservingScopeTransform, stripUndefined } from "@mediator/domain";
import { applyFieldMapping, type CapturedScope, type JsonValue } from "@mediator/transform";

/**
 * **`record-derived` scope pre-resolution** (SS-8b, Layer 2) — turn a target resource's
 * confirmed `record-derived` scope path-parameter bindings + one change's **captured
 * scope** into the `{ parameterName → value }` map the shared scope-fill
 * ({@link fillScopePathParameters}) substitutes **uniformly alongside `constant`s**.
 *
 * Keeping the record-derived resolution here (rather than in `path-template.ts`) keeps
 * the pure path-template helper transform-free; the resolvers
 * ({@link resolveWriteOperationBinding} / {@link resolveSingleRecordRead}) pre-resolve
 * this map from the change's captured scope and hand it to the fill, so the fill logic
 * stays one code path over both `constant` and `record-derived` kinds.
 *
 * ## Fill selection + the value-preserving transform
 *
 * For each **confirmed** `record-derived` entry, the captured component named by the
 * entry's `sourceScopeKey` is read from the captured scope and — when the entry carries
 * a `transform` — run through the **Transformation Executor** ({@link applyFieldMapping})
 * exactly as any other field transform, for correctness/consistency. The transform is
 * **value-preserving only** (a `rename` passes the value through unchanged; the domain
 * schema + confirm-time already reject a value-altering one — SS-8 criterion 3); a
 * non-value-preserving transform is refused here too (the component is omitted, so the
 * fill fails loudly rather than altering a scope that must round-trip).
 *
 * ## Fail loudly on a missing / unusable component
 *
 * A `record-derived` parameter whose `sourceScopeKey` is **absent from the captured
 * scope** (the source record did not carry that component, or `sourceScopeRef` was not
 * confirmed so nothing was captured — detectable by key presence, per SS-7's helper) is
 * **omitted** from the returned map — never defaulted, never fabricated. Downstream the
 * fill then leaves the `{…}` unfilled and unresolves (the resolver returns `undefined` /
 * the outbound backstop refuses the call — SS-8.3), so an incomplete scope is a refused
 * write, never a silent wrong-scope one. A captured value that cannot be a URL path
 * segment (JSON `null`/object/array) is likewise omitted (fail loud).
 */

/** The synthetic single-field record key the scope transform reads/writes through the executor. */
const SCOPE_VALUE_KEY = "value";

/**
 * Resolve the `{ parameterName → value }` map for the **confirmed** `record-derived`
 * entries of `scopePathBindings` whose captured component is present and usable. A
 * parameter with a missing/unusable component (or a non-value-preserving transform) is
 * omitted, so {@link fillScopePathParameters} fails loudly on it (SS-8.3). `constant` /
 * unconfirmed / `scope-link` entries are ignored here (constants fill from their literal;
 * `scope-link` is Layer 3).
 */
export function resolveRecordDerivedScopeValues(
  scopePathBindings: readonly ScopePathBinding[],
  capturedScope: CapturedScope,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const binding of scopePathBindings) {
    if (binding.kind !== "record-derived") {
      continue;
    }
    // Used nowhere until confirmed (mirrors every other binding's discipline).
    if (binding.confirmedBy === null || binding.confirmedAt === null) {
      continue;
    }
    // Presence, not truthiness: `key in map` distinguishes an absent component from one
    // captured as JSON `null` (SS-7's helper omits absent components entirely).
    if (!Object.prototype.hasOwnProperty.call(capturedScope, binding.sourceScopeKey)) {
      continue; // missing captured component → omit → fill fails loudly (never fabricated).
    }
    const captured = capturedScope[binding.sourceScopeKey];
    if (captured === undefined) {
      continue;
    }
    const transformed = applyScopeTransform(captured, binding.transform);
    if (transformed === undefined) {
      continue; // a value-altering / failed transform never touches a captured scope.
    }
    const asString = toScopeParamString(transformed);
    if (asString === undefined) {
      continue; // null / object / array is not a usable scope path segment → fail loud.
    }
    values.set(binding.parameterName, asString);
  }
  return values;
}

/**
 * Apply a `record-derived` binding's optional value-preserving `transform` to one
 * captured value through {@link applyFieldMapping} (the same executor the pipeline
 * transforms fields with). No transform → the value passes through unchanged. A
 * non-value-preserving transform, or a transform that raises, yields `undefined` (the
 * caller then omits the parameter → the fill fails loudly).
 */
function applyScopeTransform(
  value: JsonValue,
  transform: ScopeTransform | undefined,
): JsonValue | undefined {
  if (transform === undefined) {
    return value;
  }
  if (!isValuePreservingScopeTransform(transform)) {
    return undefined;
  }
  const field: FieldMapping = stripUndefined({
    id: "record-derived-scope-transform",
    mappingId: "record-derived-scope-transform",
    sourcePath: SCOPE_VALUE_KEY,
    targetPath: SCOPE_VALUE_KEY,
    transform: transform.kind,
    transformConfig: transform.config,
  });
  try {
    return applyFieldMapping(field, { [SCOPE_VALUE_KEY]: value }).value;
  } catch {
    return undefined;
  }
}

/**
 * Stringify a captured scope value for use as a URL path segment. Only a scalar
 * (string / finite number / boolean) is a usable scope value; JSON `null`, an object,
 * or an array is **not** — those return `undefined` so the fill refuses rather than
 * composing a nonsense path.
 */
function toScopeParamString(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
