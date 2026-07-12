/**
 * The JSON value model the Transformation Executor operates over.
 *
 * Live payload data reaching the executor is JSON already (a polled API response,
 * an inbound adapter request body), so the whole module reasons over this closed
 * value type — never arbitrary host objects. Reads and writes go exclusively
 * through {@link readPath} / {@link setPath}, which navigate **own** data
 * properties only and refuse the prototype-pollution keys, so no host state is
 * ever reachable through a `sourcePath`/`targetPath`.
 */

/** A JSON scalar. `undefined` is deliberately *not* a JSON value. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON value: a scalar, an array, or a plain object. */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object — the top-level shape of a source record and a target payload. */
export type JsonRecord = { [key: string]: JsonValue };

/** Keys that could reach or mutate a host prototype; never navigated or written. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** The outcome of reading a path: the value if the path resolves, else absent. */
export type PathRead =
  { readonly present: true; readonly value: JsonValue } | { readonly present: false };

const ABSENT: PathRead = { present: false };

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split a dotted IR path (`"issue.author.name"`) into its non-empty segments. */
export function pathSegments(path: string): string[] {
  return path.split(".").filter((segment) => segment.length > 0);
}

/**
 * Read a dotted path out of a JSON record. Returns a tagged `present`/absent
 * result so a caller can distinguish "the field is there and holds `null`" from
 * "the field is not there at all" — a distinction the transforms rely on to
 * resolve missing inputs deterministically rather than by best-effort.
 *
 * Navigates plain-object keys and numeric array indices only, through **own**
 * enumerable data properties; a forbidden prototype key resolves to absent.
 */
export function readPath(record: JsonValue, path: string): PathRead {
  const segments = pathSegments(path);
  let current: JsonValue = record;
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) {
      return ABSENT;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return ABSENT;
      }
      const index = Number(segment);
      if (index >= current.length) {
        return ABSENT;
      }
      const next = current[index];
      if (next === undefined) {
        return ABSENT;
      }
      current = next;
      continue;
    }
    if (isJsonObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        return ABSENT;
      }
      const next = current[segment];
      if (next === undefined) {
        return ABSENT;
      }
      current = next;
      continue;
    }
    // A scalar with path still to traverse — the path does not resolve.
    return ABSENT;
  }
  return { present: true, value: current };
}

/**
 * The reason {@link setPath} refused to write — surfaced by the executor as an
 * `invalid-config` transform error (a `targetPath` is approved-mapping config,
 * never live data).
 */
export class SetPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SetPathError";
  }
}

/**
 * Write `value` into `target` at a dotted path, minting intermediate objects as
 * needed. Refuses forbidden prototype keys and refuses to descend through a
 * non-object already sitting at an intermediate segment (an ambiguous target
 * shape) — both raise {@link SetPathError}.
 */
export function setPath(target: JsonRecord, path: string, value: JsonValue): void {
  const segments = pathSegments(path);
  if (segments.length === 0) {
    throw new SetPathError("targetPath is empty");
  }
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) {
      throw new SetPathError(`targetPath segment '${segment}' is not allowed`);
    }
  }
  let cursor: JsonRecord = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (segment === undefined) {
      throw new SetPathError("targetPath segment is undefined");
    }
    const existing = Object.prototype.hasOwnProperty.call(cursor, segment)
      ? cursor[segment]
      : undefined;
    if (existing === undefined) {
      const created: JsonRecord = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new SetPathError(`targetPath segment '${segment}' collides with a non-object value`);
    }
    cursor = existing;
  }
  const last = segments[segments.length - 1];
  if (last === undefined) {
    throw new SetPathError("targetPath leaf is undefined");
  }
  cursor[last] = value;
}
