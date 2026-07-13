import type {
  AmbiguousMatchDto,
  DeadLetterWriteDto,
  EnableSyncRuleResponse,
  EnablementDegradationDto,
  EnablementRequirementDto,
  ParkedConflictDto,
  RecordLinkDto,
  SyncEventDto,
  SyncRuleStatusDto,
} from "@mediator/contracts";
import type { ParkedWriteEntry } from "@mediator/db";
import type { AuditLogEntry, ParkedConflict, RecordLink } from "@mediator/domain";
import type { EnablementDegradation, EnablementRequirement } from "@mediator/sync-engine";

import type {
  AmbiguousMatchView,
  EnableOutcome,
  SyncRuleView,
} from "../../modules/sync/operator.js";

/**
 * Wire mappers for the Sync HTTP API (SA-1..SA-3): view/domain → DTO. Every mapper
 * projects **only** metadata/ids/hashes/status/timestamps — **never** credential
 * material and never a live payload value (`docs/architecture/security.md`). Domain
 * `Date`s become ISO strings; absent optionals become `null`.
 *
 * The engine `EnablementRequirement`/`EnablementDegradation` unions are structurally
 * identical to their DTOs, so they map by direct assignment — a compile-time drift
 * check that fails here if the two shapes ever diverge (the route additionally
 * re-validates the whole response against its Zod schema).
 */

/** One `EnablementRequirement` (engine) → its DTO (identical shape). */
export function toEnablementRequirementDto(
  requirement: EnablementRequirement,
): EnablementRequirementDto {
  return requirement;
}

/** One `EnablementDegradation` (engine) → its DTO (identical shape). */
export function toEnablementDegradationDto(
  degradation: EnablementDegradation,
): EnablementDegradationDto {
  return degradation;
}

/** A `SyncRuleView` → the SA-2 wire shape. No credential material. */
export function toSyncRuleStatusDto(view: SyncRuleView): SyncRuleStatusDto {
  const { rule, resourcePair, stillNeeds, pollerLag } = view;
  return {
    id: rule.id,
    approvedMappingId: rule.approvedMappingId,
    status: rule.status,
    backfillStatus: rule.backfillStatus ?? null,
    backfillMode: rule.backfillMode ?? null,
    deletePropagation: rule.deletePropagation ?? null,
    targetDriftCheck: rule.targetDriftCheck ?? null,
    pollIntervalOverride: rule.pollIntervalOverride ?? null,
    pollOperationRef: rule.pollOperationRef ?? null,
    lastRunAt: rule.lastRunAt != null ? rule.lastRunAt.toISOString() : null,
    lastEventAt: rule.lastEventAt != null ? rule.lastEventAt.toISOString() : null,
    resourcePairRef: rule.resourcePairRef,
    resourcePair:
      resourcePair === undefined
        ? null
        : {
            source: { ...resourcePair.source },
            target: { ...resourcePair.target },
          },
    stillNeeds: stillNeeds.map(toEnablementRequirementDto),
    pollerLag: {
      lastRunAt: pollerLag.lastRunAt !== null ? pollerLag.lastRunAt.toISOString() : null,
      expectedIntervalMs: pollerLag.expectedIntervalMs,
      lagMs: pollerLag.lagMs,
      stuck: pollerLag.stuck,
    },
  };
}

/** An `EnableOutcome` → the SA-1 enable response (the route sets the status code). */
export function toEnableSyncRuleResponse(outcome: EnableOutcome): EnableSyncRuleResponse {
  if (outcome.kind === "blocked") {
    return { outcome: "blocked", stillNeeds: outcome.stillNeeds.map(toEnablementRequirementDto) };
  }
  return {
    outcome: "accepted",
    backfillRequired: outcome.backfillRequired,
    degradations: outcome.degradations.map(toEnablementDegradationDto),
  };
}

/**
 * An `AuditLogEntry` → the SA-2.3 sync-event wire shape. Ids/hashes/status/
 * `traceId`/`spanId`/`details` only — no payload value ever.
 */
export function toSyncEventDto(entry: AuditLogEntry): SyncEventDto {
  return {
    id: entry.id,
    type: entry.type,
    status: entry.status ?? null,
    actor: entry.actor,
    relatedRuleId: entry.relatedRuleId ?? null,
    relatedMappingId: entry.relatedMappingId ?? null,
    recordLinkId: entry.recordLinkId ?? null,
    sourceNativeId: entry.sourceNativeId ?? null,
    originAppId: entry.originAppId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
    payloadHash: entry.payloadHash ?? null,
    details: entry.details ?? null,
    traceId: entry.traceId ?? null,
    spanId: entry.spanId ?? null,
    timestamp: entry.timestamp.toISOString(),
  };
}

/** A `RecordLink` → the SA-3 wire shape — the two apps' native ids only. */
export function toRecordLinkDto(link: RecordLink): RecordLinkDto {
  return {
    id: link.id,
    appAId: link.appAId,
    appANativeId: link.appANativeId,
    appBId: link.appBId,
    appBNativeId: link.appBNativeId,
    resourcePairRef: link.resourcePairRef,
    establishedBy: link.establishedBy,
    status: link.status,
    createdAt: link.createdAt.toISOString(),
  };
}

/**
 * A `ParkedConflict` → the SA-4 wire shape. Ids / enums / field path / **content hashes**
 * / metadata only — never a raw contested value or credential material. `Date`s become
 * ISO strings; absent optionals become `null`.
 */
export function toParkedConflictDto(conflict: ParkedConflict): ParkedConflictDto {
  return {
    id: conflict.id,
    recordLinkId: conflict.recordLinkId,
    syncRuleId: conflict.syncRuleId,
    mappingId: conflict.mappingId,
    kind: conflict.kind,
    side: conflict.side,
    fieldPath: conflict.fieldPath ?? null,
    sourceObservedHash: conflict.sourceObservedHash ?? null,
    targetObservedHash: conflict.targetObservedHash ?? null,
    status: conflict.status,
    resolutionChoice: conflict.resolutionChoice ?? null,
    resolvedBy: conflict.resolvedBy ?? null,
    resolvedAt: conflict.resolvedAt != null ? conflict.resolvedAt.toISOString() : null,
    sourceNativeId: conflict.sourceNativeId ?? null,
    details: conflict.details ?? null,
    createdAt: conflict.createdAt.toISOString(),
    updatedAt: conflict.updatedAt.toISOString(),
  };
}

/**
 * A `ParkedWriteEntry` → the SA-5 dead-letter wire shape. Ids/refs / `changeKind` /
 * `lastError` / attempts / timestamps / `superseded` only — **never** a raw payload value
 * (the `observedRecord` is dropped at the repo projection) nor the opaque queue key (a
 * live identity-key value for a parked create) nor credential material. `Date`s become
 * ISO strings; absent optionals are already `null`.
 */
export function toDeadLetterWriteDto(entry: ParkedWriteEntry): DeadLetterWriteDto {
  return {
    id: entry.id,
    ruleId: entry.context.ruleId,
    mappingId: entry.context.mappingId,
    sourceAppId: entry.context.sourceAppId,
    targetAppId: entry.context.targetAppId,
    resourcePairRef: entry.context.resourcePairRef,
    sourceNativeId: entry.context.sourceNativeId,
    changeKind: entry.context.changeKind,
    lastError: entry.lastError,
    attempts: entry.attempts,
    superseded: entry.superseded,
    parkedAt: entry.parkedAt !== null ? entry.parkedAt.toISOString() : null,
    enqueuedAt: entry.enqueuedAt.toISOString(),
  };
}

/** An `AmbiguousMatchView` → the SA-3.3 queue wire shape. Ids only. */
export function toAmbiguousMatchDto(match: AmbiguousMatchView): AmbiguousMatchDto {
  return {
    syncEventId: match.syncEventId,
    ruleId: match.ruleId ?? null,
    sourceAppId: match.sourceAppId ?? null,
    sourceNativeId: match.sourceNativeId ?? null,
    candidateTargetNativeIds: [...match.candidateTargetNativeIds],
    observedAt: match.observedAt.toISOString(),
    details: match.details ?? null,
  };
}
