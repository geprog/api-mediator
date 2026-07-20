import type {
  EnablementRequirementDto,
  SyncRuleResourcePairDto,
  SyncRuleStatusDto,
} from "@mediator/contracts";

/**
 * Pure derivations behind the SU-1 / SU-5 rule-enablement panel — kept free of Vue
 * so the gate presentation is unit-testable without mounting. The **server** owns
 * every enablement invariant (`docs/architecture/sync-engine.md` *Initial backfill* /
 * *Identity correlation* / *Conflict handling*; the BE-1/BE-2 gate). This layer only
 * turns the API's `stillNeeds` list + the rule set into the distinctions the panel
 * must surface and must never let a viewer/blocked rule mutate.
 *
 * Two facts the SA-2 list DTO does **not** carry are derived here:
 *  - **one-way vs. bidirectional** — a bidirectional pair is two rules sharing a
 *    `resourcePairRef`; a rule with no such counterpart is one-way (source-of-truth
 *    semantics, CF-6);
 *  - **push-on-both** — a `push` backfill is refused when the counterpart already
 *    backfills `push` (a contradiction; sync-engine *Initial backfill*).
 */

/** The operator's backfill decision — one of these, chosen explicitly (never defaulted). */
export type BackfillChoice = "link-only" | "push" | "skip";

/**
 * A checklist blocker's **call-to-action**: the route that fixes it plus the link label
 * (a Phase-1 `ResourceBinding` confirm panel, the SS-15.4 scope-identity-key panel, or the
 * SS-15.5 container-linking screen). `null` for a bare blocker with no in-app fix surface.
 */
export interface EnablementAction {
  readonly to: string;
  readonly label: string;
}

/** One rendered checklist blocker: a stable key, a human label, and an optional call-to-action. */
export interface EnablementChecklistItem {
  readonly key: string;
  readonly label: string;
  readonly action: EnablementAction | null;
}

/** Whether an enabled rule is still backfilling (not yet polling), polling, or disabled (BE-3). */
export type PollingState = "disabled" | "backfill-running" | "polling";

/**
 * The identity-lookup-path requirement is **not** a hard blocker: the gate lists it
 * only while a backfill would run, and it clears by explicitly skipping backfill
 * (BE-1.6 / RL-3.5). It is surfaced as the neither-lookup-path degradation, not a
 * checklist blocker.
 */
function isNeitherLookupPathRequirement(requirement: EnablementRequirementDto): boolean {
  return requirement.kind === "identity-lookup-path";
}

/** The hard blockers: every `stillNeeds` item except the skip-clearable identity-lookup-path. */
export function blockingRequirements(
  stillNeeds: readonly EnablementRequirementDto[],
): readonly EnablementRequirementDto[] {
  return stillNeeds.filter((requirement) => !isNeitherLookupPathRequirement(requirement));
}

/**
 * SU-1.3 — the resource pair has **neither** identity-lookup path (RL-3.5): match-first
 * is unavailable and enable is permitted only with backfill explicitly skipped. The gate
 * reports this as an `identity-lookup-path` requirement (present only while a backfill
 * would run — the list DTO evaluates the gate with backfill running).
 */
export function hasNeitherLookupPath(stillNeeds: readonly EnablementRequirementDto[]): boolean {
  return stillNeeds.some(isNeitherLookupPathRequirement);
}

/** The `/apps/:id` route for a ref blocker's side, or `null` when the pair does not resolve. */
function bindingLinkFor(
  side: "source" | "target",
  resourcePair: SyncRuleResourcePairDto | null,
): string | null {
  if (resourcePair === null) {
    return null;
  }
  return `/apps/${encodeURIComponent(resourcePair[side].appId)}`;
}

/** SU-5.1 — the "confirm this `ResourceBinding` ref" call-to-action for a side, or `null`. */
function bindingAction(
  side: "source" | "target",
  resourcePair: SyncRuleResourcePairDto | null,
): EnablementAction | null {
  const to = bindingLinkFor(side, resourcePair);
  return to === null ? null : { to, label: "Confirm binding →" };
}

/**
 * SS-15.4 — the "confirm the scope identity key" call-to-action, deep-linking to the
 * confirmation panel (SS-15.4) for this pair. `null` when the resource pair ref is unknown.
 */
function scopeIdentityKeyAction(resourcePairRef: string): EnablementAction | null {
  return resourcePairRef === ""
    ? null
    : {
        to: `/sync/scope-identity-key?pair=${encodeURIComponent(resourcePairRef)}`,
        label: "Confirm scope identity key →",
      };
}

/** SS-15.5 — the "link containers" call-to-action, to the container-linking screen. */
const CONTAINER_LINKING_ACTION: EnablementAction = {
  to: "/sync/container-links",
  label: "Link containers →",
};

/** Glossary-exact human label + call-to-action for one hard-blocker requirement. */
export function describeRequirement(
  requirement: EnablementRequirementDto,
  resourcePair: SyncRuleResourcePairDto | null,
  resourcePairRef = "",
): EnablementChecklistItem {
  switch (requirement.kind) {
    case "identity-key":
      return {
        key: "identity-key",
        label:
          requirement.issue === "missing"
            ? "Confirm the identity key — no identity FieldMapping is set (a rule cannot merge records without exactly one)."
            : `Confirm exactly one identity key — ${String(requirement.confirmedCount)} are set (ambiguous).`,
        action: null,
      };
    case "poll-operation-ref":
      return {
        key: "poll-operation-ref",
        label: "Confirm the poll operation (pollOperationRef) the source is polled on.",
        action: null,
      };
    case "propagatable-operation":
      return {
        key: "propagatable-operation",
        label:
          "Approve a create or update target operation — the rule has nothing it can propagate.",
        action: null,
      };
    case "target-operation":
      return {
        key: `target-operation:${requirement.action}:${requirement.issue}`,
        label:
          requirement.issue === "missing"
            ? `Approve a target ${requirement.action} operation (delete propagation needs one).`
            : `The target ${requirement.action} operation needs its target-id parameter (targetIdParamRef) to route via the RecordLink.`,
        action: null,
      };
    case "binding-ref":
      return {
        key: `binding-ref:${requirement.side}:${requirement.ref}`,
        label: `Confirm the ${requirement.side} ResourceBinding ${requirement.ref} (used for ${requirement.usedFor}).`,
        action: bindingAction(requirement.side, resourcePair),
      };
    case "identity-lookup-path":
      // Not a hard blocker (surfaced as a degradation); described defensively for totality.
      return {
        key: "identity-lookup-path",
        label:
          "No identity-lookup path — match-first is unavailable; enable only with backfill skipped.",
        action: null,
      };
    case "scope-binding":
      // SS-5.4 / SS-9.1b — a hard blocker; the full supply/confirm panel is SS-6/SS-9.
      // Deep-links to the side's app where the Phase-1 binding panel (RB-3) supplies the
      // scope constant (or, for a record-derived binding, the sourceScopeKey pick).
      return {
        key: `scope-binding:${requirement.side}:${requirement.parameterName}`,
        label: `Supply and confirm the ${requirement.side} scope path-parameter '${requirement.parameterName}' on ${requirement.resourceRef}.`,
        action: bindingAction(requirement.side, resourcePair),
      };
    case "source-scope-ref":
      // SS-9.1a — a hard blocker: the source record's scope capture (sourceScopeRef) must
      // be confirmed carrying the component a record-derived scope binding selects (SS-7).
      // Deep-links to the source app where the Phase-1 binding panel (RB-3) confirms it.
      // The key carries `resourceRef` too (not just side + sourceScopeKey): two scope
      // parameters selecting the **same** `sourceScopeKey` on **different** resources would
      // otherwise collide into one row / clash on the Vue `:key`.
      return {
        key: `source-scope-ref:${requirement.side}:${requirement.resourceRef}:${requirement.sourceScopeKey}`,
        label: `Confirm the ${requirement.side} record scope capture (sourceScopeRef) carrying the component '${requirement.sourceScopeKey}' on ${requirement.resourceRef}.`,
        action: bindingAction(requirement.side, resourcePair),
      };
    case "scope-identity-key":
      // SS-15.1/15.3 — a hard blocker: the pair's ScopeCorrespondence scope identity key must
      // be confirmed before any record's container can resolve. The call-to-action deep-links
      // to the SS-15.4 confirmation panel for this pair.
      return {
        key: "scope-identity-key",
        label:
          "Confirm the scope identity key (ScopeCorrespondence) — the source↔target container pairing a scoped rule resolves each record's container through.",
        action: scopeIdentityKeyAction(resourcePairRef),
      };
    case "scope-link":
      // SS-15.1/15.3 — a hard blocker for a per-scope-pinned rule: the source container is not
      // enumerable, so at least one ScopeLink must be pinned to cover the scopes in play. The
      // call-to-action opens the SS-15.5 container-linking screen.
      return {
        key: "scope-link",
        label:
          "Link containers — no ScopeLink covers the scopes in play (this source is not enumerable, so scopes must be pinned).",
        action: CONTAINER_LINKING_ACTION,
      };
    case "container-list-op":
      // SS-15.2/15.3 — a hard blocker: the source/target container resource's collection read
      // (collectionReadRef) must be confirmed so scopes can be discovered/enumerated. Deep-links
      // to that side's app where the Phase-1 binding panel (RB-3) confirms the collection read.
      return {
        key: `container-list-op:${requirement.side}`,
        label: `Confirm the ${requirement.side} container list operation (collectionReadRef) so its containers can be enumerated.`,
        action: bindingAction(requirement.side, resourcePair),
      };
  }
}

/** The hard-blocker checklist the panel renders (SU-1.1 / SU-5.1). */
export function enablementChecklist(
  stillNeeds: readonly EnablementRequirementDto[],
  resourcePair: SyncRuleResourcePairDto | null,
  resourcePairRef = "",
): readonly EnablementChecklistItem[] {
  return blockingRequirements(stillNeeds).map((requirement) =>
    describeRequirement(requirement, resourcePair, resourcePairRef),
  );
}
/**
 * The counterpart rule of a bidirectional pair: another rule with the **same**
 * `resourcePairRef`. `null` means the rule is one-way (SU-1.4 source-of-truth).
 */
export function findCounterpart(
  rules: readonly SyncRuleStatusDto[],
  rule: SyncRuleStatusDto,
): SyncRuleStatusDto | null {
  return (
    rules.find(
      (candidate) => candidate.id !== rule.id && candidate.resourcePairRef === rule.resourcePairRef,
    ) ?? null
  );
}

/** SU-1.4 — a rule with no counterpart is one-way (source-of-truth semantics for its fields). */
export function isOneWay(rules: readonly SyncRuleStatusDto[], rule: SyncRuleStatusDto): boolean {
  return findCounterpart(rules, rule) === null;
}

/**
 * SU-1.2 — `push` on this direction is refused when the counterpart already backfills
 * `push`: pushing both directions of a bidirectional pair is a contradiction.
 */
export function isPushBlockedByCounterpart(counterpart: SyncRuleStatusDto | null): boolean {
  return counterpart !== null && counterpart.backfillMode === "push";
}

/**
 * SU-1.5 / BE-3 — an enabled rule whose backfill is still `pending`/`running` is **not
 * yet polling**; polling begins only once the backfill has `completed` (or was `skipped`).
 */
export function derivePollingState(rule: SyncRuleStatusDto): PollingState {
  if (rule.status === "disabled") {
    return "disabled";
  }
  if (rule.backfillStatus === "pending" || rule.backfillStatus === "running") {
    return "backfill-running";
  }
  return "polling";
}

/** Inputs to the enable-affordance gate (a UX affordance; the server re-enforces OA-2/BE-*). */
export interface CanEnableInput {
  readonly stillNeeds: readonly EnablementRequirementDto[];
  readonly choice: BackfillChoice | null;
  readonly pushBlocked: boolean;
}

/**
 * Whether the enable action may be offered: no hard blocker remains, a backfill choice
 * is explicitly made, `push` is not chosen against a push counterpart, and — with
 * neither identity-lookup path — only `skip` is permitted (SU-1.1/1.2/1.3).
 */
export function canEnable(input: CanEnableInput): boolean {
  if (blockingRequirements(input.stillNeeds).length > 0) {
    return false;
  }
  if (input.choice === null) {
    return false;
  }
  if (input.choice === "push" && input.pushBlocked) {
    return false;
  }
  if (hasNeitherLookupPath(input.stillNeeds) && input.choice !== "skip") {
    return false;
  }
  return true;
}

/** Map the operator's backfill choice to the SA-1 enable request body. */
export function toEnableRequest(
  choice: BackfillChoice,
): { action: "backfill"; backfillMode: "link-only" | "push" } | { action: "skip-backfill" } {
  return choice === "skip"
    ? { action: "skip-backfill" }
    : { action: "backfill", backfillMode: choice };
}
