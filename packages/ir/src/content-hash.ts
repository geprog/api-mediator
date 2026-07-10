import { createHash } from "node:crypto";

import { isRecord } from "./json.js";

/**
 * A deterministic content fingerprint of a raw OpenAPI document (SI-2).
 *
 * The document is serialized to a **canonical** JSON string with object keys
 * sorted recursively, then hashed with SHA-256. Two consequences follow directly
 * from the SI-2 criteria:
 *
 * - **Deterministic** (crit 2): a byte-identical re-submission hashes equal. The
 *   canonical form is also key-order-independent, so two serializations of the
 *   same document that differ only in key order hash equal too — a strictly
 *   stronger guarantee than byte-identity.
 * - **Sensitive** (crit 3): any materially different value changes the canonical
 *   string and therefore the hash.
 *
 * `document` is the parsed document (an object); a JSON string may be passed
 * through {@link JSON.parse} by the caller first. Values JSON cannot represent
 * (`undefined`, functions, symbols) are treated as `null`, matching
 * {@link JSON.stringify} semantics.
 */
export function computeContentHash(document: unknown): string {
  return createHash("sha256").update(canonicalize(document)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  // undefined / function / symbol / bigint — not representable in JSON.
  return "null";
}
