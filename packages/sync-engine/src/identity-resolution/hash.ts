import { createHash } from "node:crypto";

import type { JsonValue } from "@mediator/transform";

/**
 * A deterministic content hash for a single field value — what `SyncFieldState`'s
 * `lastSyncedHash`/`observedHash` store (`docs/architecture/data-model.md`
 * `SyncFieldState`). The seed hashes each side's value in its own representation, and
 * echo/conflict detection (EP/CF, later) compare against these, so the function need
 * only be **internally consistent and deterministic**, not match the Outbound Call
 * Executor's payload hash (a distinct concern; `@mediator/outbound` cannot be
 * imported here without a dependency cycle, so the small canonical serializer is
 * duplicated deliberately).
 */

const FIELD_HASH_SCHEME = "rl-field-v1";

/**
 * Canonical JSON: object keys sorted lexicographically (arrays keep order), so two
 * structurally-equal values always serialize identically. `undefined` is not a JSON
 * value and cannot occur in a {@link JsonValue}.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const child = value[key];
    // `noUncheckedIndexedAccess`: an own enumerable key always has a value here.
    return `${JSON.stringify(key)}:${canonicalJson(child as JsonValue)}`;
  });
  return `{${members.join(",")}}`;
}

/** The `SyncFieldState` hash of one field value (canonical JSON, SHA-256). */
export function hashFieldValue(value: JsonValue): string {
  return createHash("sha256")
    .update(`${FIELD_HASH_SCHEME}:${canonicalJson(value)}`, "utf8")
    .digest("hex");
}

/** Whether two field values are equal by canonical content (the seed's agree/disagree test). */
export function valuesAgree(a: JsonValue, b: JsonValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * The **ordering-queue key string** for an identity value: a string passes through
 * as-is, any other JSON value is its canonical serialization. This is the single
 * source of truth for the pre-link identity-value key, shared by the Identity
 * Resolution stage (which retains it as `RecordLink.establishingQueueKey.value`) and
 * the OQ-3 `QueueKeyResolver` (which computes it at enqueue). They **must** agree
 * verbatim, or the OQ-4 continuation gate could not recognize a link-keyed entry's
 * establishing queue — hence the one shared function (`docs/architecture/sync-engine.md`
 * *Ordering and consistency*, *Identity correlation*: the value-preserving identity
 * pairing makes this the same string from either direction).
 */
export function stringifyIdentityValue(value: JsonValue): string {
  return typeof value === "string" ? value : canonicalJson(value);
}
