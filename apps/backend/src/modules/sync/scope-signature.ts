import type { ScopeIdentityKey, ScopeKey } from "@mediator/domain";
import { isValuePreservingScopeTransform } from "@mediator/domain";
import { scopeIdentitySignature } from "@mediator/sync-engine";
import { readPath, type CapturedScope, type JsonRecord, type JsonValue } from "@mediator/transform";

/**
 * **Scope-identity signature computation** for SS-11 discovery — the value-preserving
 * side of matching two containers. Kept pure (no I/O) so the invariant logic is unit-
 * testable in isolation, and shared by both the enumerated (both-enumerable) and
 * harvested (record-carried) source paths so their signatures are computed identically.
 *
 * A container's **signature** is {@link scopeIdentitySignature} over the scope-identity-key
 * pairing values in pairing order — the source value read from its captured scope, the
 * target value read from the target container record. The scope identity key is
 * **value-preserving** (SS-10.2 already rejects a value-altering pairing at confirm time),
 * so the values are compared **AS-IS** (a `rename` pairing passes the value through
 * unchanged) — mirroring RL-3.3's use of the identity value AS-IS. A component whose
 * value is missing / unusable yields `undefined` (the container is not matchable — fail
 * loud, never a fabricated match).
 */

/**
 * The identity signature of a **source** scope (captured from a source record via its
 * `sourceScopeRef`, or from an enumerated source container). `undefined` when any pairing
 * component is absent from the captured scope, is unusable as a scalar, or carries a
 * value-altering transform (rejected — the value must round-trip).
 */
export function sourceScopeSignature(
  captured: CapturedScope,
  scopeIdentityKey: ScopeIdentityKey,
): string | undefined {
  const values: JsonValue[] = [];
  for (const pairing of scopeIdentityKey) {
    if (!Object.prototype.hasOwnProperty.call(captured, pairing.sourceScopeKey)) {
      return undefined;
    }
    if (pairing.transform !== undefined && !isValuePreservingScopeTransform(pairing.transform)) {
      return undefined;
    }
    // A value-preserving (`rename`) transform passes the value through unchanged, so the
    // captured value is used AS-IS — the same way RL-3 uses the identity value.
    const value = captured[pairing.sourceScopeKey];
    if (value === undefined || !isScalar(value)) {
      return undefined;
    }
    values.push(value);
  }
  return scopeIdentitySignature(values);
}

/**
 * The identity signature of a **target container** record — the target field(s) named by
 * the scope identity key's `targetFieldPath`, read AS-IS. `undefined` when any target
 * field is absent / not a scalar (the container has no comparable identity value).
 */
export function targetContainerSignature(
  record: JsonRecord,
  scopeIdentityKey: ScopeIdentityKey,
): string | undefined {
  const values: JsonValue[] = [];
  for (const pairing of scopeIdentityKey) {
    const read = readPath(record, pairing.targetFieldPath);
    if (!read.present || !isScalar(read.value)) {
      return undefined;
    }
    values.push(read.value);
  }
  return scopeIdentitySignature(values);
}

/**
 * A container's **addressing** scope key (`ScopeLink.appXScopeKey`) from a captured scope
 * — the `{ component → value }` path-parameter map used to reach it. Every component must
 * stringify to a usable scalar; `undefined` when the captured scope is empty or carries an
 * unusable (null/object/array) component. String values pass through, finite numbers /
 * booleans stringify; this is the storage/lookup form, distinct from SS-12's stricter
 * URL-path-segment guard applied when a value actually fills a `{…}`.
 */
export function scopeKeyFromCaptured(captured: CapturedScope): ScopeKey | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured)) {
    const asString = scalarToString(value);
    if (asString === undefined) {
      return undefined;
    }
    out[key] = asString;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isScalar(value: JsonValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function scalarToString(value: JsonValue): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined; // null / object / array is not a usable addressing value
}
