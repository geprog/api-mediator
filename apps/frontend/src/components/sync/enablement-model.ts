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

/** One rendered checklist blocker: a stable key, a human label, and an optional deep link. */
export interface EnablementChecklistItem {
  readonly key: string;
  readonly label: string;
  /**
   * SU-5.1 — for an unconfirmed `ResourceBinding` ref blocker, the route to the
   * Phase-1 binding-confirmation panel (RB-3). The SA-2 DTO carries the owning app
   * id (not the spec id), so this deep-links to that side's app-detail page, whose
   * spec list reaches the binding panel. `null` for non-ref blockers.
   */
  readonly bindingLink: string | null;
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

/** Glossary-exact human label + deep link for one hard-blocker requirement. */
export function describeRequirement(
  requirement: EnablementRequirementDto,
  resourcePair: SyncRuleResourcePairDto | null,
): EnablementChecklistItem {
  switch (requirement.kind) {
    case "identity-key":
      return {
        key: "identity-key",
        label:
          requirement.issue === "missing"
            ? "Confirm the identity key — no identity FieldMapping is set (a rule cannot merge records without exactly one)."
            : `Confirm exactly one identity key — ${String(requirement.confirmedCount)} are set (ambiguous).`,
        bindingLink: null,
      };
    case "poll-operation-ref":
      return {
        key: "poll-operation-ref",
        label: "Confirm the poll operation (pollOperationRef) the source is polled on.",
        bindingLink: null,
      };
    case "propagatable-operation":
      return {
        key: "propagatable-operation",
        label:
          "Approve a create or update target operation — the rule has nothing it can propagate.",
        bindingLink: null,
      };
    case "target-operation":
      return {
        key: `target-operation:${requirement.action}:${requirement.issue}`,
        label:
          requirement.issue === "missing"
            ? `Approve a target ${requirement.action} operation (delete propagation needs one).`
            : `The target ${requirement.action} operation needs its target-id parameter (targetIdParamRef) to route via the RecordLink.`,
        bindingLink: null,
      };
    case "binding-ref":
      return {
        key: `binding-ref:${requirement.side}:${requirement.ref}`,
        label: `Confirm the ${requirement.side} ResourceBinding ${requirement.ref} (used for ${requirement.usedFor}).`,
        bindingLink: bindingLinkFor(requirement.side, resourcePair),
      };
    case "identity-lookup-path":
      // Not a hard blocker (surfaced as a degradation); described defensively for totality.
      return {
        key: "identity-lookup-path",
        label:
          "No identity-lookup path — match-first is unavailable; enable only with backfill skipped.",
        bindingLink: null,
      };
    case "scope-binding":
      // SS-5.4 — a hard blocker; the full supply/confirm panel is SS-6. Deep-links to the
      // side's app where the Phase-1 binding panel (RB-3) supplies the scope constant.
      return {
        key: `scope-binding:${requirement.side}:${requirement.parameterName}`,
        label: `Supply and confirm the ${requirement.side} scope path-parameter '${requirement.parameterName}' (a constant) on ${requirement.resourceRef}.`,
        bindingLink: bindingLinkFor(requirement.side, resourcePair),
      };
  }
}

/** The hard-blocker checklist the panel renders (SU-1.1 / SU-5.1). */
export function enablementChecklist(
  stillNeeds: readonly EnablementRequirementDto[],
  resourcePair: SyncRuleResourcePairDto | null,
): readonly EnablementChecklistItem[] {
  return blockingRequirements(stillNeeds).map((requirement) =>
    describeRequirement(requirement, resourcePair),
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
