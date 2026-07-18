import { type ScopeCorrespondence, stripUndefined } from "@mediator/domain";

import { scopeCorrespondence } from "../schema.js";

/** A selected `scope_correspondence` row, with Drizzle's inferred column types. */
export type ScopeCorrespondenceRow = typeof scopeCorrespondence.$inferSelect;
/** The insert shape Drizzle expects for `scope_correspondence`. */
export type ScopeCorrespondenceInsert = typeof scopeCorrespondence.$inferInsert;

/**
 * Row → domain. `source_container_ref` collapses NULL → an **absent** domain key
 * ({@link stripUndefined}), matching the optional `sourceContainerRef`. The
 * `scope_identity_key` / `target_container_ref` `jsonb` columns carry no `Date`, so
 * they round-trip verbatim; `confirmed_at` is a real `timestamptz`, so it comes back
 * as a `Date` (or `null`) directly.
 */
export function mapScopeCorrespondenceRow(row: ScopeCorrespondenceRow): ScopeCorrespondence {
  return stripUndefined({
    id: row.id,
    resourcePairRef: row.resourcePairRef,
    scopeIdentityKey: row.scopeIdentityKey,
    targetContainerRef: row.targetContainerRef,
    sourceContainerRef: row.sourceContainerRef ?? undefined,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt,
  });
}

/** Domain → insert. An absent `sourceContainerRef` becomes a NULL column. */
export function toScopeCorrespondenceInsert(
  correspondence: ScopeCorrespondence,
): ScopeCorrespondenceInsert {
  return {
    id: correspondence.id,
    resourcePairRef: correspondence.resourcePairRef,
    scopeIdentityKey: correspondence.scopeIdentityKey,
    targetContainerRef: correspondence.targetContainerRef,
    sourceContainerRef: correspondence.sourceContainerRef ?? null,
    confirmedBy: correspondence.confirmedBy,
    confirmedAt: correspondence.confirmedAt,
  };
}
