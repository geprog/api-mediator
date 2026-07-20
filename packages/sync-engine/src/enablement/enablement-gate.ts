import type {
  ConfirmableRef,
  OperationMapping,
  ResourceBinding,
  ScopeCorrespondence,
} from "@mediator/domain";

import type {
  EnablementDecision,
  EnablementDegradation,
  EnablementInput,
  EnablementRequirement,
  ScopeLinkGateInput,
} from "./types.js";

/**
 * The **`SyncRule` enablement gate** (`docs/requirements/phase-4-backfill-enablement.md`
 * **BE-1**, **BE-2**; `docs/architecture/sync-engine.md` *Identity correlation*,
 * *Initial backfill*; `docs/architecture/data-model.md` `SyncRule` enablement
 * preconditions). This is the record-merge-prevention boundary: it stops a rule
 * going live "able to silently merge records, poll an unconfirmed operation, or
 * propagate something it has no approved operation for".
 *
 * {@link evaluateEnablement} is **pure and total** — like the Scheduler's
 * `decidePoll` gate, it returns a discriminated {@link EnablementDecision} for every
 * case and never throws (a blocked rule is a normal return, not an exception). It
 * reads only the already-loaded domain objects in {@link EnablementInput}; SA-1 owns
 * the DB load and the enable side effect, BE-3..BE-6 own the backfill run.
 *
 * ## Two derivations the gate makes from the domain objects
 *
 * **`pollOperationRef` confirmation (BE-1.2).** The domain `SyncRule` models
 * `pollOperationRef` as a plain optional string (no `confirmedBy`/`confirmedAt`,
 * unlike a {@link ConfirmableRef}). So "confirmed" here means **present and
 * non-empty**: an unset (`undefined`/empty) `pollOperationRef` is unconfirmed. If a
 * later slice adds explicit confirmation metadata to `pollOperationRef`, {@link
 * isPollOperationConfirmed} is the one place to update.
 *
 * **Delta-polling vs full-fetch.** Consistent with SP/RL and
 * `data-model.md` `SyncRule.pollOperationRef` ("the resource's delta-query
 * operation when the source declares `supportsDeltaQuery` *and the resource offers
 * one*, otherwise its confirmed collection read"): a rule is **delta-polling** iff
 * the source app declares `supportsDeltaQuery` **and** the source resource offers a
 * delta operation — evidenced by a derived (present) source `deltaCursorRef`
 * ({@link isDeltaPolling}). Presence marks "the resource offers a delta operation";
 * *confirmation* is the separate BE-2.3 required-ref gate.
 */

/** A `ResourceBinding` ref is confirmed iff it is present with both confirmation stamps set. */
function isRefConfirmed(ref: ConfirmableRef | undefined): boolean {
  return ref !== undefined && ref.confirmedBy !== null && ref.confirmedAt !== null;
}

/** BE-1.2 — `pollOperationRef` is "confirmed" when present and non-empty (see module note). */
function isPollOperationConfirmed(pollOperationRef: string | undefined): boolean {
  return pollOperationRef !== undefined && pollOperationRef.length > 0;
}

/** True iff the rule polls a delta operation (source declares delta *and* offers one). */
function isDeltaPolling(input: EnablementInput): boolean {
  return (
    input.sourceCapabilities.supportsDeltaQuery && input.sourceBinding.deltaCursorRef !== undefined
  );
}

/** A usable routed operation of an `action` needs its `targetIdParamRef` to route via the `RecordLink`. */
function hasUsableRoutedOp(ops: readonly OperationMapping[], action: "update" | "delete"): boolean {
  return ops.some((op) => op.action === action && op.targetIdParamRef !== undefined);
}

/**
 * SS-5 — a resource's scope path parameter has a **confirmed `constant`** binding: an
 * entry keyed by `parameterName`, both confirmation stamps set, and a non-empty value.
 * Mirrors the SS-1 confirmation discipline **and** the SS-4 resolver's own
 * `confirmedConstantValue` guard exactly (`packages/outbound/src/path-template.ts`), so a
 * scope parameter the gate reports satisfied is precisely one the resolver can fill — and
 * one it reports unsatisfied is precisely one the resolver would leave as `{…}`.
 *
 * The `entry.kind === "constant"` narrow both selects the `constant` member (so
 * `entry.value` type-checks, mirroring the resolver's `confirmedConstantValue`) and
 * keeps this check **constant-only**: a `record-derived` (SS-8) / `scope-link` entry does
 * not satisfy a `constant` requirement — a `record-derived` requirement is satisfied by
 * {@link isScopeRecordDerivedConfirmed} + {@link isSourceScopeComponentConfirmed} instead.
 */
function isScopeConstantConfirmed(binding: ResourceBinding, parameterName: string): boolean {
  return (binding.scopePathBindings ?? []).some(
    (entry) =>
      entry.kind === "constant" &&
      entry.parameterName === parameterName &&
      entry.confirmedBy !== null &&
      entry.confirmedAt !== null &&
      entry.value.length > 0,
  );
}

/**
 * SS-9 — a resource's scope path parameter has a **confirmed `record-derived`** binding:
 * an entry keyed by `parameterName` of that kind with both confirmation stamps set. The
 * confirmation is the operator's shared-value-space assertion (SS-9.1b); the entry's
 * `sourceScopeKey` is separately checked against the source `sourceScopeRef` by
 * {@link isSourceScopeComponentConfirmed}. No value check (a `record-derived` entry carries
 * no literal) and no value-space check (structural presence only — the mediator cannot
 * verify equivalence; SS-8b's resolver fills the parameter from the record's captured scope).
 */
function isScopeRecordDerivedConfirmed(binding: ResourceBinding, parameterName: string): boolean {
  return (binding.scopePathBindings ?? []).some(
    (entry) =>
      entry.kind === "record-derived" &&
      entry.parameterName === parameterName &&
      entry.confirmedBy !== null &&
      entry.confirmedAt !== null,
  );
}

/**
 * SS-12 — a resource's scope path parameter has a **confirmed `scope-link`** binding: an
 * entry keyed by `parameterName` of that kind with both confirmation stamps set. The
 * per-parameter half of a `scope-link` requirement (the SS-4/SS-12 resolver fills the
 * parameter from the record's resolved `ScopeLink` — the target-side container key selected
 * by the entry's `scopeKeyRef`); the rule-level correspondence / `ScopeLink` / container-list-op
 * preconditions are the separate mode-aware {@link evaluateScopeLinkGate}. Kept **kind-strict**
 * exactly like {@link isScopeConstantConfirmed} / {@link isScopeRecordDerivedConfirmed}: a
 * `scope-link` requirement is satisfied only by a `scope-link` entry, never a `constant`.
 */
function isScopeLinkConfirmed(binding: ResourceBinding, parameterName: string): boolean {
  return (binding.scopePathBindings ?? []).some(
    (entry) =>
      entry.kind === "scope-link" &&
      entry.parameterName === parameterName &&
      entry.confirmedBy !== null &&
      entry.confirmedAt !== null,
  );
}

/** SS-15.1 — the pair's `ScopeCorrespondence.scopeIdentityKey` is confirmed (both stamps set). */
function isScopeIdentityKeyConfirmed(correspondence: ScopeCorrespondence | undefined): boolean {
  return (
    correspondence !== undefined &&
    correspondence.confirmedBy !== null &&
    correspondence.confirmedAt !== null
  );
}

/**
 * SS-9.1a — the **source** resource's `sourceScopeRef` is confirmed and carries the
 * scope component keyed `sourceScopeKey` that a `record-derived` binding selects. This is
 * the source half of the record-derived structural-presence check: it always reads the
 * polled **source** binding (`sourceScopeRef` is a source-side property — SS-7), and
 * checks **presence** of the component only, never that its captured value matches the
 * target's value-space (the operator asserted that by choosing `record-derived`).
 */
function isSourceScopeComponentConfirmed(
  binding: ResourceBinding,
  sourceScopeKey: string,
): boolean {
  const ref = binding.sourceScopeRef;
  return (
    ref !== undefined &&
    ref.confirmedBy !== null &&
    ref.confirmedAt !== null &&
    ref.components.some((component) => component.key === sourceScopeKey)
  );
}

/**
 * Evaluate whether a `SyncRule` may be enabled (BE-1 all 6 criteria, BE-2 all 5).
 * Pure over already-loaded domain objects; returns a blocked decision listing
 * exactly the still-needed refs/decisions, or an enable decision carrying whether a
 * backfill runs and any non-blocking degradation the UI must state first.
 */
export function evaluateEnablement(input: EnablementInput): EnablementDecision {
  const stillNeeds: EnablementRequirement[] = [];
  const degradations: EnablementDegradation[] = [];

  const { rule, fieldMappings, operationMappings, sourceBinding, targetBinding } = input;
  const deltaPolling = isDeltaPolling(input);
  const backfillWillRun = !input.backfillSkipped;

  // ── BE-1.1: exactly one confirmed identity FieldMapping (the HARD gate) ──────
  // Zero silently creates duplicates; more than one silently merges unrelated
  // records — the worst failure mode, so this is not create-only-forgivable.
  const identityKeys = fieldMappings.filter((field) => field.isIdentityKey === true);
  const identityKey = identityKeys.length === 1 ? identityKeys[0] : undefined;
  if (identityKeys.length === 0) {
    stillNeeds.push({ kind: "identity-key", issue: "missing", confirmedCount: 0 });
  } else if (identityKeys.length > 1) {
    stillNeeds.push({
      kind: "identity-key",
      issue: "ambiguous",
      confirmedCount: identityKeys.length,
    });
  }

  // ── BE-1.2: pollOperationRef confirmed ───────────────────────────────────────
  if (!isPollOperationConfirmed(rule.pollOperationRef)) {
    stillNeeds.push({ kind: "poll-operation-ref" });
  }

  // ── BE-1.3: target OperationMappings for what the rule propagates ────────────
  // Normal case: an `update` op with its `targetIdParamRef`. A rule with no `update`
  // may enable create-only (observed updates → skipped-policy) *if* it has a `create`.
  // A rule with neither create nor update has nothing to propagate → cannot enable.
  const hasCreateOp = operationMappings.some((op) => op.action === "create");
  const updateOps = operationMappings.filter((op) => op.action === "update");
  const hasUsableUpdateOp = hasUsableRoutedOp(operationMappings, "update");
  if (updateOps.length === 0) {
    if (!hasCreateOp) {
      // Neither create nor update — nothing to propagate.
      stillNeeds.push({ kind: "propagatable-operation" });
    }
    // else: create-only mode (append-only resources) — a supported config, no block.
  } else if (!hasUsableUpdateOp) {
    // Update op(s) exist but none carries its targetIdParamRef → updates can't be routed.
    stillNeeds.push({
      kind: "target-operation",
      action: "update",
      issue: "missing-target-id-param",
    });
  }

  // ── BE-1.4: delete propagation needs an approved, routable delete op ─────────
  // (its delta-side `deltaDeletionRef` requirement is folded into the delta block below).
  if (rule.deletePropagation === "propagate") {
    const deleteOps = operationMappings.filter((op) => op.action === "delete");
    if (deleteOps.length === 0) {
      stillNeeds.push({ kind: "target-operation", action: "delete", issue: "missing" });
    } else if (!hasUsableRoutedOp(operationMappings, "delete")) {
      stillNeeds.push({
        kind: "target-operation",
        action: "delete",
        issue: "missing-target-id-param",
      });
    }
  }

  // ── BE-2.1: nativeIdRef confirmed on BOTH sides ──────────────────────────────
  if (!isRefConfirmed(sourceBinding.nativeIdRef)) {
    stillNeeds.push({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "source",
      usedFor: "native-id",
    });
  }
  if (!isRefConfirmed(targetBinding.nativeIdRef)) {
    stillNeeds.push({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "target",
      usedFor: "native-id",
    });
  }

  // ── BE-2.2: source collectionReadRef (+ paginationRef) where enumeration applies ─
  // A full-fetch rule polls via the collection read; backfill (unless skipped) always
  // enumerates the source — even a delta-polling rule (backfill never uses the delta op).
  const sourceCollectionReadRequired = !deltaPolling || backfillWillRun;
  if (sourceCollectionReadRequired) {
    const usedFor = deltaPolling ? "backfill-enumeration" : "polling-enumeration";
    if (!isRefConfirmed(sourceBinding.collectionReadRef)) {
      stillNeeds.push({ kind: "binding-ref", ref: "collectionReadRef", side: "source", usedFor });
    }
    // Paging applies only where a paginationRef exists (absent = single-response read).
    if (sourceBinding.paginationRef !== undefined && !isRefConfirmed(sourceBinding.paginationRef)) {
      stillNeeds.push({
        kind: "binding-ref",
        ref: "paginationRef",
        side: "source",
        usedFor: "pagination",
      });
    }
  }

  // ── BE-2.3 / BE-1.4: delta-polling source refs ───────────────────────────────
  if (deltaPolling) {
    if (!isRefConfirmed(sourceBinding.deltaCursorRef)) {
      stillNeeds.push({
        kind: "binding-ref",
        ref: "deltaCursorRef",
        side: "source",
        usedFor: "delta-cursor",
      });
    }
    if (rule.deletePropagation === "propagate" && !isRefConfirmed(sourceBinding.deltaDeletionRef)) {
      stillNeeds.push({
        kind: "binding-ref",
        ref: "deltaDeletionRef",
        side: "source",
        usedFor: "delta-deletion",
      });
    }
  }

  // ── BE-1.6: identity-lookup path (RL-3 criterion 5) ──────────────────────────
  // filtered-read = the single confirmed identity key's `targetLookupParamRef`;
  // fetch-and-match = a confirmed target `collectionReadRef`. Neither → match-first
  // is unavailable: enable is permitted ONLY with backfill explicitly skipped, and
  // the decision then carries the duplicate-risk degradation flag.
  const hasFilteredRead =
    identityKey !== undefined && identityKey.targetLookupParamRef !== undefined;
  const hasFetchAndMatch = isRefConfirmed(targetBinding.collectionReadRef);
  if (!hasFilteredRead && !hasFetchAndMatch) {
    if (input.backfillSkipped) {
      degradations.push({ kind: "match-first-unavailable" });
    } else {
      stillNeeds.push({ kind: "identity-lookup-path" });
    }
  } else if (
    // BE-2.2 (fetch-and-match target): when fetch-and-match is the SOLE match path
    // (no filtered read), RL-3 pages the target to exhaustion via its `paginationRef`
    // — a present-but-unconfirmed paging convention could truncate the fetch, miss a
    // real match, and create a DUPLICATE. A filtered read returns ≤1 (never pages; a
    // >1 result is the RL-4 ambiguous failure), so this is scoped to fetch-and-match.
    !hasFilteredRead &&
    hasFetchAndMatch &&
    targetBinding.paginationRef !== undefined &&
    !isRefConfirmed(targetBinding.paginationRef)
  ) {
    stillNeeds.push({
      kind: "binding-ref",
      ref: "paginationRef",
      side: "target",
      usedFor: "pagination",
    });
  }

  // ── BE-2.4: changeTimestampRef is NOT a hard precondition (LWW degrades) ──────
  // Surface a non-blocking note where a side declares change timestamps but its ref
  // is unconfirmed: LWW conflict resolution falls back to observation order (CF-2).
  if (
    input.sourceCapabilities.supportsChangeTimestamps &&
    !isRefConfirmed(sourceBinding.changeTimestampRef)
  ) {
    degradations.push({ kind: "lww-observation-order", side: "source" });
  }
  if (
    input.targetCapabilities.supportsChangeTimestamps &&
    !isRefConfirmed(targetBinding.changeTimestampRef)
  ) {
    degradations.push({ kind: "lww-observation-order", side: "target" });
  }

  // ── SS-5 / SS-9: required scope path-parameter bindings ──────────────────────
  // A scoped rule can only enable once every scope path parameter of the operations it
  // actually calls is satisfied — checked on the NAMED side's `ResourceBinding` (SS-5.5:
  // source-op params on the source binding, target-op params on the target). The required
  // set (with each param's `constant`-vs-`record-derived` kind) is precomputed by the SA
  // classifier from the IR + bindings; it matches what the SS-4/SS-8b resolver fills. Each
  // unmet precondition blocks and joins the BE-1/BE-2 requirements in `stillNeeds`. An
  // empty list is a no-op for a non-scoped rule (backward-compatible).
  for (const requirement of input.requiredScopeBindings) {
    const binding = requirement.side === "source" ? sourceBinding : targetBinding;
    if (requirement.kind === "constant") {
      // SS-5 — a confirmed `constant` on the named side.
      if (!isScopeConstantConfirmed(binding, requirement.parameterName)) {
        stillNeeds.push({
          kind: "scope-binding",
          parameterName: requirement.parameterName,
          side: requirement.side,
          resourceRef: requirement.resourceRef,
        });
      }
    } else if (requirement.kind === "scope-link") {
      // SS-12 — a confirmed `scope-link` entry on the named side (kind-strict, so a
      // `scope-link` scope parameter is never misreported as a missing `constant`). The
      // rule-level correspondence / `ScopeLink` preconditions this binding also triggers
      // are the mode-aware `scopeLinkGate` block below.
      if (!isScopeLinkConfirmed(binding, requirement.parameterName)) {
        stillNeeds.push({
          kind: "scope-binding",
          parameterName: requirement.parameterName,
          side: requirement.side,
          resourceRef: requirement.resourceRef,
        });
      }
    } else {
      // SS-9 — structural presence of BOTH halves (never value-space equivalence):
      //  (b) the `record-derived` binding entry confirmed on the named (target) side, and
      //  (a) the polled SOURCE resource's `sourceScopeRef` confirmed carrying the selected
      //      component. The `sourceScopeRef` is always a source-side property (SS-7), so it
      //      is read off `sourceBinding` regardless of the binding-entry side.
      if (!isScopeRecordDerivedConfirmed(binding, requirement.parameterName)) {
        stillNeeds.push({
          kind: "scope-binding",
          parameterName: requirement.parameterName,
          side: requirement.side,
          resourceRef: requirement.resourceRef,
        });
      }
      if (!isSourceScopeComponentConfirmed(sourceBinding, requirement.sourceScopeKey)) {
        stillNeeds.push({
          kind: "source-scope-ref",
          side: "source",
          resourceRef: requirement.sourceResourceRef,
          sourceScopeKey: requirement.sourceScopeKey,
        });
      }
    }
  }

  // ── SS-15: mode-aware `scope-link` preconditions ─────────────────────────────
  // Present iff the rule carries any `kind: scope-link` scope binding (the SA layer decides;
  // `undefined` for a non-scoped / L1-constant / L2-record-derived rule → no SS-15 blocker).
  if (input.scopeLinkGate !== undefined) {
    evaluateScopeLinkGate(input.scopeLinkGate, stillNeeds);
  }

  // ── Verdict (BE-1.5 / BE-2.5) ────────────────────────────────────────────────
  if (stillNeeds.length > 0) {
    return { kind: "blocked", stillNeeds };
  }
  return { kind: "enable", backfillRequired: backfillWillRun, degradations };
}

/**
 * SS-15.1/15.2 — the **mode-aware `scope-link` precondition check** (extends SS-5). Runs only
 * for a rule carrying a `kind: scope-link` scope binding. Emits the **three distinct**
 * SS-15.3 blockers so the operator knows exactly what to fix: an unconfirmed **scope identity
 * key** ({@link ScopeIdentityKeyRequirement}), an absent/unresolved **`ScopeLink`**
 * ({@link ScopeLinkRequirement}, `per-scope-pinned` only), and an unconfirmed **container list
 * op** ({@link ContainerListOpRequirement}).
 *
 *  - The **scope identity key** is required in **every** mode (all container matching keys on
 *    the value-preserving pairing).
 *  - **cross-scope** (SS-13.1) — the confirmed **target** container list op makes on-demand /
 *    harvest discovery viable; per-scope `ScopeLink`s are **not** pre-required.
 *  - **per-scope-enumerated** (SS-13.2) — as cross-scope **plus** the confirmed **source**
 *    container list op SS-17 enumerates; per-scope `ScopeLink`s are still **not** pre-required
 *    (SS-17 establishes them live — a landscape that grows containers must stay enableable).
 *  - **per-scope-pinned** (SS-13.4) — the source is not enumerable, so at least one **active**
 *    `constant`/`manual` `ScopeLink` must cover the scopes in play (nothing lists them live).
 */
function evaluateScopeLinkGate(
  gate: ScopeLinkGateInput,
  stillNeeds: EnablementRequirement[],
): void {
  if (!isScopeIdentityKeyConfirmed(gate.correspondence)) {
    stillNeeds.push({ kind: "scope-identity-key" });
  }
  switch (gate.effectiveMode) {
    case "cross-scope":
      requireContainerListOp(gate.targetContainerBinding, "target", stillNeeds);
      break;
    case "per-scope-enumerated":
      requireContainerListOp(gate.targetContainerBinding, "target", stillNeeds);
      requireContainerListOp(gate.sourceContainerBinding, "source", stillNeeds);
      break;
    case "per-scope-pinned":
      if (!hasPinnedScopeLink(gate.scopeLinks)) {
        stillNeeds.push({ kind: "scope-link" });
      }
      break;
  }
}

/**
 * SS-15.2 — a container list op is confirmed when the container resource's `collectionReadRef`
 * is confirmed **and** (paging is meaningful only where a `paginationRef` exists — mirroring
 * BE-2.2) its `paginationRef` is confirmed where present. An unresolved container binding
 * (`undefined`) is treated as unconfirmed. Emits one {@link ContainerListOpRequirement} for
 * `side` when unmet.
 */
function requireContainerListOp(
  binding: ResourceBinding | undefined,
  side: "source" | "target",
  stillNeeds: EnablementRequirement[],
): void {
  const collectionConfirmed = isRefConfirmed(binding?.collectionReadRef);
  const paginationUnconfirmed =
    binding?.paginationRef !== undefined && !isRefConfirmed(binding.paginationRef);
  if (!collectionConfirmed || paginationUnconfirmed) {
    stillNeeds.push({ kind: "container-list-op", side });
  }
}

/**
 * SS-15.1 (per-scope-pinned) — the scopes are "covered" iff at least one **active**
 * `establishedBy` `constant`/`manual` `ScopeLink` is pinned under the correspondence. In
 * pinned mode the source is not enumerable and nothing lists scopes live, so the pinned links
 * *are* the scope set — zero of them means no scope to poll (an `identity-match` link cannot
 * arise without an enumerable/harvestable source, so it is not counted here).
 */
function hasPinnedScopeLink(scopeLinks: ScopeLinkGateInput["scopeLinks"]): boolean {
  return scopeLinks.some(
    (link) =>
      link.status === "active" &&
      (link.establishedBy === "constant" || link.establishedBy === "manual"),
  );
}
