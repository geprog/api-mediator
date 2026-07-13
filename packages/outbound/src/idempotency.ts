import { createHash } from "node:crypto";

import type { JsonValue } from "@mediator/transform";

/**
 * OC-2 — the **deterministic idempotency key** (a risk-register item), and the
 * `payloadHash` written alongside it on the `SyncEvent`.
 *
 * The concept fixes the key *inputs*; the hash algorithm is the implementation
 * choice (`docs/architecture/sync-engine.md` *Idempotency*). This module hashes a
 * canonical JSON encoding of those inputs with SHA-256:
 *
 * - a **write** (create/update) keys on the **mapping id**, the **source record's
 *   native id** (not the `RecordLink` — a create has no link yet), the **resulting
 *   payload**, and the **prior reconciled state** the write was computed from (the
 *   target-side `lastSyncedHash`es of the mapped fields, or a distinguished `none`
 *   marker for a first write). Including the prior state is what makes an A → X → Y
 *   → X revert key **differently** from the first write (same payload, different
 *   prior state) while a true duplicate (same payload *and* same prior state)
 *   collides;
 * - a **delete** (no payload, no prior field state) keys on the mapping id, the
 *   source native id, a distinguished **delete marker**, and the link's
 *   **target-side native id**.
 *
 * Every input is a hash/id/marker — **never a live payload value in the clear**:
 * the payload is folded in only through its canonical hash contribution, and the
 * key itself is opaque.
 */

/** The versioned scheme tag folded into the key, so a future format is distinct. */
const KEY_SCHEME = "oc-idem-v1";
/** The versioned scheme tag for the standalone `payloadHash`. */
const PAYLOAD_HASH_SCHEME = "oc-payload-v1";

/**
 * The prior reconciled state a write was computed from (OC-2 criterion 1):
 *  - `none` — a first write that *establishes* state (a create, or the first write
 *    of a divergent-seeded field): there is no prior reconciled value.
 *  - `reconciled` — the target-side `lastSyncedHash` of each mapped field at
 *    transform time, keyed by the field's path. Canonicalized (sorted keys) into
 *    the key, so the same reconciled state always contributes identically.
 */
export type PriorReconciledState =
  | { readonly kind: "none" }
  | { readonly kind: "reconciled"; readonly fieldHashes: Readonly<Record<string, string>> };

/** The inputs to a write (create/update) idempotency key. */
export interface WriteKeyInput {
  readonly mappingId: string;
  readonly sourceNativeId: string;
  readonly payload: JsonValue;
  readonly priorReconciledState: PriorReconciledState;
}

/** The inputs to a delete idempotency key. */
export interface DeleteKeyInput {
  readonly mappingId: string;
  readonly sourceNativeId: string;
  /** The `RecordLink`'s target-side native id (provided to OC, not read here). */
  readonly targetNativeId: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted lexicographically (arrays keep order), so two
 * structurally-equal JSON values always serialize to the same string. This is what
 * makes the key and payload hash deterministic across re-runs and process
 * restarts. `undefined` is not a JSON value and cannot occur in a {@link JsonValue}.
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

/** Encode the prior reconciled state as a canonical, unambiguous JSON fragment. */
function priorStateValue(state: PriorReconciledState): JsonValue {
  if (state.kind === "none") {
    // A distinguished first-write marker — never collides with a real hash map.
    return { none: true };
  }
  return { hashes: { ...state.fieldHashes } };
}

/**
 * Compute the deterministic idempotency key for a **write** (create/update).
 * A duplicate delivery of the same change (same payload *and* prior state) yields
 * the same key and is deduplicated; a genuine value revert (same payload, different
 * prior state) yields a different key and is never dropped.
 */
export function computeWriteIdempotencyKey(input: WriteKeyInput): string {
  const material: JsonValue = {
    v: KEY_SCHEME,
    kind: "write",
    mappingId: input.mappingId,
    sourceNativeId: input.sourceNativeId,
    payload: input.payload,
    prior: priorStateValue(input.priorReconciledState),
  };
  return sha256Hex(canonicalJson(material));
}

/**
 * Compute the deterministic idempotency key for a **delete**: mapping id + source
 * native id + a distinguished delete marker + the link's target-side native id, so
 * duplicate deliveries of one deletion collide on all four, while a later delete of
 * a re-created record (fresh link, new native ids) keys differently.
 */
export function computeDeleteIdempotencyKey(input: DeleteKeyInput): string {
  const material: JsonValue = {
    v: KEY_SCHEME,
    kind: "delete",
    marker: "delete",
    mappingId: input.mappingId,
    sourceNativeId: input.sourceNativeId,
    targetNativeId: input.targetNativeId,
  };
  return sha256Hex(canonicalJson(material));
}

/**
 * The `SyncEvent.payloadHash` for a write — a hash of the resulting payload alone
 * (distinct from the idempotency key, which also folds in prior state). A delete
 * has no payload and records no `payloadHash`.
 */
export function computePayloadHash(payload: JsonValue): string {
  return sha256Hex(`${PAYLOAD_HASH_SCHEME}:${canonicalJson(payload)}`);
}
