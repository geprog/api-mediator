import type { ApprovedMapping, FieldMapping, IrRefTarget, SourceScopeRef } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { ScopeLinkStore } from "@mediator/db";
import type {
  BackfillContainerResolution,
  BackfillFanOut,
  BackfillRunInput,
  EnableRuleInput,
  LinkOnlyBackfillContext,
  PollSeedDescriptor,
  PushBackfillContext,
} from "@mediator/outbound";
import type { DetectedChange, EnablementInput } from "@mediator/sync-engine";

import { resolveScopedContainer } from "./container-routing.js";
import {
  buildLoopPreventionContext,
  buildResolutionContext,
  resolveTargetOperations,
} from "./context-builders.js";
import { derivePollScopeMode } from "./poll-scope-mode.js";
import {
  confirmedFieldPath,
  confirmedValue,
  findIdentityField,
  resolveRuleArtifacts,
  type RuleArtifactRepos,
  type RuleArtifacts,
} from "./resolution.js";
import {
  computeRequiredScopeBindings,
  computeScopeLinkGate,
  type ScopeLinkGateDeps,
} from "./scope-requirements.js";
import { resolveScopeSet, type EnumerationRelister } from "./scope-set-resolver.js";

/**
 * **The enable-input resolver** — it turns persisted `SyncRule`/`ApprovedMapping`/
 * binding/IR state into the {@link EnableRuleInput} the `RuleEnabler` consumes: the
 * enablement-gate input (BE-1/BE-2), the initial-backfill run input (link-only BE-4 or
 * push BE-5, with the same RL/EP contexts the steady-state pipeline uses), and the
 * go-live poll-seed descriptor (BE-6). It is the enable-time counterpart of the
 * per-change pipeline context loader, sharing the same {@link buildResolutionContext} /
 * {@link buildLoopPreventionContext} so the backfill and the steady-state pipeline agree
 * on canonical A/B, identity paths, and field participation for a rule.
 *
 * The backfill enumerates the **rule's own forward direction** (`sourceAppId →
 * targetAppId`), so its RL/EP contexts are built for that direction.
 *
 * **SS-17.4 — per-scope backfill fan-out.** For a **per-scope** rule (enumerated or
 * pinned) it resolves the rule's scope set (enumerated: the SS-17.1 live re-list + SS-11
 * establishment; pinned: the operator's `constant`/`manual` links — SS-13.4) via the
 * shared {@link resolveScopeSet} and attaches it as {@link BackfillFanOut}, so the runner
 * reads the source collection **once per scope** with that scope's source-side container
 * fill and seeds per-scope state (BE-6 per scope). A cross-scope rule attaches no fan-out
 * (one un-scoped collection read, unchanged).
 */
export interface EnableInputResolution {
  ok: true;
  input: EnableRuleInput;
}
export interface EnableInputUnresolved {
  ok: false;
  reason: string;
}

/**
 * A placeholder identity `FieldMapping` used **only** to build a backfill context for a
 * rule whose identity key is missing/ambiguous — in which case the enablement gate
 * blocks and the backfill is never run, so these paths are never read. When the gate
 * passes there is exactly one confirmed identity field, so the real one is used.
 */
const PLACEHOLDER_IDENTITY: FieldMapping = {
  id: "",
  mappingId: "",
  sourcePath: "",
  targetPath: "",
  transform: "rename",
  isIdentityKey: true,
};

/**
 * Resolve the {@link EnableRuleInput} for a rule, or an `unresolved` result when the
 * rule/mapping/binding/IR state is missing (a base URL-less app, an unparseable
 * `resourcePairRef`, an absent spec/group/binding) — a state the enable action cannot
 * act on and surfaces to the operator rather than silently backfilling from nothing.
 *
 * `relister` is the SS-11 discovery service that drives the SS-17.1 live re-list for a
 * per-scope-enumerated rule's backfill fan-out (absent → no re-list; the backfill fans
 * out over the previously-established links only).
 */
export async function resolveEnableRuleInput(
  ruleId: string,
  options: { readonly backfillSkipped: boolean },
  repos: RuleArtifactRepos,
  scopeLinks: ScopeLinkStore,
  correspondences: ScopeLinkGateDeps["correspondences"],
  relister?: EnumerationRelister,
): Promise<EnableInputResolution | EnableInputUnresolved> {
  const artifacts = await resolveRuleArtifacts(ruleId, repos);
  if (artifacts === undefined) {
    return {
      ok: false,
      reason: `rule ${ruleId} did not resolve to executable mapping/binding/IR state`,
    };
  }

  const enablement: EnablementInput = {
    rule: artifacts.rule,
    fieldMappings: artifacts.fieldMappings,
    operationMappings: artifacts.operationMappings,
    sourceBinding: artifacts.sourceBinding,
    targetBinding: artifacts.targetBinding,
    sourceCapabilities: artifacts.sourceApp.capabilities,
    targetCapabilities: artifacts.targetApp.capabilities,
    backfillSkipped: options.backfillSkipped,
    requiredScopeBindings: computeRequiredScopeBindings(artifacts, {
      backfillSkipped: options.backfillSkipped,
    }),
    // SS-15.1/15.2 — the mode-aware `scope-link` preconditions (undefined for a non-scoped rule).
    scopeLinkGate: await computeScopeLinkGate(artifacts, { correspondences, scopeLinks, repos }),
  };

  const backfill = await buildBackfillRunInput(
    artifacts,
    repos,
    scopeLinks,
    correspondences,
    relister,
  );
  const pollSeed = buildPollSeed(artifacts);

  return { ok: true, input: { enablement, backfill, pollSeed } };
}

/** The SL-8.5 seeding-backfill resolution: the link-only run input, or an `unresolved` reason. */
export interface SeedBackfillResolution {
  ok: true;
  backfill: BackfillRunInput;
}
export interface SeedBackfillUnresolved {
  ok: false;
  reason: string;
}

/**
 * **SL-8.5 — resolve the LINK-ONLY seeding backfill for an adopted successor's added field
 * pairs.** Successor adoption re-points a rule to a successor mapping that may **add** a field
 * pair the stale predecessor lacked; that added pair has no `SyncFieldState` baseline over the
 * pre-existing `RecordLink`s, so Conflict Detection would read its absence as `drifted` →
 * target-wins-withhold, and the field would never propagate. This resolves the backfill that
 * seeds it: a link-only pass over the **existing** links (the same agree/disagree seeding
 * enablement's BE-4 backfill performs), which — because `SyncFieldStateStore.seed` never erases
 * an existing baseline — seeds ONLY the added fields (every already-seeded pair a no-op).
 *
 * It resolves the rule's artifacts against the **successor** mapping (committed at approval), so
 * the seed reads the successor's fields / new spec version / carried-forward bindings **without**
 * waiting for the adoption transaction's `approvedMappingId` re-point to commit. It reuses the
 * SAME {@link buildBackfillRunInput} the enablement path builds — **forced to `link-only`**, so a
 * rule whose configured `backfillMode` is `push` still only SEEDS, never a push re-write (SL-8.5
 * "no full re-backfill"). The go-live poll seed / enablement gate are deliberately NOT built:
 * this is a seed pass over an already-enabled rule, not a re-enable — cursor/snapshot/enablement
 * are untouched.
 */
export async function resolveAddedFieldSeedBackfill(
  ruleId: string,
  successorMapping: ApprovedMapping,
  repos: RuleArtifactRepos,
  scopeLinks: ScopeLinkStore,
  correspondences: ScopeLinkGateDeps["correspondences"],
  relister?: EnumerationRelister,
): Promise<SeedBackfillResolution | SeedBackfillUnresolved> {
  const artifacts = await resolveRuleArtifacts(ruleId, repos, successorMapping);
  if (artifacts === undefined) {
    return {
      ok: false,
      reason: `rule ${ruleId} did not resolve against successor mapping ${successorMapping.id} to executable state`,
    };
  }
  const backfill = await buildBackfillRunInput(
    artifacts,
    repos,
    scopeLinks,
    correspondences,
    relister,
    { forceLinkOnly: true },
  );
  return { ok: true, backfill };
}

async function buildBackfillRunInput(
  artifacts: RuleArtifacts,
  repos: RuleArtifactRepos,
  scopeLinks: ScopeLinkStore,
  correspondences: ScopeLinkGateDeps["correspondences"],
  relister: EnumerationRelister | undefined,
  // SL-8.5 — force `link-only` regardless of the rule's configured `backfillMode`, so the
  // added-field baseline SEED never becomes a push re-write ("no full re-backfill").
  options: { readonly forceLinkOnly?: boolean } = {},
): Promise<BackfillRunInput> {
  const identityField = findIdentityField(artifacts.fieldMappings) ?? PLACEHOLDER_IDENTITY;
  const operations = resolveTargetOperations(
    artifacts.operationMappings,
    artifacts.targetGroup,
    artifacts.targetBinding,
  );
  const resolution = buildResolutionContext(
    artifacts,
    identityField,
    operations.create !== undefined,
  );

  // SS-13 (SS-12 discharge) — on a **scoped** rule, backfill captures each record's scope
  // (`sourceScopeRef`) and freezes the record's resolved container onto the new
  // `RecordLink.scopeRef` via `resolveScopeRef` — the SAME container resolution a
  // steady-state create uses (`resolveScopedContainer`). A backfilled scoped record's
  // later scoped delete then routes from stored state instead of parking. Both are no-ops
  // on a non-scoped rule (no confirmed `sourceScopeRef` → no capture; no scope bindings →
  // `resolveScopedContainer` returns nothing), so a non-scoped backfill is unchanged.
  const sourceScopeRef = confirmedSourceScopeRef(artifacts);
  const resolveScopeRef = async (change: DetectedChange): Promise<BackfillContainerResolution> => {
    const container = await resolveScopedContainer({
      capturedScope: change.capturedScope,
      resourcePairRef: change.resourcePairRef,
      sourceAppId: change.sourceAppId,
      targetAppId: change.targetAppId,
      scopePathBindings: artifacts.targetBinding.scopePathBindings ?? [],
      scopeLinks,
    });
    return stripUndefined({
      scopeRef: container.scopeRefForNewLink,
      targetContainerScope: container.targetContainerScope,
    });
  };

  // SS-17.4 — a per-scope rule's backfill fans out over its scope set (undefined = a
  // cross-scope rule, one un-scoped collection read — unchanged).
  const fanOut = await resolveBackfillFanOut(artifacts, correspondences, scopeLinks, relister);

  const linkOnly: LinkOnlyBackfillContext = stripUndefined({
    ruleId: artifacts.rule.id,
    mappingId: artifacts.mapping.id,
    sourceAppId: artifacts.mapping.sourceAppId,
    targetAppId: artifacts.mapping.targetAppId,
    resourcePairRef: artifacts.rule.resourcePairRef,
    resolution,
    fieldMappings: artifacts.fieldMappings,
    sourceScopeRef,
    resolveScopeRef,
  });

  if (options.forceLinkOnly === true || (artifacts.rule.backfillMode ?? "link-only") !== "push") {
    return { mode: "link-only", context: linkOnly, ...(fanOut !== undefined ? { fanOut } : {}) };
  }

  const counterpartFields = await loadCounterpartFields(artifacts, repos);
  const loopPrevention = buildLoopPreventionContext(
    artifacts,
    artifacts.mapping.sourceAppId,
    counterpartFields,
  );
  const targetNativeIdRef = confirmedValue(artifacts.targetBinding.nativeIdRef);
  // Push writes always resolve the create's native id from the target's confirmed
  // nativeIdRef; the enablement gate guarantees it is confirmed before push runs, so the
  // placeholder is unreachable when the backfill actually executes.
  const targetResourceNativeIdRef: IrRefTarget =
    targetNativeIdRef?.kind === "field" ? targetNativeIdRef : { kind: "field", path: "" };
  const context: PushBackfillContext = stripUndefined({
    ...linkOnly,
    loopPrevention,
    createOperation: operations.create,
    updateOperation: operations.update,
    targetBaseUrl: artifacts.targetBaseUrl,
    targetResourceNativeIdRef,
    targetResourceRef: artifacts.targetResourceRef,
    targetAppLimits: artifacts.targetApp.outboundLimits,
    sourceChangeTimestampRef: confirmedFieldPath(artifacts.sourceBinding.changeTimestampRef),
    targetChangeTimestampRef: confirmedFieldPath(artifacts.targetBinding.changeTimestampRef),
  });
  return { mode: "push", context, ...(fanOut !== undefined ? { fanOut } : {}) };
}

/**
 * SS-17.4 — resolve the backfill's per-scope fan-out, or `undefined` for a cross-scope
 * rule (which backfills the single un-scoped collection read, unchanged). The effective
 * poll-scope mode is derived from the source container binding + the operator override —
 * the SAME derivation the `RepoPollPlanResolver` polls in, so the backfill fans out over
 * exactly the scopes the rule will poll. Enumerated mode runs the SS-17.1 live re-list +
 * SS-11 establishment (via `resolveScopeSet`); pinned mode uses the operator-pinned links
 * with no re-list (SS-17.6).
 */
async function resolveBackfillFanOut(
  artifacts: RuleArtifacts,
  correspondences: ScopeLinkGateDeps["correspondences"],
  scopeLinks: ScopeLinkStore,
  relister: EnumerationRelister | undefined,
): Promise<BackfillFanOut | undefined> {
  const correspondence = await correspondences.getByResourcePair(artifacts.rule.resourcePairRef);
  const effectiveMode =
    artifacts.rule.pollScopeMode ?? derivePollScopeMode(artifacts.sourceBinding, correspondence);
  if (effectiveMode === "cross-scope") {
    return undefined;
  }
  const { scopes, unresolvedScopes } = await resolveScopeSet({
    effectiveMode,
    resourcePairRef: artifacts.rule.resourcePairRef,
    sourceAppId: artifacts.sourceApp.id,
    sourceScopePathBindings: artifacts.sourceBinding.scopePathBindings ?? [],
    correspondence,
    links: scopeLinks,
    relister,
  });
  return { scopes, unresolvedScopes };
}

/**
 * The source resource's `sourceScopeRef` when it is **confirmed** (both stamps set) — the
 * scope capture backfill freezes the container from (SS-13). Absent/unconfirmed → no
 * capture (a non-scoped / constant-only rule is unaffected — SS-7.4).
 */
function confirmedSourceScopeRef(artifacts: RuleArtifacts): SourceScopeRef | undefined {
  const ref = artifacts.sourceBinding.sourceScopeRef;
  if (ref === undefined || ref.confirmedBy === null || ref.confirmedAt === null) {
    return undefined;
  }
  return ref;
}

async function loadCounterpartFields(
  artifacts: RuleArtifacts,
  repos: RuleArtifactRepos,
): Promise<readonly FieldMapping[]> {
  const counterpartMappingId = artifacts.mapping.counterpartMappingId;
  if (counterpartMappingId === undefined || counterpartMappingId === null) {
    return [];
  }
  return repos.mappingArtifacts.listFieldMappings(counterpartMappingId);
}

/**
 * The go-live cursor/snapshot seed (BE-6): a delta rule (source `supportsDeltaQuery` +
 * a present `deltaCursorRef`) seeds a deliberately-early changed-since cursor; a
 * full-fetch rule's snapshot is seeded from the backfill's complete enumeration.
 *
 * The `delta-cursor-returning` init variant (an opaque-cursor delta API) is not
 * distinguishable from a `changed-since` one in the current domain model, so a delta
 * rule defaults to `changed-since`; adopting cursor-returning is a documented follow-up.
 */
function buildPollSeed(artifacts: RuleArtifacts): PollSeedDescriptor {
  const deltaPolling =
    artifacts.sourceApp.capabilities.supportsDeltaQuery &&
    artifacts.sourceBinding.deltaCursorRef !== undefined;
  return deltaPolling ? { kind: "delta-changed-since" } : { kind: "full-fetch" };
}
