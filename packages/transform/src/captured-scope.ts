import type { SourceScopeRef } from "@mediator/domain";

import { readPath, type JsonValue } from "./json.js";

/**
 * The **captured scope** of one source record (`docs/glossary.md` *captured scope*;
 * SS-7 crit 5): the `{ component-key → value }` map extracted from the record via
 * its resource's confirmed `sourceScopeRef` — Gitea `{ owner: "alice", name:
 * "phoenix" }`, Vikunja `{ project: 42 }`.
 */
export type CapturedScope = { [key: string]: JsonValue };

/**
 * Extract a source record's **captured scope** from its resource's
 * `sourceScopeRef` (SS-7 crit 5): read each component's `fieldPath` out of the
 * record and key it under that component's `key`. A pure function — no I/O, no
 * mutation of the record — using the same `readPath` navigation as the
 * Transformation Executor (own data properties only, prototype-pollution keys
 * refused).
 *
 * **Missing-field behavior:** a component whose `fieldPath` does not resolve in the
 * record (the field is absent, or a segment runs into a scalar/array) is
 * **omitted** from the result — never emitted as `null` or a placeholder. So the
 * caller (a `record-derived` target scope binding — SS-8) can tell a fully-captured
 * scope apart from an incomplete one by comparing the returned key count against
 * the ref's component count, and refuse to route on a partial scope rather than
 * fabricate a container from a missing value. A present field holding JSON `null`
 * *is* captured (it resolved), matching `readPath`'s present/absent distinction.
 *
 * This slice delivers the tested helper only; wiring it into the Poller is SS-8.
 */
export function extractCapturedScope(
  record: JsonValue,
  sourceScopeRef: SourceScopeRef,
): CapturedScope {
  const captured: CapturedScope = {};
  for (const component of sourceScopeRef.components) {
    const read = readPath(record, component.fieldPath);
    if (read.present) {
      captured[component.key] = read.value;
    }
  }
  return captured;
}
