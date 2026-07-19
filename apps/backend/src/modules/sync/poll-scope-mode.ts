import type {
  PollScopeMode,
  ResourceBinding,
  ScopeCorrespondence,
  SyncRule,
} from "@mediator/domain";

/**
 * **SS-13.5 — the derive-then-correct poll-enumeration mode.** Shared by the
 * `RepoPollPlanResolver` (which acts on the effective mode) and the operator DTO
 * (which surfaces the derived + effective mode so the mode is operator-visible), so the
 * two never diverge. The `RepoPollPlanResolver` already does derive-then-decide for
 * delta-vs-full-fetch; this mirrors that for cross-scope-vs-per-scope.
 */

/**
 * The mode a scoped rule polls in **without** an operator override — derived from the
 * source resource's container binding (SS-13.5):
 *
 *  - **`cross-scope`** (SS-13.1, the recommended default) — the source read is **not**
 *    per-container: it has no confirmed `scope-link` scope path binding (the SS-8
 *    record-carried case, an L1 single `constant`, or a non-scoped rule), so one
 *    cross-scope call with the single per-rule cursor/snapshot suffices.
 *  - **`per-scope-enumerated`** (SS-13.2) — the source read **is** per-container (a
 *    confirmed `scope-link` scope path binding) **and** the source container is
 *    enumerable: the pair's `ScopeCorrespondence` carries a `sourceContainerRef` (a
 *    confirmed container list op), so scopes are discovered/enumerated.
 *  - **`per-scope-pinned`** (SS-13.4) — the source read is per-container but the source
 *    container is **not** enumerable (no `sourceContainerRef`): the scope set is exactly
 *    the `constant`/`manual` `ScopeLink`s the operator pinned.
 *
 * `correspondence` is the pair's `ScopeCorrespondence` (or `undefined` when the pair has
 * none yet) — its `sourceContainerRef` is what distinguishes enumerated from pinned.
 */
export function derivePollScopeMode(
  sourceBinding: ResourceBinding,
  correspondence: ScopeCorrespondence | undefined,
): PollScopeMode {
  const perContainerSourceRead = (sourceBinding.scopePathBindings ?? []).some(
    (binding) =>
      binding.kind === "scope-link" && binding.confirmedBy !== null && binding.confirmedAt !== null,
  );
  if (!perContainerSourceRead) {
    // No per-container source scope param → one cross-scope call (SS-13.1). Covers the
    // SS-8 record-carried case, L1 constants, and non-scoped rules — unchanged from SS-8.
    return "cross-scope";
  }
  return correspondence?.sourceContainerRef !== undefined
    ? "per-scope-enumerated"
    : "per-scope-pinned";
}

/**
 * The operator-visible mode summary (SS-13.5): the persisted `override`
 * (`SyncRule.pollScopeMode`, `undefined` = "use the derived mode"), the `derived` mode,
 * and the `effective` mode the resolver acts on (`override ?? derived`).
 */
export interface PollScopeModeView {
  readonly override: PollScopeMode | undefined;
  readonly derived: PollScopeMode;
  readonly effective: PollScopeMode;
}

/** Resolve the {@link PollScopeModeView} for a rule (SS-13.5) — the operator override honored. */
export function pollScopeModeView(
  rule: SyncRule,
  sourceBinding: ResourceBinding,
  correspondence: ScopeCorrespondence | undefined,
): PollScopeModeView {
  const derived = derivePollScopeMode(sourceBinding, correspondence);
  const override = rule.pollScopeMode;
  return { override, derived, effective: override ?? derived };
}
