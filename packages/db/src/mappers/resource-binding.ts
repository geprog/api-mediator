import {
  type ConfirmableRef,
  type IrRefTarget,
  type ResourceBinding,
  type ScopeComponent,
  type ScopePathBinding,
  type ScopeTransform,
  type SourceScopeRef,
  stripUndefined,
} from "@mediator/domain";

import {
  RESOURCE_BINDING_REF_KINDS,
  type ResourceBindingRefKind,
  type ScopePathBindingRow,
  type SourceScopeRefRow,
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
 * Confirm/correct **one** scope path-parameter binding for
 * {@link ResourceBindingRepository.updateScopePathBinding}, addressed by
 * `parameterName` (scope bindings are keyed by name, not the six ref kinds — a
 * distinct patch shape from {@link ResourceBindingRefPatch}). A **discriminated
 * union over `kind`**, one member per fill source it can confirm an entry *into*:
 *
 * - `constant` (SS-3) — sets the entry's literal `value` + confirmation.
 * - `record-derived` (SS-8) — sets the entry's `sourceScopeKey` (+ optional
 *   value-preserving `transform`) + confirmation, **dropping** the `constant`'s
 *   `value` (a derived entry defaults to `kind: constant` at SS-2, so confirming it
 *   `record-derived` rewrites the member).
 * - `scope-link` (SS-12 / SS-18.4) — sets the entry's `scopeKeyRef` (which target
 *   `ScopeLink.appXScopeKey` component addresses the parameter) + confirmation,
 *   likewise dropping the `constant`'s stale `value`. Unlike the other two, its
 *   confirmation pair is routinely written **null**: SS-18.4 *selecting* `scope-link`
 *   writes the entry unconfirmed, and a later confirm stamps it.
 *
 * Whichever member, it rewrites **only** the matching entry of the `jsonb`
 * collection, leaving every sibling scope entry and all operational refs untouched
 * (SS-3.2).
 */
export interface ScopeConstantBindingPatch {
  readonly kind: "constant";
  readonly parameterName: string;
  readonly value: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
}
export interface ScopeRecordDerivedBindingPatch {
  readonly kind: "record-derived";
  readonly parameterName: string;
  readonly sourceScopeKey: string;
  readonly transform?: ScopeTransform;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
}
export interface ScopeScopeLinkBindingPatch {
  readonly kind: "scope-link";
  readonly parameterName: string;
  readonly scopeKeyRef: string;
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
}
export type ScopePathBindingPatch =
  ScopeConstantBindingPatch | ScopeRecordDerivedBindingPatch | ScopeScopeLinkBindingPatch;

/**
 * Confirm/correct the whole `sourceScopeRef` for
 * {@link ResourceBindingRepository.updateSourceScopeRef} (SS-7). Unlike the six
 * refs and the per-parameter scope bindings, `sourceScopeRef` is **one** ref whose
 * value is the component set, so this replaces the whole `source_scope_ref`
 * `jsonb` column (the operator supplies/adjusts the full component set — add /
 * remove / rename components, set each `fieldPath`) and stamps its single
 * confirmation. `components` must be validated (each `fieldPath` a real response
 * field path) by the service before it reaches here.
 */
export interface SourceScopeRefPatch {
  readonly components: readonly ScopeComponent[];
  readonly confirmedBy: string | null;
  readonly confirmedAt: Date | null;
}

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
    // A NULL column is the **absent** ref key ({@link stripUndefined}); a present
    // row round-trips its ISO `confirmedAt` back to a `Date`.
    sourceScopeRef:
      bindingRow.sourceScopeRef === null
        ? undefined
        : fromSourceScopeRefRow(bindingRow.sourceScopeRef),
  });
}

/** Domain → parent (`resource_binding`) insert, including the scope bindings. */
export function toResourceBindingInsert(binding: ResourceBinding): ResourceBindingInsert {
  return {
    id: binding.id,
    apiSpecId: binding.apiSpecId,
    resourceRef: binding.resourceRef,
    scopePathBindings: (binding.scopePathBindings ?? []).map(toScopePathBindingRow),
    // Absent domain ref → NULL column; present → its `jsonb` row form.
    sourceScopeRef:
      binding.sourceScopeRef === undefined ? null : toSourceScopeRefRow(binding.sourceScopeRef),
  };
}

/**
 * Domain `SourceScopeRef` → its `jsonb` row form (SS-7). `confirmedAt` is the only
 * field `jsonb` cannot hold (a `Date`), so it becomes an ISO-8601 string (or
 * `null`); `components` and `confirmedBy` are already JSON-safe.
 */
function toSourceScopeRefRow(ref: SourceScopeRef): SourceScopeRefRow {
  return {
    components: ref.components,
    confirmedBy: ref.confirmedBy,
    confirmedAt: ref.confirmedAt === null ? null : ref.confirmedAt.toISOString(),
  };
}

/** A `jsonb` row → domain `SourceScopeRef`: the ISO `confirmedAt` back to a `Date`. */
function fromSourceScopeRefRow(row: SourceScopeRefRow): SourceScopeRef {
  return {
    components: row.components,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
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
 * Apply a {@link ScopePathBindingPatch} to a scope-binding `jsonb` collection:
 * rewrite **only** the entry whose `parameterName` matches — to the shape of the
 * patch's `kind` (a `constant`'s literal `value`, a `record-derived`'s
 * `sourceScopeKey` + optional `transform`, or a `scope-link`'s `scopeKeyRef`) plus
 * its confirmation (`confirmedAt` as ISO-8601) — leaving every sibling entry
 * byte-identical (SS-3.2). The matched entry
 * is **replaced** (not spread over its prior fields), so confirming an SS-2-default
 * `constant` entry `record-derived` drops the stale `value` and vice-versa. Returns
 * the new collection and whether an entry matched, so a caller can reject a
 * `parameterName` that is not a derived scope entry of the resource (SS-3.4) rather
 * than silently no-op.
 */
export function applyScopePathBindingPatch(
  rows: readonly ScopePathBindingRow[],
  patch: ScopePathBindingPatch,
): { readonly rows: ScopePathBindingRow[]; readonly matched: boolean } {
  let matched = false;
  const confirmedAt = patch.confirmedAt === null ? null : patch.confirmedAt.toISOString();
  const next = rows.map((row): ScopePathBindingRow => {
    if (row.parameterName !== patch.parameterName) {
      return row;
    }
    matched = true;
    if (patch.kind === "constant") {
      return {
        kind: "constant",
        parameterName: patch.parameterName,
        value: patch.value,
        confirmedBy: patch.confirmedBy,
        confirmedAt,
      };
    }
    if (patch.kind === "record-derived") {
      return {
        kind: "record-derived",
        parameterName: patch.parameterName,
        sourceScopeKey: patch.sourceScopeKey,
        ...(patch.transform !== undefined ? { transform: patch.transform } : {}),
        confirmedBy: patch.confirmedBy,
        confirmedAt,
      };
    }
    return {
      kind: "scope-link",
      parameterName: patch.parameterName,
      scopeKeyRef: patch.scopeKeyRef,
      confirmedBy: patch.confirmedBy,
      confirmedAt,
    };
  });
  return { rows: next, matched };
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
