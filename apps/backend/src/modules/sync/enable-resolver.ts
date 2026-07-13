import type { FieldMapping, IrRefTarget } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type {
  BackfillRunInput,
  EnableRuleInput,
  LinkOnlyBackfillContext,
  PollSeedDescriptor,
  PushBackfillContext,
} from "@mediator/outbound";
import type { EnablementInput } from "@mediator/sync-engine";

import {
  buildLoopPreventionContext,
  buildResolutionContext,
  resolveTargetOperations,
} from "./context-builders.js";
import {
  confirmedFieldPath,
  confirmedValue,
  findIdentityField,
  resolveRuleArtifacts,
  type RuleArtifactRepos,
  type RuleArtifacts,
} from "./resolution.js";

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
 */
export async function resolveEnableRuleInput(
  ruleId: string,
  options: { readonly backfillSkipped: boolean },
  repos: RuleArtifactRepos,
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
  };

  const backfill = await buildBackfillRunInput(artifacts, repos);
  const pollSeed = buildPollSeed(artifacts);

  return { ok: true, input: { enablement, backfill, pollSeed } };
}

async function buildBackfillRunInput(
  artifacts: RuleArtifacts,
  repos: RuleArtifactRepos,
): Promise<BackfillRunInput> {
  const identityField = findIdentityField(artifacts.fieldMappings) ?? PLACEHOLDER_IDENTITY;
  const operations = resolveTargetOperations(artifacts.operationMappings, artifacts.targetGroup);
  const resolution = buildResolutionContext(
    artifacts,
    identityField,
    operations.create !== undefined,
  );

  const linkOnly: LinkOnlyBackfillContext = {
    ruleId: artifacts.rule.id,
    mappingId: artifacts.mapping.id,
    sourceAppId: artifacts.mapping.sourceAppId,
    targetAppId: artifacts.mapping.targetAppId,
    resourcePairRef: artifacts.rule.resourcePairRef,
    resolution,
    fieldMappings: artifacts.fieldMappings,
  };

  if ((artifacts.rule.backfillMode ?? "link-only") !== "push") {
    return { mode: "link-only", context: linkOnly };
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
  return { mode: "push", context };
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
