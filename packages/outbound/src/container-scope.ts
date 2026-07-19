import type { RecordLinkScopeRef, ScopeKey, ScopeLink, ScopePathBinding } from "@mediator/domain";

import { ContainerUnresolvedError } from "./errors.js";
import { toScopeParamString } from "./record-derived-scope.js";

/**
 * **SS-12 write-side container resolution** (`kind: "scope-link"`, Layer 3) — the
 * write-side complement of SS-8b's `record-derived` fill. Where a `record-derived`
 * scope parameter is filled from the record's **captured scope** (shared value-space),
 * a `scope-link` parameter's value-space is **arbitrary** (a Gitea repo `alice/phoenix`
 * vs a Vikunja project id `42`), so its target-addressing value is taken **verbatim**
 * from the record's resolved `ScopeLink` — the target-side `appXScopeKey`, selected by
 * the binding's `scopeKeyRef` (`docs/architecture/data-model.md`
 * `ResourceBinding.scopePathBindings` / `ScopeLink` / `RecordLink.scopeRef`; SS-12).
 *
 * There is **no transform** on a `scope-link` binding: the value-space bridge is the
 * `ScopeLink` itself (its `scopeIdentityKey` matching enforced value-preservation at
 * establishment — SS-10/SS-11), so the container-addressing value is used AS-IS.
 *
 * ## Where each side resolves its container (SS-12.2 / SS-12.3)
 *
 *  - a **create** (no `RecordLink` yet) resolves the target scope from the record's
 *    **captured scope** matched to an **active** `ScopeLink` — done by the composition
 *    (the loader looks the link up), which then fills the create op and persists
 *    `RecordLink.scopeRef = { kind: "scope-link", scopeLinkId }` on the new link;
 *  - a **linked** update/delete/read resolves the target scope from the authoritative
 *    stored `RecordLink.scopeRef` — **not** a captured scope — so a **delete** (which
 *    carries no captured scope, the source record is gone) and a `read-before-write` /
 *    PUT read-carry still route to the right container. {@link resolveScopeRefFillValues}
 *    is that resolution.
 *
 * ## Never a fabricated / guessed / unsafe container (SS-12.4 / SS-12.6)
 *
 * An absent / unresolvable `RecordLink.scopeRef`, and a captured scope with no active
 * `ScopeLink`, resolve to **no container** — the caller parks the execution for manual
 * container linking (a {@link ContainerUnresolvedError} → dead-letter park with the
 * `CONTAINER_LINK_PARK_REASON`), never a guessed container. The target addressing value
 * runs through the **same** value-safety guard as the `record-derived` fill
 * ({@link toScopeParamString}), so an unsafe container key (empty, `/`-containing, `.`
 * / `..`) parks too, never composes a wrong-container path.
 */

/**
 * The narrow read port over `ScopeLink` the write-side container resolution depends on —
 * `getById` resolves a link **whatever its status** (an **archived** `ScopeLink` still
 * resolves its frozen key for a final delete/audit — SS-10.5 / SS-12.3), so a linked
 * delete routes even after its container left the landscape. The real
 * `ScopeLinkRepository` (`@mediator/db`) satisfies it structurally; a fake mirrors it in
 * tests. The **active-only** `lookupByScopeKey` (create-path establishment) lives on the
 * full `ScopeLinkStore` the composition holds, not here.
 */
export interface ScopeLinkReader {
  getById(id: string): Promise<ScopeLink | undefined>;
}

/**
 * The **target side's** scope key of a `ScopeLink` — the `{ component → value }` map a
 * `scope-link` binding filling a *target* scope parameter reads. The link is
 * direction-agnostic (`appA`/`appB` are ordered by a stable key, not by mapping
 * direction), so the target side is whichever side's `appXId` is the write's target app.
 * `undefined` when the target app is on neither side (a mis-resolved link — never guessed).
 */
export function targetScopeKeyOf(link: ScopeLink, targetAppId: string): ScopeKey | undefined {
  if (link.appAId === targetAppId) {
    return link.appAScopeKey;
  }
  if (link.appBId === targetAppId) {
    return link.appBScopeKey;
  }
  return undefined;
}

/**
 * The `{ parameterName → value }` fill map for the **confirmed** `scope-link` entries of
 * `scopePathBindings`, each value the target-side container key selected by the entry's
 * `scopeKeyRef` and run through the {@link toScopeParamString} value-safety guard. An
 * entry whose `scopeKeyRef` component is **absent** from the target scope key, or whose
 * value is **unsafe** as a single URL path segment, is **omitted** (so the fill leaves
 * that `{…}` unfilled → the caller parks, never mis-writes — SS-12.4). Unconfirmed /
 * `constant` / `record-derived` entries are ignored here (constants fill from their
 * literal, record-derived from the captured scope — SS-8b).
 */
export function resolveScopeLinkScopeValues(
  scopePathBindings: readonly ScopePathBinding[],
  targetScopeKey: ScopeKey,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const binding of scopePathBindings) {
    if (binding.kind !== "scope-link") {
      continue;
    }
    // Used nowhere until confirmed (mirrors every other binding's discipline).
    if (binding.confirmedBy === null || binding.confirmedAt === null) {
      continue;
    }
    const raw = targetScopeKey[binding.scopeKeyRef];
    if (raw === undefined) {
      continue; // the resolved container has no such component → omit → fill parks.
    }
    const safe = toScopeParamString(raw);
    if (safe === undefined) {
      continue; // an unsafe target key never composes a wrong-container path → park.
    }
    values.set(binding.parameterName, safe);
  }
  return values;
}

/**
 * The scope path parameters that are filled **per record** from the resolved container —
 * the `record-derived` (SS-8) and `scope-link` (SS-12) entries' `parameterName`s. A
 * `constant` scope parameter is filled from its literal at composition time and is **not**
 * here. Used to know which of a write op's still-templated `{…}` a linked delete must fill
 * from `RecordLink.scopeRef`, and to detect one left unfilled (→ park, SS-12.4).
 */
export function containerScopeParamNames(
  scopePathBindings: readonly ScopePathBinding[],
): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const binding of scopePathBindings) {
    if (binding.kind === "constant" || seen.has(binding.parameterName)) {
      continue;
    }
    seen.add(binding.parameterName);
    names.push(binding.parameterName);
  }
  return names;
}

/**
 * Resolve the `{ parameterName → value }` fill map for a **linked** write (update / delete
 * / no-capture read) from the record's authoritative stored `RecordLink.scopeRef` (SS-12.3)
 * — **not** from a captured scope — so a delete, which carries no captured scope, still
 * routes to the right container:
 *
 *  - `{ kind: "resolved", values }` (L2 shared value-space) → the **frozen**
 *    `{ parameterName → value }` map directly, so an L2 `record-derived` rule's deletes
 *    route from stored values too (SS-12.7 — the L2/L3 delete fix, unified);
 *  - `{ kind: "scope-link", scopeLinkId }` (L3 arbitrary value-space) → the referenced
 *    `ScopeLink` (resolved via {@link ScopeLinkReader.getById}, which resolves an
 *    **archived** link too — SS-10.5), its target-side scope key, then the confirmed
 *    `scope-link` bindings selected by `scopeKeyRef` ({@link resolveScopeLinkScopeValues}).
 *
 * Throws a {@link ContainerUnresolvedError} — routed to a dead-letter **container-link
 * park** (SS-12.4), never a generic transient throw and never a guessed container — when
 * the `scopeRef` is **absent**, the referenced `ScopeLink` no longer exists, or the link
 * does not address the write's target app. A returned map may still be **missing** an
 * unsafe/absent scope-link parameter; the caller checks the op's remaining `{…}` and parks
 * on any left unfilled.
 */
export async function resolveScopeRefFillValues(input: {
  readonly scopeRef: RecordLinkScopeRef | undefined;
  readonly targetAppId: string;
  readonly scopePathBindings: readonly ScopePathBinding[];
  readonly reader: ScopeLinkReader;
}): Promise<Map<string, string>> {
  const { scopeRef } = input;
  if (scopeRef === undefined) {
    // A scoped delete / no-capture read whose link never captured its container — park
    // for manual container linking rather than throw a generic transient (SS-12.4).
    throw new ContainerUnresolvedError(
      "RecordLink.scopeRef is absent — the record's container was never captured; link a container and replay",
    );
  }
  if (scopeRef.kind === "resolved") {
    return new Map(Object.entries(scopeRef.values));
  }
  const link = await input.reader.getById(scopeRef.scopeLinkId);
  if (link === undefined) {
    throw new ContainerUnresolvedError(
      `RecordLink.scopeRef points at ScopeLink ${scopeRef.scopeLinkId}, which no longer exists`,
    );
  }
  const targetScopeKey = targetScopeKeyOf(link, input.targetAppId);
  if (targetScopeKey === undefined) {
    throw new ContainerUnresolvedError(
      `ScopeLink ${link.id} does not address target app ${input.targetAppId}`,
    );
  }
  return resolveScopeLinkScopeValues(input.scopePathBindings, targetScopeKey);
}

/**
 * Fill a write op's still-templated **container** scope parameters (`{param}`) from a
 * resolved `{ parameterName → value }` map — the linked delete/update path's fill over the
 * op's `pathTemplate` (constant/record-derived params already substituted at composition
 * time, the record-id param left templated for the executor), each URL-encoded exactly as
 * {@link fillScopePathParameters} encodes a scope value.
 *
 * **The record id and the scope are never crossed (SS-12.5):** `recordIdParamName` — this
 * op's record-id path parameter — is **skipped**, so it stays templated for the executor's
 * `RecordLink`-id fill even when a scope binding **shares its bare name**. This is the real
 * scenario-1 Vikunja collision: the scope param and the record id are both `{id}` (`PUT
 * /projects/{id}/tasks` scope vs `POST`/`DELETE /tasks/{id}` record id) — filling the
 * record-id slot from the container would silently write/delete the **wrong record**. The
 * skip mirrors {@link fillScopePathParameters}'s SS-4.2 record-id skip on the read /
 * load-time paths, keeping the record-id-aware fill uniform across every scope-binding kind.
 *
 * Returns the filled path plus the `containerScopeParamNames` still left as `{…}` — a
 * parameter with no safe resolved value (an unsafe/absent container key). The caller parks
 * (a {@link ContainerUnresolvedError}) when any remain, so an incomplete container is a
 * refused write, never a silent wrong-container one (SS-12.4).
 */
export function fillContainerScopeParams(
  pathTemplate: string,
  containerParamNames: readonly string[],
  fillValues: ReadonlyMap<string, string>,
  recordIdParamName?: string,
): { readonly path: string; readonly unfilled: readonly string[] } {
  let path = pathTemplate;
  const unfilled: string[] = [];
  for (const name of containerParamNames) {
    if (name === recordIdParamName) {
      // SS-12.5 — this op's record-id parameter is filled from the `RecordLink`'s native id
      // downstream, NEVER from the container, even when a scope binding shares its name.
      continue;
    }
    const token = `{${name}}`;
    if (!path.includes(token)) {
      continue; // this op does not carry that container parameter.
    }
    const value = fillValues.get(name);
    if (value === undefined) {
      unfilled.push(name);
      continue;
    }
    path = path.split(token).join(encodeURIComponent(value));
  }
  return { path, unfilled };
}
