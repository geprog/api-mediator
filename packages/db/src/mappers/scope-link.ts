import type { ScopeLink } from "@mediator/domain";

import { scopeLink } from "../schema.js";

/** A selected `scope_link` row, with Drizzle's inferred column types. */
export type ScopeLinkRow = typeof scopeLink.$inferSelect;
/** The insert shape Drizzle expects for `scope_link`. */
export type ScopeLinkInsert = typeof scopeLink.$inferInsert;

/**
 * Row → domain. Every `scope_link` column maps 1:1: the `app_*_scope_key` `jsonb`
 * maps carry no `Date` (they round-trip verbatim) and `created_at` is a real
 * `timestamptz` (a `Date`). No optional/nullable domain field, so no
 * {@link stripUndefined} pass is needed.
 */
export function mapScopeLinkRow(row: ScopeLinkRow): ScopeLink {
  return {
    id: row.id,
    scopeCorrespondenceId: row.scopeCorrespondenceId,
    appAId: row.appAId,
    appAScopeKey: row.appAScopeKey,
    appBId: row.appBId,
    appBScopeKey: row.appBScopeKey,
    resourcePairRef: row.resourcePairRef,
    establishedBy: row.establishedBy,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** Domain → insert. */
export function toScopeLinkInsert(link: ScopeLink): ScopeLinkInsert {
  return {
    id: link.id,
    scopeCorrespondenceId: link.scopeCorrespondenceId,
    appAId: link.appAId,
    appAScopeKey: link.appAScopeKey,
    appBId: link.appBId,
    appBScopeKey: link.appBScopeKey,
    resourcePairRef: link.resourcePairRef,
    establishedBy: link.establishedBy,
    status: link.status,
    createdAt: link.createdAt,
  };
}
