/**
 * **The single definition of the qualified↔bare boundary for `FieldMapping` paths.**
 *
 * `FieldMapping.sourcePath`/`targetPath` are **resource-qualified IR paths**
 * (`docs/architecture/data-model.md` `FieldMapping`): `resourceRef/path`, e.g.
 * `issues/title` or `issues/assignee.name`. The qualification is load-bearing —
 * one `ApprovedMapping` covers **N resource pairs** (see `SyncRule` in the same
 * document: "one `SyncRule` per mapped resource pair … a mapping covering four
 * resource pairs yields four independently enable-able rules"), and the row itself
 * carries no pair reference, so the leading `resourceRef` is the only thing that
 * says which pair a field belongs to. The artifact-instantiation pair enumeration
 * and the SS-18 `ScopeCorrespondence` walk both consume it.
 *
 * Live payload JSON, however, is **record-relative**: a polled record has a `title`
 * key, never an `issues/title` key. So every path that meets a live record — a
 * `readPath` over an observed/candidate record, a `setPath` building a target write
 * payload — must first be reduced to its record-relative form by
 * {@link recordRelativePath}. That reduction is the boundary, and this module is
 * the only place it is defined: no consumer splits on `/` for itself.
 *
 * Paths that stay **qualified** (deliberately, and *not* routed through here):
 *  - the `SyncFieldState.fieldPath` key space (seeder + loop-prevention agree on it);
 *  - the resource-pair enumeration that emits `SyncRule`s.
 */

/** A parsed resource-qualified field ref: the resource, plus the record-relative path. */
export interface FieldRef {
  /** The resource group the field belongs to (`issues`) — never contains `/`. */
  readonly resourceRef: string;
  /** The record-relative, dot-separated IR path within that resource (`assignee.name`). */
  readonly path: string;
}

/**
 * Serialize a {@link FieldRef} into its stored `resourceRef/path` form. The inverse
 * of {@link parseFieldRef} for every well-formed ref.
 *
 * Deliberately distinct from the approval module's operation/parameter ref
 * serializer: an operation ref (`issues/updateIssue`) is parsed back by the target
 * resolvers as a resource + operation id, and must keep its prefix at every
 * consumer. Only *field* paths cross into record-relative space.
 */
export function serializeFieldRef(ref: FieldRef): string {
  return `${ref.resourceRef}/${ref.path}`;
}

/**
 * Parse a stored `resourceRef/path` field ref into its two parts, or `undefined`
 * when `serialized` carries no resource qualification (no `/`), an empty
 * `resourceRef`, or an empty `path`.
 *
 * Splits on the **first** `/`: a `resourceRef` is a path noun containing no `/`,
 * while an IR field path is dot-separated, so the first separator divides them
 * unambiguously.
 */
export function parseFieldRef(serialized: string): FieldRef | undefined {
  const slash = serialized.indexOf("/");
  if (slash <= 0 || slash >= serialized.length - 1) {
    return undefined;
  }
  return { resourceRef: serialized.slice(0, slash), path: serialized.slice(slash + 1) };
}

/**
 * Reduce a stored field path to the **record-relative** form live payload JSON
 * actually uses — the function every `readPath`/`setPath` call site goes through.
 *
 * Tolerant by design: an already-unqualified path is returned unchanged rather
 * than rejected. Qualification is a property of how a path was *authored*, and not
 * every producer in the system emits it (the Phase-4 SU-6 capstone and much of the
 * unit-test corpus seed bare paths directly), so a strict parse here would fail
 * records it can read perfectly well. The tolerance is safe in the direction that
 * matters: a bare path stays bare, so this can never *introduce* the absent-read
 * that qualification caused — it only ever removes it.
 */
export function recordRelativePath(fieldPath: string): string {
  return parseFieldRef(fieldPath)?.path ?? fieldPath;
}

/**
 * The resource-group portion of a stored field path, or `undefined` when the path
 * carries no qualification. Lets a consumer scope a mapping's `FieldMapping`s to
 * one resource pair (the sync rule-artifact resolution does exactly this).
 */
export function fieldResourceRef(fieldPath: string): string | undefined {
  return parseFieldRef(fieldPath)?.resourceRef;
}
