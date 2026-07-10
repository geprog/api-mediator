/**
 * Narrowing helpers for the **untyped OpenAPI document**.
 *
 * An OpenAPI document arrives as `unknown` (SI-1 parses arbitrary operator
 * input); after bundling it is a plain JSON tree with only local (`#/…`)
 * `$ref`s. The project forbids `any`, so the builder reads that tree exclusively
 * through these guards — narrowing `unknown` deliberately at the parser boundary
 * — plus a small JSON-Pointer resolver for the local refs.
 */

/** A plain JSON object with `unknown`-typed values (never `null`/array). */
export type JsonObject = { readonly [key: string]: unknown };

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return `value` as a {@link JsonObject}, or `undefined` if it is not one. */
export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function getRecord(obj: JsonObject, key: string): JsonObject | undefined {
  return asRecord(obj[key]);
}

export function getString(obj: JsonObject, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

export function getBoolean(obj: JsonObject, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === "boolean" ? value : undefined;
}

export function getArray(obj: JsonObject, key: string): readonly unknown[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

/** Decode one JSON-Pointer reference token (`~1` → `/`, `~0` → `~`). */
export function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Resolve a local JSON-Pointer `$ref` (`#/components/schemas/Foo`) against
 * `root`. Returns `undefined` for external refs (none remain after bundling) or
 * for pointers that do not resolve.
 */
export function resolvePointer(root: JsonObject, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref.slice(2).split("/").map(decodePointerSegment);
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The trailing name of a `$ref` (`#/components/schemas/Foo` → `Foo`). */
export function refName(ref: string): string | undefined {
  const index = ref.lastIndexOf("/");
  if (index < 0) return undefined;
  const segment = ref.slice(index + 1);
  return segment.length > 0 ? decodePointerSegment(segment) : undefined;
}
