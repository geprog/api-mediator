import {
  auditLogStatusSchema,
  auditLogTypeSchema,
  backfillModeSchema,
  backfillStatusSchema,
  conflictPolicySchema,
  deletePropagationSchema,
  parkedConflictKindSchema,
  parkedConflictResolutionChoiceSchema,
  parkedConflictStatusSchema,
  pollScopeModeSchema,
  recordLinkEstablishedBySchema,
  recordLinkStatusSchema,
  scopeKeySchema,
  scopeLinkEstablishedBySchema,
  scopeLinkStatusSchema,
  syncFieldStateSideSchema,
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
  // SS-5.4 / SS-9.1b — an unconfirmed scope path-parameter binding (constant, or a
  // record-derived binding's target half) on the named side.
  z.object({
    kind: z.literal("scope-binding"),
    parameterName: z.string(),
    side: z.enum(["source", "target"]),
    resourceRef: z.string(),
  }),
  // SS-9.1a — the source `sourceScopeRef` a record-derived binding needs is unconfirmed,
  // absent, or missing the selected `sourceScopeKey` component (source half).
  z.object({
    kind: z.literal("source-scope-ref"),
    side: z.enum(["source", "target"]),
    resourceRef: z.string(),
    sourceScopeKey: z.string(),
  }),
  // SS-15.1/15.3 — the pair's `ScopeCorrespondence.scopeIdentityKey` is unconfirmed (or the
  // pair has no correspondence), so a `scope-link` rule cannot resolve any record's container.
  z.object({ kind: z.literal("scope-identity-key") }),
  // SS-15.1/15.3 — a `per-scope-pinned` rule's scopes are not covered: no active
  // constant/manual `ScopeLink` is pinned, and nothing lists them live.
  z.object({ kind: z.literal("scope-link") }),
  // SS-15.2/15.3 — a container list op is unconfirmed: the `source`/`target` container
  // resource's `collectionReadRef` (which SS-11 discovery / SS-17 enumeration consume).
  z.object({
    kind: z.literal("container-list-op"),
    side: z.enum(["source", "target"]),
  }),
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
  /**
   * SS-13.5 — the poll-enumeration mode, operator-visible: the persisted `override`
   * (`null` = "use the derived mode"), the `derived` mode, and the `effective` mode the
   * Poller acts on. `null` when the rule's artifacts do not resolve.
   */
  pollScopeMode: z
    .object({
      override: pollScopeModeSchema.nullable(),
      derived: pollScopeModeSchema,
      effective: pollScopeModeSchema,
    })
    .nullable(),
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
    // SS-13.5 — correct the derived poll-enumeration mode; `null` clears to the derived mode.
    pollScopeMode: pollScopeModeSchema.nullable().optional(),
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

// ── SS-11: scope-link (container) linking ─────────────────────────────────────

/**
 * `POST /api/scope-links` request (SS-11.6): manually link two containers — the
 * container analog of a manual record link. Addressed by the direction-agnostic
 * `resourcePairRef` plus each side's app + **addressing** scope key (the path-parameter
 * map that reaches that container: Gitea `{ owner, name }`, Vikunja `{ id }`). Scope
 * values are operator config, not secrets.
 */
export const createScopeLinkRequestSchema = z.object({
  resourcePairRef: z.string().min(1),
  sourceAppId: z.uuid(),
  sourceScopeKey: scopeKeySchema,
  targetAppId: z.uuid(),
  targetScopeKey: scopeKeySchema,
});
export type CreateScopeLinkRequest = z.infer<typeof createScopeLinkRequestSchema>;

/** A `ScopeLink` on the wire — the two apps' container ids + scope keys, **no credential material**. */
export const scopeLinkDtoSchema = z.object({
  id: z.string(),
  scopeCorrespondenceId: z.string(),
  appAId: z.string(),
  appAScopeKey: scopeKeySchema,
  appBId: z.string(),
  appBScopeKey: scopeKeySchema,
  resourcePairRef: z.string(),
  establishedBy: scopeLinkEstablishedBySchema,
  status: scopeLinkStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type ScopeLinkDto = z.infer<typeof scopeLinkDtoSchema>;

/** `POST /api/scope-links` response (SS-11.6) — the established manual container link. */
export const createScopeLinkResponseSchema = z.object({
  link: scopeLinkDtoSchema,
});
export type CreateScopeLinkResponse = z.infer<typeof createScopeLinkResponseSchema>;

/** `DELETE /api/scope-links/:id` response (SS-11.6) — the severed link's id. */
export const unlinkScopeLinkResponseSchema = z.object({
  id: z.string(),
  unlinked: z.literal(true),
});
export type UnlinkScopeLinkResponse = z.infer<typeof unlinkScopeLinkResponseSchema>;

/**
 * One parked container-link (SS-11.5): a record whose container could not be resolved to
 * a `ScopeLink` (ambiguous → candidate ids present; unresolvable → empty). The input to a
 * manual container-linking decision (SS-15). Ids + scope keys only, no payload values.
 */
export const parkedContainerLinkDtoSchema = z.object({
  syncEventId: z.string(),
  resourcePairRef: z.string(),
  sourceAppId: z.string(),
  sourceScopeKey: scopeKeySchema,
  candidateTargetNativeIds: z.array(z.string()),
  observedAt: isoDateTimeSchema,
});
export type ParkedContainerLinkDto = z.infer<typeof parkedContainerLinkDtoSchema>;

/** `GET /api/scope-links/parked` response (SS-11.5) — the parked container-linking queue. */
export const parkedContainerLinkListResponseSchema = z.object({
  parked: z.array(parkedContainerLinkDtoSchema),
});
export type ParkedContainerLinkListResponse = z.infer<typeof parkedContainerLinkListResponseSchema>;

// ── SA-4: the parked-conflict queue + resolution ─────────────────────────────

/**
 * One parked conflict on the wire (SA-4.1): the addressable identity + decision context
 * for a conflict the pipeline parked (a `manual-resolve`/`withheld` field, or a
 * drifted-delete). Ids / enums / field path / **content hashes** / metadata only —
 * **never** a raw contested value, a live payload value, or credential material
 * (`docs/architecture/security.md`). `Date`s become ISO strings; absent optionals `null`.
 */
export const parkedConflictDtoSchema = z.object({
  id: z.string(),
  recordLinkId: z.string(),
  syncRuleId: z.string(),
  mappingId: z.string(),
  kind: parkedConflictKindSchema,
  side: syncFieldStateSideSchema,
  /** The contested target field path (a field conflict); `null` for a drifted-delete. */
  fieldPath: z.string().nullable(),
  /** The two contested sides' `observedHash` at park time (hashes only, never a value). */
  sourceObservedHash: z.string().nullable(),
  targetObservedHash: z.string().nullable(),
  status: parkedConflictStatusSchema,
  resolutionChoice: parkedConflictResolutionChoiceSchema.nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  sourceNativeId: z.string().nullable(),
  details: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type ParkedConflictDto = z.infer<typeof parkedConflictDtoSchema>;

/** `GET /api/parked-conflicts` response (SA-4.1) — the open parked-conflict queue. */
export const parkedConflictListResponseSchema = z.object({
  conflicts: z.array(parkedConflictDtoSchema),
});
export type ParkedConflictListResponse = z.infer<typeof parkedConflictListResponseSchema>;

/**
 * `POST /api/parked-conflicts/:id/resolve` request (SA-4.2/4.3): the operator's chosen
 * resolution. `source-wins`/`target-wins` resolve a field conflict; `propagate`/`sever`
 * resolve a drifted-delete. The server validates the choice against the row's kind (a
 * mismatch is a 400).
 */
export const resolveParkedConflictRequestSchema = z.object({
  resolution: parkedConflictResolutionChoiceSchema,
});
export type ResolveParkedConflictRequest = z.infer<typeof resolveParkedConflictRequestSchema>;

/**
 * `POST /api/parked-conflicts/:id/resolve` response (SA-4.2/4.3). `enqueued` — the
 * resolution re-ran through the normal pipeline (the row is superseded once that re-run
 * completes, so `conflict` may still read `open`); `applied` — a `sever` tombstoned the
 * link directly (the returned `conflict` is `resolved`). No raw value / credential material.
 */
export const resolveParkedConflictResponseSchema = z.object({
  id: z.string(),
  outcome: z.enum(["enqueued", "applied"]),
  resolution: parkedConflictResolutionChoiceSchema,
  conflict: parkedConflictDtoSchema,
});
export type ResolveParkedConflictResponse = z.infer<typeof resolveParkedConflictResponseSchema>;

// ── SA-5: the dead-letter queue + replay a parked write ──────────────────────

/**
 * One parked (dead-letter) write on the wire (SA-5.1): a write that exhausted its retry
 * ceiling (OC-4), addressable for replay by its `id`. It carries **ids/refs only** — the
 * record/rule/mapping context projected from the parked `DetectedChange` payload, the
 * `changeKind`, the non-secret `lastError` reason, the attempt count, timestamps, and the
 * `superseded` flag (SA-5.3). It deliberately carries **no** live field value (never the
 * payload's `observedRecord`, and never the opaque queue key — which is a live identity-key
 * value for a parked create) and **no** credential material (`docs/architecture/security.md`).
 */
export const deadLetterWriteDtoSchema = z.object({
  id: z.string(),
  ruleId: z.string().nullable(),
  mappingId: z.string().nullable(),
  sourceAppId: z.string().nullable(),
  targetAppId: z.string().nullable(),
  resourcePairRef: z.string().nullable(),
  sourceNativeId: z.string().nullable(),
  /** `create`/`update`/`delete` — the classified action, metadata only (never a value). */
  changeKind: z.string().nullable(),
  /** The non-secret failure reason recorded at park time (never a payload value). */
  lastError: z.string().nullable(),
  attempts: z.number().int(),
  /** SA-5.3: a later same-key change already synced this record — replay is a no-op. */
  superseded: z.boolean(),
  parkedAt: isoDateTimeSchema.nullable(),
  enqueuedAt: isoDateTimeSchema,
});
export type DeadLetterWriteDto = z.infer<typeof deadLetterWriteDtoSchema>;

/** `GET /api/dead-letter-writes` response (SA-5.1) — the parked-write queue. */
export const deadLetterQueueResponseSchema = z.object({
  writes: z.array(deadLetterWriteDtoSchema),
});
export type DeadLetterQueueResponse = z.infer<typeof deadLetterQueueResponseSchema>;

/**
 * `POST /api/dead-letter-writes/:id/replay` response (SA-5.2) — `reactivated` (2xx): the
 * parked entry was flipped back to `pending`, so the dispatcher re-claims it and re-runs
 * the **standard pipeline** against current state (loop prevention + conflict detection),
 * never a blind re-issue of the stale payload. The blocked/superseded/not-parked/not-found
 * cases are reported as 4xx via the error envelope, so this success body has a single shape.
 */
export const replayParkedWriteResponseSchema = z.object({
  id: z.string(),
  outcome: z.literal("reactivated"),
});
export type ReplayParkedWriteResponse = z.infer<typeof replayParkedWriteResponseSchema>;

// ── Deterministic poll trigger (SP-5 hook — TEST/DEV-ONLY) ────────────────────

/**
 * The outcome of one deterministic poll cycle (SP-5), mirroring the sync-engine
 * `PollRunOutcome` union at the wire boundary:
 *  - **`completed`** — the run detected + durably enqueued changes and advanced the
 *    cursor/snapshot/`lastRunAt`. It carries the `mode` (delta/full-fetch) and
 *    `enqueuedCount` (0 on a no-change poll) — a **count only**, never the enqueued
 *    payloads/queue keys, which can hold live identity-key values
 *    (`docs/architecture/security.md`).
 *  - **`aborted`** — a page/delta read failed (SP-4): no enqueue, no advance. `reason`
 *    is the non-secret failure summary (same class as an audit-log `lastError`).
 *  - **`skipped`** — the rule is not pollable right now (an unconfirmed ref backstop);
 *    `reason` is the machine-readable not-pollable reason.
 *  - **`completed-per-scope`** (SS-13.3) — a per-scope run: `scopes` carries each scope's
 *    own completed/aborted result plus each unresolvable scope's `parked` result (a
 *    **count only** for completed scopes — never the enqueued payloads/queue keys). One
 *    scope aborting/parking never aborts the whole run (per-scope isolation).
 *
 * This carries **no** live field value and **no** credential material.
 */
export const perScopeRunResultDtoSchema = z.object({
  scopeLinkId: z.string(),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("completed"),
      mode: z.enum(["delta", "full-fetch"]),
      enqueuedCount: z.number().int().nonnegative(),
    }),
    z.object({ kind: z.literal("aborted"), reason: z.string() }),
    z.object({ kind: z.literal("parked"), reason: z.string() }),
  ]),
});
export type PerScopeRunResultDto = z.infer<typeof perScopeRunResultDtoSchema>;

export const pollRunOutcomeDtoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    mode: z.enum(["delta", "full-fetch"]),
    enqueuedCount: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal("aborted"), reason: z.string() }),
  z.object({ kind: z.literal("skipped"), reason: z.string() }),
  z.object({
    kind: z.literal("completed-per-scope"),
    scopes: z.array(perScopeRunResultDtoSchema),
  }),
]);
export type PollRunOutcomeDto = z.infer<typeof pollRunOutcomeDtoSchema>;

/**
 * `POST /api/sync-rules/:id/poll` response (SP-5 poll-trigger hook — registered ONLY
 * when the test-only `sync.testPollTrigger` flag is set). A `completed`/`aborted`
 * outcome is 200; a `skipped` (ineligible) outcome is 4xx with this body; a missing
 * rule is a 404 via the error envelope.
 */
export const triggerPollResponseSchema = z.object({
  ruleId: z.string(),
  outcome: pollRunOutcomeDtoSchema,
});
export type TriggerPollResponse = z.infer<typeof triggerPollResponseSchema>;
