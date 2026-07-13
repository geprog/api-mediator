import {
  auditLogStatusSchema,
  auditLogTypeSchema,
  backfillModeSchema,
  backfillStatusSchema,
  conflictPolicySchema,
  deletePropagationSchema,
  recordLinkEstablishedBySchema,
  recordLinkStatusSchema,
  syncRuleStatusSchema,
  targetDriftCheckSchema,
} from "@mediator/domain";
import { z } from "zod";

import { isoDateTimeSchema } from "./common.js";

/**
 * DTOs for the Phase-4 Sync HTTP API (SA-1..SA-3): the operator-API endpoints
 * that configure/enable/disable a `SyncRule`, read sync state (rules, poller lag,
 * the sync audit log), and manually link/unlink records.
 *
 * The domain enum sub-shapes (`SyncRule` statuses, `AuditLog` type/status,
 * `RecordLink.establishedBy`, …) are reused **verbatim** from `@mediator/domain` —
 * they carry no `Date` and no credential material. The only boundary transforms
 * are `Date` → ISO string.
 *
 * **Two invariants govern every response here** (`docs/architecture/security.md`):
 * no response carries **credential material**, and no response carries a **live
 * payload value** — the sync audit log surfaces status/metadata/ids/hashes and
 * `traceId`/`spanId`, never the field data being synced.
 */

// ── Enablement gate: "still needs" + degradations (SA-2 / SA-1) ───────────────

/**
 * The `SyncRule` enablement-gate "still needs" list — the machine-consumable set
 * of refs/decisions a not-yet-enable-able rule is missing (BE-1.5 / BE-2.5). A
 * discriminated union, **never a bare string**, so the UI (SU-1) can render each
 * item and route it to the action that clears it. Mirrors the sync-engine
 * `EnablementRequirement` union field-for-field; the backend maps its engine
 * value through this schema (which also drift-checks the two shapes).
 */
export const enablementRequirementDtoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("identity-key"),
    issue: z.enum(["missing", "ambiguous"]),
    confirmedCount: z.number().int(),
  }),
  z.object({ kind: z.literal("poll-operation-ref") }),
  z.object({ kind: z.literal("propagatable-operation") }),
  z.object({
    kind: z.literal("target-operation"),
    action: z.enum(["update", "delete"]),
    issue: z.enum(["missing", "missing-target-id-param"]),
  }),
  z.object({
    kind: z.literal("binding-ref"),
    ref: z.enum([
      "nativeIdRef",
      "collectionReadRef",
      "paginationRef",
      "deltaCursorRef",
      "deltaDeletionRef",
    ]),
    side: z.enum(["source", "target"]),
    usedFor: z.enum([
      "native-id",
      "polling-enumeration",
      "backfill-enumeration",
      "pagination",
      "delta-cursor",
      "delta-deletion",
    ]),
  }),
  z.object({ kind: z.literal("identity-lookup-path") }),
]);
export type EnablementRequirementDto = z.infer<typeof enablementRequirementDtoSchema>;

/**
 * A non-blocking enablement degradation the UI (SU-1) states *before* the rule
 * turns on (carried on an accepted enable). Mirrors the sync-engine
 * `EnablementDegradation` union.
 */
export const enablementDegradationDtoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("match-first-unavailable") }),
  z.object({ kind: z.literal("lww-observation-order"), side: z.enum(["source", "target"]) }),
]);
export type EnablementDegradationDto = z.infer<typeof enablementDegradationDtoSchema>;

// ── SA-2: rule state, poller lag ─────────────────────────────────────────────

/**
 * One resolved side of a rule's mapped resource pair — app id/name + the resource
 * ref. App **ids and names** are metadata (never credential material); no base URL
 * or auth material is exposed.
 */
export const syncRuleResourceSideDtoSchema = z.object({
  appId: z.string(),
  appName: z.string(),
  resourceRef: z.string(),
});
export type SyncRuleResourceSideDto = z.infer<typeof syncRuleResourceSideDtoSchema>;

/** The resolved source→target resource pair of a rule (null when the rule's artifacts do not resolve). */
export const syncRuleResourcePairDtoSchema = z.object({
  source: syncRuleResourceSideDtoSchema,
  target: syncRuleResourceSideDtoSchema,
});
export type SyncRuleResourcePairDto = z.infer<typeof syncRuleResourcePairDtoSchema>;

/**
 * Poller lag for a rule (SA-2.2): time since `lastRunAt` vs. the expected poll
 * interval, so a stuck poller is visible in the UI as well as in Grafana. `stuck`
 * is `lagMs > staleMultiplier × expectedIntervalMs` on an `enabled` rule (the
 * observability "no successful poll past N× its expected interval" signal).
 */
export const pollerLagDtoSchema = z.object({
  lastRunAt: isoDateTimeSchema.nullable(),
  expectedIntervalMs: z.number().nullable(),
  lagMs: z.number().nullable(),
  stuck: z.boolean(),
});
export type PollerLagDto = z.infer<typeof pollerLagDtoSchema>;

/**
 * A `SyncRule` on the wire (SA-2.1): its status/backfill/poll fields, its resolved
 * resource pair, the gate's `stillNeeds` list (empty on an enable-able rule), and
 * its poller lag. **No credential material.**
 */
export const syncRuleStatusDtoSchema = z.object({
  id: z.string(),
  approvedMappingId: z.string(),
  status: syncRuleStatusSchema,
  backfillStatus: backfillStatusSchema.nullable(),
  backfillMode: backfillModeSchema.nullable(),
  deletePropagation: deletePropagationSchema.nullable(),
  targetDriftCheck: targetDriftCheckSchema.nullable(),
  pollIntervalOverride: z.number().nullable(),
  pollOperationRef: z.string().nullable(),
  lastRunAt: isoDateTimeSchema.nullable(),
  lastEventAt: isoDateTimeSchema.nullable(),
  /** The canonical, direction-agnostic resource-pair ref (always present). */
  resourcePairRef: z.string(),
  /** The resolved source/target apps + resource (null when artifacts do not resolve). */
  resourcePair: syncRuleResourcePairDtoSchema.nullable(),
  stillNeeds: z.array(enablementRequirementDtoSchema),
  pollerLag: pollerLagDtoSchema,
});
export type SyncRuleStatusDto = z.infer<typeof syncRuleStatusDtoSchema>;

/** `GET /api/sync-rules` response (SA-2.1) — every rule with its status + gate + lag. */
export const syncRuleListResponseSchema = z.object({
  rules: z.array(syncRuleStatusDtoSchema),
});
export type SyncRuleListResponse = z.infer<typeof syncRuleListResponseSchema>;

// ── SA-1: configure a disabled rule's execution options ──────────────────────

/** One `FieldMapping`'s conflict-policy override (`null` clears back to the auto default). */
export const fieldConflictPolicyDtoSchema = z.object({
  fieldMappingId: z.uuid(),
  conflictPolicy: conflictPolicySchema.nullable(),
});
export type FieldConflictPolicyDto = z.infer<typeof fieldConflictPolicyDtoSchema>;

/**
 * `PATCH /api/sync-rules/:id/config` request (SA-1.1): set a **disabled** rule's
 * execution options — the same derive-then-correct pattern as `ResourceBinding`
 * refs. Every key is optional; only the keys present are persisted.
 * `pollIntervalOverride: null` clears the override (back to the app default).
 */
export const configureSyncRuleRequestSchema = z
  .object({
    pollIntervalOverride: z.number().int().positive().nullable().optional(),
    pollOperationRef: z.string().min(1).optional(),
    deletePropagation: deletePropagationSchema.optional(),
    targetDriftCheck: targetDriftCheckSchema.optional(),
    fieldConflictPolicies: z.array(fieldConflictPolicyDtoSchema).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "at least one option must be provided",
  });
export type ConfigureSyncRuleRequest = z.infer<typeof configureSyncRuleRequestSchema>;

/** `PATCH /api/sync-rules/:id/config` response — the updated rule state. */
export const configureSyncRuleResponseSchema = syncRuleStatusDtoSchema;
export type ConfigureSyncRuleResponse = z.infer<typeof configureSyncRuleResponseSchema>;

// ── SA-1: enable / disable ───────────────────────────────────────────────────

/**
 * `POST /api/sync-rules/:id/enable` request (SA-1.2): enable with a chosen
 * `backfillMode` (`link-only`/`push`), or an **explicit** skip (never a default).
 */
export const enableSyncRuleRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("backfill"), backfillMode: backfillModeSchema }),
  z.object({ action: z.literal("skip-backfill") }),
]);
export type EnableSyncRuleRequest = z.infer<typeof enableSyncRuleRequestSchema>;

/**
 * `POST /api/sync-rules/:id/enable` response (SA-1.2/1.3). `accepted` (2xx — the
 * gate passed; backfill proceeds in the background) carries whether a backfill
 * runs + the non-blocking degradations; `blocked` (4xx) carries the exact
 * `stillNeeds` list and enables nothing.
 */
export const enableSyncRuleResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    backfillRequired: z.boolean(),
    degradations: z.array(enablementDegradationDtoSchema),
  }),
  z.object({
    outcome: z.literal("blocked"),
    stillNeeds: z.array(enablementRequirementDtoSchema),
  }),
]);
export type EnableSyncRuleResponse = z.infer<typeof enableSyncRuleResponseSchema>;

/** `POST /api/sync-rules/:id/disable` response (SA-1.4) — the retained rule state. */
export const disableSyncRuleResponseSchema = syncRuleStatusDtoSchema;
export type DisableSyncRuleResponse = z.infer<typeof disableSyncRuleResponseSchema>;

// ── SA-2: sync audit log query ───────────────────────────────────────────────

/**
 * `GET /api/sync-events` query (SA-2.3): the sync audit log filtered by
 * rule/record/status. `limit` bounds the scan (never unbounded history).
 */
export const syncEventQuerySchema = z.object({
  ruleId: z.uuid().optional(),
  recordLinkId: z.uuid().optional(),
  sourceNativeId: z.string().min(1).optional(),
  status: auditLogStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});
export type SyncEventQuery = z.infer<typeof syncEventQuerySchema>;

/**
 * One sync audit-log row on the wire (SA-2.3). Ids/hashes/status/`traceId`/
 * `spanId`/short metadata `details` only — **never a payload value, never
 * credential material** (`docs/architecture/security.md` *Audit logging*).
 */
export const syncEventDtoSchema = z.object({
  id: z.string(),
  type: auditLogTypeSchema,
  status: auditLogStatusSchema.nullable(),
  actor: z.string(),
  relatedRuleId: z.string().nullable(),
  relatedMappingId: z.string().nullable(),
  recordLinkId: z.string().nullable(),
  sourceNativeId: z.string().nullable(),
  originAppId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  payloadHash: z.string().nullable(),
  details: z.string().nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  timestamp: isoDateTimeSchema,
});
export type SyncEventDto = z.infer<typeof syncEventDtoSchema>;

/** `GET /api/sync-events` response (SA-2.3). */
export const syncEventListResponseSchema = z.object({
  events: z.array(syncEventDtoSchema),
});
export type SyncEventListResponse = z.infer<typeof syncEventListResponseSchema>;

// ── SA-3: manual link / unlink + the ambiguous-match queue ───────────────────

/**
 * `POST /api/record-links` request (SA-3.1): manually link a rule's source record
 * to a chosen target record — the resolution for an ambiguous or key-less pairing
 * the engine refused to guess (RL-4). Addressed by `ruleId` (which fixes the
 * resource pair + both apps) plus the two records' native ids.
 */
export const createRecordLinkRequestSchema = z.object({
  ruleId: z.uuid(),
  sourceNativeId: z.string().min(1),
  targetNativeId: z.string().min(1),
});
export type CreateRecordLinkRequest = z.infer<typeof createRecordLinkRequestSchema>;

/** A `RecordLink` on the wire — the two apps' native ids only, **no credential material**. */
export const recordLinkDtoSchema = z.object({
  id: z.string(),
  appAId: z.string(),
  appANativeId: z.string(),
  appBId: z.string(),
  appBNativeId: z.string(),
  resourcePairRef: z.string(),
  establishedBy: recordLinkEstablishedBySchema,
  status: recordLinkStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type RecordLinkDto = z.infer<typeof recordLinkDtoSchema>;

/** `POST /api/record-links` response (SA-3.1) — the established manual link. */
export const createRecordLinkResponseSchema = z.object({
  link: recordLinkDtoSchema,
});
export type CreateRecordLinkResponse = z.infer<typeof createRecordLinkResponseSchema>;

/** `DELETE /api/record-links/:id` response (SA-3.2) — the severed link's id. */
export const unlinkRecordResponseSchema = z.object({
  id: z.string(),
  unlinked: z.literal(true),
});
export type UnlinkRecordResponse = z.infer<typeof unlinkRecordResponseSchema>;

/**
 * One entry of the ambiguous-match queue (SA-3.3): an unresolved record whose
 * identity lookup matched **more than one** target (RL-4), with the candidate
 * target native ids the engine recorded in the `failure` event's `details` — the
 * input to a manual-linking decision. Ids only, no payload values.
 */
export const ambiguousMatchDtoSchema = z.object({
  syncEventId: z.string(),
  ruleId: z.string().nullable(),
  sourceAppId: z.string().nullable(),
  sourceNativeId: z.string().nullable(),
  candidateTargetNativeIds: z.array(z.string()),
  observedAt: isoDateTimeSchema,
  details: z.string().nullable(),
});
export type AmbiguousMatchDto = z.infer<typeof ambiguousMatchDtoSchema>;

/** `GET /api/record-links/ambiguous-matches` response (SA-3.3). */
export const ambiguousMatchListResponseSchema = z.object({
  matches: z.array(ambiguousMatchDtoSchema),
});
export type AmbiguousMatchListResponse = z.infer<typeof ambiguousMatchListResponseSchema>;
