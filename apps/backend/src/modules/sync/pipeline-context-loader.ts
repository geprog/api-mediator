import type { ScopeLinkStore } from "@mediator/db";
import type { FieldMapping } from "@mediator/domain";
import { resolveRecordAddressing, stripUndefined } from "@mediator/domain";
import {
  PermanentOutboundError,
  resolveSingleRecordReadBinding,
  type ResolvedTargetOperation,
  type SyncPipelineContext,
  type SyncPipelineContextLoader,
} from "@mediator/outbound";
import type {
  ConflictDetectionContext,
  DeletionConflictContext,
  DetectedChange,
  SingleRecordReadBinding,
  TargetWriteShape,
} from "@mediator/sync-engine";

import { resolveScopedContainer } from "./container-routing.js";
import {
  buildLoopPreventionContext,
  buildResolutionContext,
  resolveTargetOperations,
  toConflictField,
} from "./context-builders.js";
import {
  confirmedFieldPath,
  confirmedValue,
  fieldMappingsForResourcePair,
  findIdentityField,
  resolveRuleArtifacts,
  type RuleArtifactRepos,
  type RuleArtifacts,
} from "./resolution.js";

/**
 * **The real {@link SyncPipelineContextLoader}** — the composition slice's central new
 * code. It turns the persisted mapping + binding + IR state a `DetectedChange` points
 * at into the {@link SyncPipelineContext} the `SyncPipelineHandler` feeds to every
 * pipeline stage (RL/EP/CF/TX/OC). The handler and stages consume already-resolved
 * *wire shapes* and *contexts*; this loader is where the DB rows become them.
 *
 * What it resolves, per change:
 *  - **Canonical A/B** for the `resourcePairRef` (the `RecordLink`/`SyncFieldState`
 *    key space) and this rule's source/target sides;
 *  - **RL context** — the confirmed identity source/target paths, the target lookup
 *    path (filtered-read when the identity `FieldMapping.targetLookupParamRef` is set,
 *    else fetch-and-match over the confirmed `collectionReadRef`, else none), the
 *    create-op policy, and the field pairings;
 *  - **EP context** — canonical A/B + **both** directions' `FieldMapping`s (the
 *    counterpart mapping's included when the pair is bidirectional) so the echo compare
 *    covers every participating side-field (EP-1.2);
 *  - **CF write + delete contexts** — the target write fields, PATCH-vs-PUT shape (from
 *    the resolved `update` op's method), the `targetDriftCheck`/`deletePropagation`
 *    policy, the LWW comparability AND (both apps' `supportsChangeTimestamps` AND both
 *    resources' confirmed `changeTimestampRef`), and the single-record read binding;
 *  - **The action-selected target operations** (`create`/`update`/`delete`) resolved to
 *    `RestOperationBinding`s, plus the target base URL, `nativeIdRef`, and OC-3 ceilings
 *    the Outbound Call Executor needs.
 *
 * A change whose rule/mapping/binding state is missing, self-inconsistent, or carries
 * no confirmed identity key or target native id is a **config error, not a transient
 * fault**: the loader throws a {@link PermanentOutboundError} so the dispatcher parks the
 * entry (never a retry storm over a mapping that cannot be executed).
 */
export class RepoSyncPipelineContextLoader implements SyncPipelineContextLoader {
  readonly #repos: RuleArtifactRepos;
  readonly #scopeLinks: ScopeLinkStore;

  public constructor(repos: RuleArtifactRepos, scopeLinks: ScopeLinkStore) {
    this.#repos = repos;
    this.#scopeLinks = scopeLinks;
  }

  public async load(change: DetectedChange): Promise<SyncPipelineContext> {
    const artifacts = await resolveRuleArtifacts(change.ruleId, this.#repos);
    if (artifacts === undefined) {
      throw new PermanentOutboundError(
        `sync pipeline: rule ${change.ruleId} did not resolve to executable mapping/binding/IR state`,
      );
    }

    const identityField = findIdentityField(artifacts.fieldMappings);
    if (identityField === undefined) {
      throw new PermanentOutboundError(
        `sync pipeline: rule ${change.ruleId} has no single confirmed identity FieldMapping`,
      );
    }
    const targetNativeIdRef = confirmedValue(artifacts.targetBinding.nativeIdRef);
    if (targetNativeIdRef === undefined || targetNativeIdRef.kind !== "field") {
      throw new PermanentOutboundError(
        `sync pipeline: target resource has no confirmed nativeIdRef — a create's new native id cannot be read`,
      );
    }

    // SS-12 — resolve the record's container once from the change's captured scope (Layer 3:
    // the matched active `ScopeLink`; Layer 2: the frozen `record-derived` values), for the
    // create op's fill + the new link's `scopeRef`. Absent on a delete (no captured scope) —
    // a linked delete routes from the stored `scopeRef` in the handler instead. Shared with
    // the initial-backfill discharge (SS-13) via `resolveScopedContainer`.
    const container = await resolveScopedContainer({
      capturedScope: change.capturedScope,
      resourcePairRef: change.resourcePairRef,
      sourceAppId: change.sourceAppId,
      targetAppId: change.targetAppId,
      scopePathBindings: artifacts.targetBinding.scopePathBindings ?? [],
      scopeLinks: this.#scopeLinks,
    });

    // SS-8.3 — thread the change's captured scope so each `record-derived` target scope
    // param is filled from it (by the binding's `sourceScopeKey`) alongside the constants;
    // absent on a non-scoped rule and on a delete → constant-only fill (unchanged). SS-12 —
    // `containerRouting` fills the create op's `scope-link` container and leaves the
    // update/delete ops' container params templated for the handler's `scopeRef` fill.
    const operations = resolveTargetOperations(
      artifacts.operationMappings,
      artifacts.targetGroup,
      artifacts.targetBinding,
      change.capturedScope,
      stripUndefined({ createScopeLinkValues: container.createScopeLinkValues }),
    );
    const targetReadBinding = resolveSingleRecordReadBinding(
      artifacts.targetGroup,
      artifacts.targetBinding,
    );
    const writableFields = artifacts.fieldMappings.filter((field) => field.isIdentityKey !== true);

    // SS-19 — the two sides' confirmed `recordAddressRef` field paths, so the new
    // `RecordLink` freezes each side's container-relative address at establishment. Absent
    // per side when that side addresses by its native id (no ref, or unconfirmed).
    const sourceRecordAddressPath = confirmedFieldPath(artifacts.sourceBinding.recordAddressRef);
    const targetRecordAddressPath = confirmedFieldPath(artifacts.targetBinding.recordAddressRef);

    const resolution = stripUndefined({
      ...buildResolutionContext(artifacts, identityField, operations.create !== undefined),
      sourceRecordAddressPath,
      targetRecordAddressPath,
      // SS-12.2/12.7 — freeze the resolved container onto the new link at establishment.
      scopeRefForNewLink: container.scopeRefForNewLink,
      // SS-14.1 — the target container scope fill so the identity lookup searches ONLY within
      // the record's resolved target container (never a global read that could cross-match).
      targetContainerScope: container.targetContainerScope,
    });
    const loopPrevention = buildLoopPreventionContext(
      artifacts,
      change.sourceAppId,
      await this.#counterpartFields(artifacts),
    );
    const conflict = this.#buildConflictContext(
      artifacts,
      writableFields,
      operations.update,
      targetReadBinding,
    );
    const deletion = this.#buildDeletionContext(artifacts, writableFields, targetReadBinding);

    return stripUndefined({
      resolution,
      loopPrevention,
      conflict,
      deletion,
      fieldMappings: artifacts.fieldMappings,
      sourceResourceRef: sourceResource(change, artifacts),
      targetResourceRef: targetResource(change, artifacts),
      createOperation: operations.create,
      updateOperation: operations.update,
      deleteOperation: operations.delete,
      targetBaseUrl: artifacts.targetBaseUrl,
      targetResourceNativeIdRef: targetNativeIdRef,
      targetAppLimits: artifacts.targetApp.outboundLimits,
      sourceChangeTimestampRef: confirmedFieldPath(artifacts.sourceBinding.changeTimestampRef),
      targetChangeTimestampRef: confirmedFieldPath(artifacts.targetBinding.changeTimestampRef),
      // SS-12 — the target resource's scope path bindings, so the handler fills a linked
      // delete's still-templated container `{…}` from the record's stored `RecordLink.scopeRef`.
      scopePathBindings: artifacts.targetBinding.scopePathBindings,
      // SS-19 — how the target addresses its records, decided once here from the target
      // binding + whether the resource is container-scoped. `native-id` (the default for an
      // absent ref) reproduces the pre-SS-19 composition exactly.
      targetRecordAddressing: resolveRecordAddressing(
        artifacts.targetBinding,
        (artifacts.targetBinding.scopePathBindings ?? []).length > 0,
      ),
      // SS-19 — so OC can read a create response's container-relative address.
      targetResourceRecordAddressRef: confirmedValue(artifacts.targetBinding.recordAddressRef),
    });
  }

  /** The bidirectional counterpart's `FieldMapping`s (empty for a one-way rule) — EP-1.2. */
  async #counterpartFields(artifacts: RuleArtifacts): Promise<readonly FieldMapping[]> {
    const counterpartMappingId = artifacts.mapping.counterpartMappingId;
    if (counterpartMappingId === undefined || counterpartMappingId === null) {
      return [];
    }
    const fields = await this.#repos.mappingArtifacts.listFieldMappings(counterpartMappingId);
    // Same resource-pair scoping as the rule's own fields, with the sides SWAPPED: the
    // counterpart runs the reverse direction, so its `sourcePath` lives in this rule's
    // target resource and its `targetPath` in this rule's source resource. Without this,
    // a foreign pair's fields would widen the echo compare's participating-field set.
    return fieldMappingsForResourcePair(
      fields,
      artifacts.targetResourceRef,
      artifacts.sourceResourceRef,
    );
  }

  #buildConflictContext(
    artifacts: RuleArtifacts,
    writableFields: readonly FieldMapping[],
    updateOperation: ResolvedTargetOperation | undefined,
    targetReadBinding: SingleRecordReadBinding | undefined,
  ): ConflictDetectionContext {
    const changeTimestampsComparable =
      artifacts.sourceApp.capabilities.supportsChangeTimestamps &&
      artifacts.targetApp.capabilities.supportsChangeTimestamps &&
      confirmedFieldPath(artifacts.sourceBinding.changeTimestampRef) !== undefined &&
      confirmedFieldPath(artifacts.targetBinding.changeTimestampRef) !== undefined;
    const writeShape: TargetWriteShape =
      updateOperation?.operation.method === "PUT" ? "put" : "patch";
    return stripUndefined({
      appAId: artifacts.appAId,
      appBId: artifacts.appBId,
      fields: writableFields.map(toConflictField),
      writeShape,
      targetDriftCheck: artifacts.rule.targetDriftCheck ?? "none",
      changeTimestampsComparable,
      targetChangeTimestampRef: confirmedFieldPath(artifacts.targetBinding.changeTimestampRef),
      targetReadBinding,
    });
  }

  #buildDeletionContext(
    artifacts: RuleArtifacts,
    writableFields: readonly FieldMapping[],
    targetReadBinding: SingleRecordReadBinding | undefined,
  ): DeletionConflictContext {
    return stripUndefined({
      appAId: artifacts.appAId,
      appBId: artifacts.appBId,
      deletePropagation: artifacts.rule.deletePropagation ?? "ignore",
      targetDriftCheck: artifacts.rule.targetDriftCheck ?? "none",
      targetFields: writableFields.map((field) => field.targetPath),
      targetReadBinding,
    });
  }
}

function sourceResource(change: DetectedChange, artifacts: RuleArtifacts): string {
  return change.sourceAppId === artifacts.mapping.sourceAppId
    ? artifacts.sourceResourceRef
    : artifacts.targetResourceRef;
}

function targetResource(change: DetectedChange, artifacts: RuleArtifacts): string {
  return change.targetAppId === artifacts.mapping.targetAppId
    ? artifacts.targetResourceRef
    : artifacts.sourceResourceRef;
}
