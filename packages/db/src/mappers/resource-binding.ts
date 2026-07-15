import {
  type ConfirmableRef,
  type IrRefTarget,
  type ResourceBinding,
  type ScopePathBinding,
  stripUndefined,
} from "@mediator/domain";

import {
  RESOURCE_BINDING_REF_KINDS,
  type ResourceBindingRefKind,
  type ScopePathBindingRow,
  resourceBinding,
  resourceBindingRef,
} from "../schema.js";

/** A selected `resource_binding` (parent) row. */
export type ResourceBindingRow = typeof resourceBinding.$inferSelect;
/** The insert shape for the `resource_binding` (parent) table. */
export type ResourceBindingInsert = typeof resourceBinding.$inferInsert;
/** A selected `resource_binding_ref` (child) row. */
export type ResourceBindingRefRow = typeof resourceBindingRef.$inferSelect;
/** The insert shape for the `resource_binding_ref` (child) table. */
export type ResourceBindingRefInsert = typeof resourceBindingRef.$inferInsert;

/**
 * A per-ref change for {@link ResourceBindingRepository.update}: correct the
 * ref's `value` and/or set its confirmation. A key is applied only when
 * present, so confirming one ref never touches another's columns.
 * `confirmedBy`/`confirmedAt` may be set to `null` to return a ref to
 * unconfirmed; omitting them leaves the stored confirmation untouched.
 */
export interface ConfirmableRefPatch {
  value?: IrRefTarget;
  confirmedBy?: string | null;
  confirmedAt?: Date | null;
}

/** Per-kind changes for one `ResourceBinding`. */
export type ResourceBindingRefPatch = Partial<Record<ResourceBindingRefKind, ConfirmableRefPatch>>;

/**
 * Parent row + its child ref rows → domain `ResourceBinding`. A ref with no
 * child row is an **absent** key ({@link stripUndefined}), distinct from a
 * present-unconfirmed ref (a row with NULL `confirmed_*`). `confirmed_at` comes
 * back as a real `Date` from the `timestamptz` column.
 */
export function mapResourceBinding(
  bindingRow: ResourceBindingRow,
  refRows: readonly ResourceBindingRefRow[],
): ResourceBinding {
  const refs: Partial<Record<ResourceBindingRefKind, ConfirmableRef>> = {};
  for (const refRow of refRows) {
    refs[refRow.refKind] = {
      value: refRow.value,
      confirmedBy: refRow.confirmedBy,
      confirmedAt: refRow.confirmedAt,
    };
  }
  return stripUndefined({
    id: bindingRow.id,
    apiSpecId: bindingRow.apiSpecId,
    resourceRef: bindingRow.resourceRef,
    nativeIdRef: refs.nativeIdRef,
    collectionReadRef: refs.collectionReadRef,
    paginationRef: refs.paginationRef,
    deltaCursorRef: refs.deltaCursorRef,
    deltaDeletionRef: refs.deltaDeletionRef,
    changeTimestampRef: refs.changeTimestampRef,
    // Always present (the column is NOT NULL, empty for a param-free resource).
    scopePathBindings: bindingRow.scopePathBindings.map(fromScopePathBindingRow),
  });
}

/** Domain → parent (`resource_binding`) insert, including the scope bindings. */
export function toResourceBindingInsert(binding: ResourceBinding): ResourceBindingInsert {
  return {
    id: binding.id,
    apiSpecId: binding.apiSpecId,
    resourceRef: binding.resourceRef,
    scopePathBindings: (binding.scopePathBindings ?? []).map(toScopePathBindingRow),
  };
}

/**
 * Domain `ScopePathBinding` → its `jsonb` row form. `confirmedAt` is the only
 * field `jsonb` cannot hold (a `Date`), so it becomes an ISO-8601 string (or
 * `null`); every other field (present and future kinds alike) is already
 * JSON-safe and carried through by the spread — so no per-kind branch is needed.
 */
function toScopePathBindingRow(binding: ScopePathBinding): ScopePathBindingRow {
  return {
    ...binding,
    confirmedAt: binding.confirmedAt === null ? null : binding.confirmedAt.toISOString(),
  };
}

/** A `jsonb` row → domain `ScopePathBinding`: the ISO `confirmedAt` back to a `Date`. */
function fromScopePathBindingRow(row: ScopePathBindingRow): ScopePathBinding {
  return {
    ...row,
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
  };
}

/**
 * Domain → child (`resource_binding_ref`) inserts: one row per **present** ref
 * (absent refs produce no row). Child `id`s are DB-generated.
 */
export function toResourceBindingRefInserts(binding: ResourceBinding): ResourceBindingRefInsert[] {
  const inserts: ResourceBindingRefInsert[] = [];
  for (const kind of RESOURCE_BINDING_REF_KINDS) {
    const ref = binding[kind];
    if (ref === undefined) {
      continue;
    }
    inserts.push({
      resourceBindingId: binding.id,
      refKind: kind,
      value: ref.value,
      confirmedBy: ref.confirmedBy,
      confirmedAt: ref.confirmedAt,
    });
  }
  return inserts;
}

/**
 * A per-ref patch → the `SET` shape for a `resource_binding_ref` UPDATE,
 * carrying only the columns the patch actually names. `value` is absent-only
 * (never `null`); `confirmedBy`/`confirmedAt` are applied when present even if
 * that value is `null`.
 */
export function toResourceBindingRefUpdate(
  patch: ConfirmableRefPatch,
): Partial<ResourceBindingRefInsert> {
  return {
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...("confirmedBy" in patch ? { confirmedBy: patch.confirmedBy } : {}),
    ...("confirmedAt" in patch ? { confirmedAt: patch.confirmedAt } : {}),
  };
}
