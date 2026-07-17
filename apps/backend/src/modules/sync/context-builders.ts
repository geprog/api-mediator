import type {
  FieldMapping,
  IrResourceGroup,
  OperationMapping,
  ResourceBinding,
  SyncFieldStateSide,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import { resolveWriteOperationBinding, type ResolvedTargetOperation } from "@mediator/outbound";
import type {
  ConflictField,
  LoopPreventionContext,
  MappingDirection,
  ResolutionContext,
  TargetLookupCapability,
  TargetReadBinding,
} from "@mediator/sync-engine";
import type { CapturedScope } from "@mediator/transform";

import { confirmedFieldPath, confirmedValue, type RuleArtifacts } from "./resolution.js";

/**
 * Shared **pure builders** that turn a rule's loaded {@link RuleArtifacts} into the
 * stage contexts the Sync Engine consumes. Extracted so the two composition callers —
 * the per-change {@link RepoSyncPipelineContextLoader} (steady-state) and the per-enable
 * `enable-resolver` (initial backfill) — build the *identical* Identity-Resolution /
 * Loop-Prevention contexts + resolved target operations for the same rule, rather than
 * two subtly diverging copies. No I/O here: the caller loads the artifacts (and the
 * counterpart mapping's fields) and hands them in.
 */

/** The action-selected target operations, each resolved to its `RestOperationBinding` (or absent). */
export interface ResolvedTargetOperations {
  readonly create?: ResolvedTargetOperation;
  readonly update?: ResolvedTargetOperation;
  readonly delete?: ResolvedTargetOperation;
}

/**
 * Resolve each `OperationMapping` to its `RestOperationBinding` and index by `action`
 * (the first that resolves per action wins). A stale/foreign `targetOperationRef`, or a
 * scoped op whose scope binding cannot be filled (an unconfirmed `constant` — SS-4.4 —
 * or a `record-derived` param whose captured component is missing — SS-8.3), is skipped —
 * never a fabricated binding; the pipeline then refuses the write loudly (`#requireOperation`
 * throws → the dispatcher parks) rather than mis-scoping. `targetBinding` supplies the
 * scope `constant`s (SS-4.2); `capturedScope` — the change's captured scope, present only
 * on a scoped rule's create/update — fills each `record-derived` scope param (SS-8.3).
 */
export function resolveTargetOperations(
  operationMappings: readonly OperationMapping[],
  targetGroup: IrResourceGroup,
  targetBinding: ResourceBinding,
  capturedScope?: CapturedScope,
): ResolvedTargetOperations {
  const resolved: {
    create?: ResolvedTargetOperation;
    update?: ResolvedTargetOperation;
    delete?: ResolvedTargetOperation;
  } = {};
  for (const operationMapping of operationMappings) {
    const binding = resolveWriteOperationBinding(
      operationMapping,
      targetGroup,
      targetBinding,
      capturedScope,
    );
    if (binding === undefined) {
      continue;
    }
    const entry: ResolvedTargetOperation = { operation: binding, operationMapping };
    if (operationMapping.action === "create" && resolved.create === undefined) {
      resolved.create = entry;
    } else if (operationMapping.action === "update" && resolved.update === undefined) {
      resolved.update = entry;
    } else if (operationMapping.action === "delete" && resolved.delete === undefined) {
      resolved.delete = entry;
    }
  }
  return resolved;
}

/** RL's per-rule context: canonical A/B, confirmed identity paths, target lookup, create policy, pairings. */
export function buildResolutionContext(
  artifacts: RuleArtifacts,
  identityField: FieldMapping,
  hasApprovedCreateOperation: boolean,
): ResolutionContext {
  return {
    appAId: artifacts.appAId,
    appBId: artifacts.appBId,
    identitySourcePath: identityField.sourcePath,
    identityTargetPath: identityField.targetPath,
    targetLookup: buildTargetLookup(artifacts, identityField),
    hasApprovedCreateOperation,
    fieldMappings: artifacts.fieldMappings,
  };
}

/** RL-3 target lookup: filtered-read (confirmed lookup param) → fetch-and-match → none. */
export function buildTargetLookup(
  artifacts: RuleArtifacts,
  identityField: FieldMapping,
): TargetLookupCapability {
  const collectionOp = confirmedValue(artifacts.targetBinding.collectionReadRef);
  const nativeIdPath = confirmedFieldPath(artifacts.targetBinding.nativeIdRef);
  if (collectionOp?.kind !== "operation" || nativeIdPath === undefined) {
    return { kind: "none" };
  }
  const binding: TargetReadBinding = {
    collectionReadOperationId: collectionOp.operationId,
    nativeIdPath,
  };
  if (identityField.targetLookupParamRef !== undefined) {
    return { kind: "filtered-read", binding, lookupParamRef: identityField.targetLookupParamRef };
  }
  return { kind: "fetch-and-match", binding };
}

/**
 * EP's per-change context — canonical A/B + this direction's participation, plus the
 * bidirectional counterpart's (so the echo compare covers this side's OUTPUT fields;
 * EP-1.2). `counterpartFields` is empty for a one-way rule.
 */
export function buildLoopPreventionContext(
  artifacts: RuleArtifacts,
  sourceAppId: string,
  counterpartFields: readonly FieldMapping[],
): LoopPreventionContext {
  const thisSourceSide = sideOf(sourceAppId, artifacts.appAId);
  const directions: MappingDirection[] = [
    { sourceSide: thisSourceSide, fieldMappings: artifacts.fieldMappings },
  ];
  if (counterpartFields.length > 0) {
    directions.push({ sourceSide: opposite(thisSourceSide), fieldMappings: counterpartFields });
  }
  return { appAId: artifacts.appAId, appBId: artifacts.appBId, directions };
}

/** Project a `FieldMapping` to CF's per-field descriptor (target/source paths + optional policy). */
export function toConflictField(field: FieldMapping): ConflictField {
  return stripUndefined({
    targetPath: field.targetPath,
    sourcePath: field.sourcePath,
    conflictPolicy: field.conflictPolicy,
  });
}

/** Which side of the canonical pair an app id occupies. */
export function sideOf(appId: string, appAId: string): SyncFieldStateSide {
  return appId === appAId ? "A" : "B";
}

export function opposite(side: SyncFieldStateSide): SyncFieldStateSide {
  return side === "A" ? "B" : "A";
}
