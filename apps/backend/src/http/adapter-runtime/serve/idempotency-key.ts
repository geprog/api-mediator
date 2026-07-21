import { createHash } from "node:crypto";

import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation } from "@mediator/domain";
import { canonicalJson } from "@mediator/outbound";
import type { JsonValue } from "@mediator/transform";

import { buildConsumerParamSource } from "./request-mapping.js";

/**
 * **WR-3 — the adapter write's idempotency key.** A write is deduplicated within the
 * write-outcome store's lookback window by this key:
 *
 * - **Declared passthrough (WR-3.1)** — when the consumer operation *declares* an
 *   idempotency-key parameter and the caller supplied it, the caller's value is the
 *   key. This is how a consumer that genuinely needs to repeat byte-identical writes
 *   makes that intent expressible (WR-3.7) — there is no per-request "force" bypass.
 * - **Derived (WR-3.2)** — otherwise a deterministic key is derived from the request
 *   itself, over `(endpoint id, binding id, method, path, path params, query, body)`.
 *   This deliberately biases toward *at-most-once*: two byte-identical writes inside
 *   the window collide on one key and read as a single delivery.
 *
 * Both forms are **namespaced by `endpoint id + binding id`** and hashed, so a
 * caller-supplied key can never collide across two endpoints/bindings, and the stored
 * key stays an opaque, fixed-length identifier (safe to record in the Audit Log —
 * WR-5.4).
 *
 * ## Reuse of the OC-2 treatment
 *
 * The **canonical-JSON primitive** (`canonicalJson`) is reused verbatim from the
 * Phase-4 OC-2 idempotency treatment — the same sorted-key serialization the sync
 * write key uses — so the two never drift on *what canonicalization means*. OC-2 does
 * not export its private SHA-256 wrapper, so the one-line digest below is replicated
 * (the `sha256Hex` helper); this is the only replicated piece. The **inputs** here are
 * deliberately different from `computeWriteIdempotencyKey`'s (which keys on mapping id
 * + source native id + payload + prior reconciled state): an adapter write is keyed on
 * the *inbound request's identity*, not on a sync change's reconciled state, so this is
 * a distinct key derivation that shares the primitive — not a second implementation of
 * the same one. The scheme tag (`wr-idem-v1`) keeps the two key spaces disjoint.
 */

/** The versioned scheme tag folded into the key, disjoint from OC-2's `oc-idem-v1`. */
const ADAPTER_WRITE_KEY_SCHEME = "wr-idem-v1";

/**
 * The declared idempotency-key parameter's name (case-insensitive). The header/param
 * *name* is an implementation choice the concept leaves open (adapter-engine.md
 * *Write operations* — *Idempotency*); this is the convention the mediator recognizes.
 */
const DECLARED_IDEMPOTENCY_PARAM = "idempotency-key";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Narrow an already-JSON-parsed value to a {@link JsonValue} for canonicalization.
 * Total and deterministic: a non-JSON leaf (which a parsed request body never
 * contains) collapses to `null` rather than throwing in the live write path, and
 * `undefined`-valued object keys are dropped (they are not JSON).
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "object": {
      if (Array.isArray(value)) {
        return value.map(toJsonValue);
      }
      const out: { [key: string]: JsonValue } = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child !== undefined) {
          out[key] = toJsonValue(child);
        }
      }
      return out;
    }
    default:
      // undefined / bigint / function / symbol — not JSON.
      return null;
  }
}

/**
 * The caller-supplied value of the operation's declared idempotency-key parameter
 * (WR-3.1), or `undefined` when the operation declares none or the caller supplied no
 * value. A blank supplied value counts as absent, falling back to the derived key.
 */
export function declaredIdempotencyKeyValue(
  operation: IrOperation,
  request: AdapterRequest,
): string | undefined {
  const declared = operation.parameters.find(
    (parameter) =>
      parameter.location !== "cookie" &&
      parameter.name.toLowerCase() === DECLARED_IDEMPOTENCY_PARAM,
  );
  if (declared === undefined) {
    return undefined;
  }
  const supplied = buildConsumerParamSource(operation, request)[declared.name];
  return typeof supplied === "string" && supplied.length > 0 ? supplied : undefined;
}

/** The inputs the write key is derived from. */
export interface AdapterWriteKeyInput {
  readonly endpointId: string;
  readonly bindingId: string;
  readonly consumerOperation: IrOperation;
  readonly request: AdapterRequest;
}

/** How the resolved key was obtained — a caller passthrough vs. a request-derived hash. */
export type IdempotencyKeySource = "declared" | "derived";

/** The resolved write key plus how it was obtained (for observability/tests). */
export interface AdapterWriteIdempotencyKey {
  readonly key: string;
  readonly source: IdempotencyKeySource;
}

/**
 * Resolve a write's idempotency key (WR-3.1/3.2). A declared caller value is hashed
 * with the endpoint/binding namespace; otherwise the key is derived from the request's
 * full identity under the same namespace. The result is always an opaque SHA-256 hex
 * digest.
 */
export function resolveAdapterWriteIdempotencyKey(
  input: AdapterWriteKeyInput,
): AdapterWriteIdempotencyKey {
  const declared = declaredIdempotencyKeyValue(input.consumerOperation, input.request);
  if (declared !== undefined) {
    const material: JsonValue = {
      v: ADAPTER_WRITE_KEY_SCHEME,
      kind: "declared",
      endpointId: input.endpointId,
      bindingId: input.bindingId,
      key: declared,
    };
    return { key: sha256Hex(canonicalJson(material)), source: "declared" };
  }
  const material: JsonValue = {
    v: ADAPTER_WRITE_KEY_SCHEME,
    kind: "derived",
    endpointId: input.endpointId,
    bindingId: input.bindingId,
    method: input.consumerOperation.method,
    path: input.consumerOperation.path,
    pathParameters: toJsonValue(input.request.pathParameters),
    query: toJsonValue(input.request.query),
    body: toJsonValue(input.request.body),
  };
  return { key: sha256Hex(canonicalJson(material)), source: "derived" };
}
