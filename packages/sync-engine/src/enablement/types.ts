import type {
  AppCapabilities,
  FieldMapping,
  OperationMapping,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";

/**
 * Types for the **`SyncRule` enablement gate** — the safety-critical precondition
 * check that decides whether a disabled Phase-3 `SyncRule` may be turned on
 * (`docs/architecture/sync-engine.md` *Identity correlation*, *Initial backfill*;
 * `docs/architecture/data-model.md` `SyncRule` enablement preconditions;
 * `docs/requirements/phase-4-backfill-enablement.md` **BE-1**, **BE-2**).
 *
 * This slice is **pure evaluation over already-loaded domain objects** — no repos,
 * no ports, no async, no I/O. A later slice (SA-1) loads the rule, its bindings,
 * mapping, and apps from the DB and calls {@link evaluateEnablement} with the
 * resulting {@link EnablementInput}. The backfill **runner** (BE-3..BE-6) is a
 * separate later slice — this gate only decides the enablement precondition.
 *
 * The gate never throws for a blocked rule: a blocked rule is a normal
 * {@link EnablementDecision} (`kind: "blocked"`), so the caller can render the
 * `stillNeeds` checklist (SU-1) rather than catch an exception.
 */

// ── Input ────────────────────────────────────────────────────────────────────

/**
 * Everything the gate evaluates, all already loaded by the caller (SA-1). Every
 * field is a plain domain object read `readonly` — the gate mutates nothing.
 *
 * `source` = the app the rule polls (`ApprovedMapping.sourceSpecId`'s app);
 * `target` = where writes land (`ApprovedMapping.targetSpecId`'s app). Both name
 * the *same* mapped resource pair, one `ResourceBinding` per side.
 *
 * The peer-peer `ApprovedMapping`'s `FieldMapping`s and `OperationMapping`s are
 * passed directly (rather than the `ApprovedMapping` row) because the gate reads
 * only its children. The counterpart-direction mapping is **not** an input: the
 * shared-identity-pairing sameness is a review-time invariant, and the only
 * enablement rule that consumes the counterpart — at-most-one-`push` (BE-5.3) — is
 * out of this slice's scope.
 */
export interface EnablementInput {
  /** The rule being enabled — its `pollOperationRef`, `deletePropagation`, backfill mode. */
  readonly rule: SyncRule;
  /** This direction's approved `FieldMapping`s — carry the confirmed identity key (`isIdentityKey`). */
  readonly fieldMappings: readonly FieldMapping[];
  /** This direction's approved `OperationMapping`s — the target operations the rule may call, by `action`. */
  readonly operationMappings: readonly OperationMapping[];
  /** The polled source resource's operational bindings. */
  readonly sourceBinding: ResourceBinding;
  /** The written target resource's operational bindings. */
  readonly targetBinding: ResourceBinding;
  /** The source app's declared capabilities — `supportsDeltaQuery` picks delta vs full-fetch. */
  readonly sourceCapabilities: AppCapabilities;
  /** The target app's declared capabilities — `supportsChangeTimestamps` gates the LWW note. */
  readonly targetCapabilities: AppCapabilities;
  /**
   * The operator's **explicit** choice to skip the one-time initial backfill
   * (`docs/architecture/data-model.md`: "skipping is an explicit choice, never a
   * default"; BE-1.6). This is an **input**, not a gate decision: SA-1/SU-1
   * collects it from the operator. `true` is the only way to enable a resource pair
   * with **neither** identity-lookup path (BE-1.6); it also removes the backfill's
   * own enumeration demand on the source `collectionReadRef` (BE-2.2 / BE-4.6).
   */
  readonly backfillSkipped: boolean;
  /**
   * SS-5 / SS-9 — the scope path-parameter bindings the operations this rule actually
   * calls require, **precomputed by the SA classifier** from the IR (`docs/requirements/
   * scoped-resource-sync.md` SS-5.1/5.2): the source poll operation + backfill collection
   * read, the fetch-and-match target read when that is the lookup path, the target
   * create/update/delete for what the rule propagates, and the target single-record read
   * when the rule needs it (a PUT-shaped update's read-carry / `read-before-write`). Each
   * entry names a **scope** (non-record-id) path parameter and — via its
   * {@link ScopeBindingRequirement} `kind` — how it is satisfied: a `constant` on the
   * named {@link EnablementSide}'s `ResourceBinding` (SS-5), or `record-derived` structural
   * presence (SS-9). An operation whose only path parameter is the record id contributes
   * none (SS-5.3).
   *
   * Kept an **input** (not derived here) so the gate stays pure over already-loaded
   * domain objects — the IR-dependent record-id-vs-scope classification and the per-param
   * `constant`-vs-`record-derived` kind resolution live in the SA layer and match what the
   * SS-4/SS-8b resolver fills exactly. **Empty** for a non-scoped rule: the gate then adds
   * no scope blocker (backward-compatible).
   */
  readonly requiredScopeBindings: readonly ScopeBindingRequirement[];
}

// ── Requirements (the machine-consumable "still needs" list) ──────────────────

/** Which resource of the pair a requirement concerns — the polled source or the written target. */
export type EnablementSide = "source" | "target";

/**
 * SS-5 / SS-9 — one **required scope path-parameter binding**: a scope (non-record-id)
 * path parameter of an operation the rule calls, attributed to the side whose
 * `ResourceBinding` must satisfy it. A **discriminated union** over the parameter's
 * confirmed fill-source `kind` (`ResourceBinding.scopePathBindings`), precomputed by the
 * SA classifier and handed to the gate in {@link EnablementInput.requiredScopeBindings};
 * the gate checks each against the already-loaded `ResourceBinding`s and, when a
 * precondition is unmet, emits the matching `stillNeeds` requirement.
 *
 * - `constant` (SS-5) — satisfied by a confirmed `constant` binding on `side` (SS-5.5:
 *   source-operation params on the source binding, target-operation params on the
 *   target); an unmet one emits {@link ScopeBindingUnconfirmedRequirement}.
 * - `record-derived` (SS-9) — satisfied by **structural presence** (SS-9.1): the
 *   `record-derived` binding on `side` confirmed AND the polled **source** resource's
 *   `sourceScopeRef` confirmed carrying the component keyed `sourceScopeKey`. The gate
 *   checks presence only, **never** value-space equivalence (which the mediator cannot
 *   verify — the operator asserted it by choosing `record-derived`); an unmet target
 *   binding emits {@link ScopeBindingUnconfirmedRequirement}, an unmet/missing source
 *   component {@link SourceScopeRefUnconfirmedRequirement}.
 */
export type ScopeBindingRequirement =
  ConstantScopeBindingRequirement | RecordDerivedScopeBindingRequirement;

/** SS-5 — a scope parameter filled by a confirmed `constant` binding on {@link ConstantScopeBindingRequirement.side}. */
export interface ConstantScopeBindingRequirement {
  readonly kind: "constant";
  /** The scope path parameter's name (as it appears in the operation's path template + the binding entry). */
  readonly parameterName: string;
  /** Which side's `ResourceBinding` must carry the confirmed `constant` (SS-5.5). */
  readonly side: EnablementSide;
  /** The `resourceRef` of the binding the parameter is checked against — the side's mapped resource. */
  readonly resourceRef: string;
}

/**
 * SS-9 — a scope parameter filled by a confirmed `record-derived` binding. It is
 * satisfied only by the structural presence of two confirmed pieces on the two sides:
 * the `record-derived` binding entry (on `side`, the written target) and the polled
 * source resource's `sourceScopeRef` component keyed `sourceScopeKey`.
 */
export interface RecordDerivedScopeBindingRequirement {
  readonly kind: "record-derived";
  /** The scope path parameter's name (as it appears in the operation's path template + the binding entry). */
  readonly parameterName: string;
  /** The side whose `ResourceBinding` carries the `record-derived` entry (the written target). */
  readonly side: EnablementSide;
  /** The `resourceRef` of the binding carrying the `record-derived` entry — the side's mapped resource. */
  readonly resourceRef: string;
  /** The polled **source** resource whose confirmed `sourceScopeRef` must carry the selected component. */
  readonly sourceResourceRef: string;
  /** The captured-scope component `key` the binding selects (SS-8 `sourceScopeKey`). */
  readonly sourceScopeKey: string;
}

/**
 * The confirmable `ResourceBinding` refs the gate can require. Named verbatim from
 * `docs/architecture/data-model.md` `ResourceBinding` so the checklist item maps
 * one-to-one onto the confirm/correct action (RB-2) that clears it.
 */
export type BindingRefName =
  "nativeIdRef" | "collectionReadRef" | "paginationRef" | "deltaCursorRef" | "deltaDeletionRef";

/**
 * Why a binding ref is required — the *use* that needs it (`docs/architecture/data-model.md`
 * `ResourceBinding`: "an unconfirmed ref is used nowhere"). Informational, so SU-1
 * can explain each checklist item; the `(ref, side)` pair alone identifies the gap.
 */
export type BindingRefUse =
  | "native-id" // BE-2.1 — everything record-identity-shaped depends on it.
  | "polling-enumeration" // BE-2.2 — a full-fetch rule polls via the collection read.
  | "backfill-enumeration" // BE-2.2 — backfill always enumerates the source (even a delta rule).
  | "pagination" // BE-2.2 — the enumerated collection read pages.
  | "delta-cursor" // BE-2.3 — a delta-polling rule reads/advances the cursor.
  | "delta-deletion"; // BE-1.4 / BE-2.3 — `propagate` on a delta rule needs deletion reporting.

/**
 * A structured, typed reason a rule is not yet enable-able (BE-1.5 / BE-2.5). The
 * `stillNeeds` list is a discriminated union — **never** a bare string — so the
 * enablement UI (SU-1) can render each item and route it to the action that clears
 * it, and so tests can assert the exact missing decision rather than a message.
 */
export type EnablementRequirement =
  | IdentityKeyRequirement
  | PollOperationRequirement
  | PropagatableOperationRequirement
  | TargetOperationRequirement
  | BindingRefRequirement
  | IdentityLookupPathRequirement
  | ScopeBindingUnconfirmedRequirement
  | SourceScopeRefUnconfirmedRequirement;

/**
 * BE-1.1 — the hard identity gate. A resource pair needs **exactly one** confirmed
 * identity `FieldMapping` (`isIdentityKey = true`): `missing` (zero) can silently
 * create duplicates, `ambiguous` (more than one) can silently merge unrelated
 * records — the worst failure mode. `confirmedCount` carries the observed count.
 */
export interface IdentityKeyRequirement {
  readonly kind: "identity-key";
  readonly issue: "missing" | "ambiguous";
  readonly confirmedCount: number;
}

/**
 * BE-1.2 — the source's `pollOperationRef` is not pinned/confirmed. (The domain
 * `SyncRule` models `pollOperationRef` as a plain optional string with no separate
 * confirmation metadata, so the gate treats **present + non-empty** as confirmed;
 * see the module note in `enablement-gate.ts`.)
 */
export interface PollOperationRequirement {
  readonly kind: "poll-operation-ref";
}

/**
 * BE-1.3 — the rule has **nothing to propagate**: neither an approved `create` nor
 * a usable `update` `OperationMapping`. (A rule with only a `create` enables
 * create-only; a rule with only an `update` propagates updates — this fires only
 * when *both* are absent.)
 */
export interface PropagatableOperationRequirement {
  readonly kind: "propagatable-operation";
}

/**
 * BE-1.3 / BE-1.4 — a target `OperationMapping` the rule needs is missing or
 * unusable:
 *  - `action: "update", issue: "missing-target-id-param"` — an approved `update`
 *    op exists but carries no `targetIdParamRef`, so updates cannot be routed to
 *    the linked target record (BE-1.3: "`update` with its `targetIdParamRef`").
 *  - `action: "delete", issue: "missing"` — `deletePropagation = propagate` but no
 *    approved `action = delete` op (BE-1.4).
 *  - `action: "delete", issue: "missing-target-id-param"` — a `delete` op exists but
 *    carries no `targetIdParamRef`, so the delete cannot be routed via the link
 *    (`docs/architecture/data-model.md` `OperationMapping.targetIdParamRef`).
 */
export interface TargetOperationRequirement {
  readonly kind: "target-operation";
  readonly action: "update" | "delete";
  readonly issue: "missing" | "missing-target-id-param";
}

/** BE-2.1..2.3 / BE-1.4 — a required `ResourceBinding` ref is unconfirmed on one side. */
export interface BindingRefRequirement {
  readonly kind: "binding-ref";
  readonly ref: BindingRefName;
  readonly side: EnablementSide;
  readonly usedFor: BindingRefUse;
}

/**
 * BE-1.6 — the resource pair has **neither** identity-lookup path (no confirmed
 * `FieldMapping.targetLookupParamRef` filtered read *and* no confirmed target
 * `collectionReadRef` fetch-and-match; RL-3 criterion 5) **and** backfill was not
 * explicitly skipped. Enable is permitted for such a pair **only** with backfill
 * explicitly skipped (which turns this into the {@link MatchFirstUnavailableDegradation}
 * flag instead) — so the fix is either establish a lookup path or skip backfill.
 */
export interface IdentityLookupPathRequirement {
  readonly kind: "identity-lookup-path";
}

/**
 * SS-5.4 / SS-9.1 — a required scope path-parameter binding is **unconfirmed** on the
 * named side, so a scoped `SyncRule` cannot go live (it would fail at runtime on a
 * literal `{owner}`). The `stillNeeds` member emitted for the *binding-on-`side`* half of
 * either a `constant` (SS-5) or a `record-derived` (SS-9) {@link ScopeBindingRequirement}:
 * it names the `parameterName`, the `side` whose `ResourceBinding.scopePathBindings` must
 * carry the confirmed entry, and that binding's `resourceRef` — so SU-1/SU-5 (SS-6/SS-9
 * UI) can route the operator to the exact scope parameter to supply/confirm (RB-3).
 * Composes with the BE-1/BE-2 requirements above in the same list. (A `record-derived`
 * requirement's *other* half — the source `sourceScopeRef` component — is the separate
 * {@link SourceScopeRefUnconfirmedRequirement}.)
 */
export interface ScopeBindingUnconfirmedRequirement {
  readonly kind: "scope-binding";
  readonly parameterName: string;
  readonly side: EnablementSide;
  readonly resourceRef: string;
}

/**
 * SS-9.1 — the **source** half of a `record-derived` scope requirement is unmet: the
 * polled source resource's `sourceScopeRef` is unconfirmed, absent, or does not carry the
 * component keyed `sourceScopeKey` that the `record-derived` binding selects. Distinct
 * from {@link ScopeBindingUnconfirmedRequirement} (the target binding half) so SU-1/SU-5
 * (SS-9 UI) can route the operator to confirm/correct the source `sourceScopeRef` (SS-7)
 * rather than the target scope binding. `side` is always `"source"`; `resourceRef` names
 * the source resource whose `sourceScopeRef` is missing the component. The gate checks
 * **structural presence** of the component only — never value-space equivalence.
 */
export interface SourceScopeRefUnconfirmedRequirement {
  readonly kind: "source-scope-ref";
  readonly side: EnablementSide;
  readonly resourceRef: string;
  readonly sourceScopeKey: string;
}

// ── Degradations (non-blocking notes SU-1 states before the rule turns on) ────

/**
 * A non-blocking degradation the enablement UI (SU-1) must state *before* the rule
 * turns on. Carried only on an `enable` decision — a blocked rule never goes live,
 * so its degradations are moot. Discriminated union, same machine-consumable shape
 * as {@link EnablementRequirement}.
 */
export type EnablementDegradation =
  MatchFirstUnavailableDegradation | LwwObservationOrderDegradation;

/**
 * BE-1.6 — enable is proceeding for a pair with neither identity-lookup path (only
 * possible because backfill was explicitly skipped). Match-first is unavailable:
 * steady-state creates go straight to create, risking **duplicates** for
 * pre-existing records, and links form only via create-propagation or manually.
 */
export interface MatchFirstUnavailableDegradation {
  readonly kind: "match-first-unavailable";
}

/**
 * BE-2.4 — a side declares `supportsChangeTimestamps` but its `changeTimestampRef`
 * is unconfirmed, so last-write-wins conflict resolution degrades to **observation
 * order** for that side (CF-2). Explicitly **not** a blocker — surfaced only so the
 * operator knows LWW is degraded until the ref is confirmed.
 */
export interface LwwObservationOrderDegradation {
  readonly kind: "lww-observation-order";
  readonly side: EnablementSide;
}

// ── Decision ──────────────────────────────────────────────────────────────────

/**
 * The gate's verdict — a discriminated union (no boolean soup): either the rule may
 * be enabled, or it is blocked with the exact list of what it still needs.
 */
export type EnablementDecision = EnableDecision | BlockedDecision;

/** The rule may be enabled. */
export interface EnableDecision {
  readonly kind: "enable";
  /**
   * Whether the enable action will trigger a one-time initial backfill run (BE-3,
   * a later slice), vs. proceeding with backfill explicitly skipped. Equals
   * `!EnablementInput.backfillSkipped`; carried on the decision so the caller need
   * not re-derive it. A neither-lookup-path enable always has this `false`.
   */
  readonly backfillRequired: boolean;
  /** Non-blocking degradations SU-1 must state before the rule turns on (possibly empty). */
  readonly degradations: readonly EnablementDegradation[];
}

/** The rule is blocked; `stillNeeds` lists exactly the refs/decisions it still needs (BE-1.5 / BE-2.5). */
export interface BlockedDecision {
  readonly kind: "blocked";
  readonly stillNeeds: readonly EnablementRequirement[];
}
