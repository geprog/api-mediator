import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type {
  AcknowledgedIgnoredInput,
  AdapterBindingRole,
  AdapterBindingStatus,
  AdapterEndpointStatus,
  AdapterRequestCause,
  AdapterWriteOutcomeStatus,
  AdapterWriteResult,
  AggregationStrategy,
  ApiSpecRole,
  ApiSpecStatus,
  AppCapabilities,
  ApprovedMappingStatus,
  AuditLogStatus,
  AuditLogType,
  BackfillMode,
  BackfillStatus,
  ChainInput,
  ConfirmableRef,
  ConflictPolicy,
  CredentialType,
  DeletePropagation,
  EndpointStrictness,
  GeneratedBy,
  GraphEdgeMetadata,
  GraphEdgeType,
  Ir,
  IrRefTarget,
  MappingDecision,
  MappingPhase,
  MappingProposalItemKind,
  MappingProposalStatus,
  MappingVariant,
  OperationAction,
  OutboundLoadLimits,
  ParkedConflictKind,
  PostMergeDedup,
  PostMergeFilter,
  PostMergePagination,
  PostMergeSort,
  ParkedConflictResolutionChoice,
  ParkedConflictStatus,
  PollScopeMode,
  ProposalElementRef,
  ProposalItemAlternative,
  RecordLinkEstablishedBy,
  RecordLinkEstablishingQueueKey,
  RecordLinkScopeRef,
  RecordLinkStatus,
  RegisteredAppStatus,
  ResourceBinding,
  ScopeContainerRef,
  ScopeIdentityKey,
  ScopeKey,
  ScopeLinkEstablishedBy,
  ScopeLinkStatus,
  ScopePathBinding,
  SourceScopeRef,
  ReviewState,
  ShortlistResult,
  SyncFieldStateSide,
  SyncFieldStateStatus,
  SyncRuleStatus,
  TargetDriftCheck,
  TombstoneReason,
  TransformConfig,
  TransformKind,
  TransformSuggestion,
} from "@mediator/domain";

/**
 * Phase-1 Drizzle schema — the four registration/ingestion entities of
 * `docs/architecture/data-model.md` plus the normalized `resource_binding_ref`
 * child table. Columns are `snake_case`; the domain field names live in the
 * mappers (`src/mappers/`), which are the only place Drizzle's inferred row/
 * insert optionality touches `@mediator/domain` types.
 *
 * Enum value sets are pinned to their `@mediator/domain` unions with
 * `satisfies` (catches a renamed/mistyped literal at compile time); the
 * `schema.spec.ts` parity test additionally asserts each pg enum lists exactly
 * the domain schema's options (catches a *missing* value).
 */

// ── Enums (pinned to @mediator/domain unions) ────────────────────────────────

export const registeredAppStatusEnum = pgEnum("registered_app_status", [
  "active",
  "disabled",
] as const satisfies readonly RegisteredAppStatus[]);

export const apiSpecRoleEnum = pgEnum("api_spec_role", [
  "PROVIDER",
  "CONSUMER",
] as const satisfies readonly ApiSpecRole[]);

export const apiSpecStatusEnum = pgEnum("api_spec_status", [
  "active",
  "superseded",
  "archived",
] as const satisfies readonly ApiSpecStatus[]);

export const credentialTypeEnum = pgEnum("credential_type", [
  "apiKey",
  "oauth2",
  "basicAuth",
  "adapterToken",
  "custom",
] as const satisfies readonly CredentialType[]);

/**
 * The confirmable-ref keys of a domain `ResourceBinding` (the six optional
 * refs, not the `id`/`apiSpecId`/`resourceRef` scalars). Used to pin the
 * `resource_binding_ref.ref_kind` enum to those exact keys so a domain rename
 * breaks the build here.
 */
type ResourceBindingRefKey = keyof {
  [
    K in keyof ResourceBinding as ResourceBinding[K] extends ConfirmableRef | undefined ? K : never
  ]: true;
};

/** The seven `ResourceBinding` ref kinds, in a stable order (glossary-exact). */
export const RESOURCE_BINDING_REF_KINDS = [
  "nativeIdRef",
  "collectionReadRef",
  "paginationRef",
  "deltaCursorRef",
  "deltaDeletionRef",
  "changeTimestampRef",
  // SS-19 appended LAST on purpose: this tuple is the `pgEnum` member order, so a new
  // kind at the end makes its migration a pure `ALTER TYPE ... ADD VALUE` with no
  // reordering. The list is consumed order-independently (mapper + repository iterate
  // it); the operator-facing display order lives in `@mediator/contracts`.
  "recordAddressRef",
] as const satisfies readonly ResourceBindingRefKey[];

/** One of the seven confirmable `ResourceBinding` ref kinds. */
export type ResourceBindingRefKind = (typeof RESOURCE_BINDING_REF_KINDS)[number];

export const resourceBindingRefKindEnum = pgEnum(
  "resource_binding_ref_kind",
  RESOURCE_BINDING_REF_KINDS,
);

/**
 * The `jsonb`-persisted form of a `ScopePathBinding` (`scope_path_bindings`
 * column). `jsonb` has no `Date`, so a `constant`'s `confirmedAt` is stored as an
 * ISO-8601 **string** (or `null`); the resource-binding mapper converts it back
 * to a `Date` on read. Distributive so each kind's own keys are preserved as the
 * union grows (Layers 2/3); pinned to the domain `ScopePathBinding` so a domain
 * rename breaks the build here.
 */
export type ScopePathBindingRow = ScopePathBinding extends infer Binding
  ? Binding extends unknown
    ? { [K in keyof Binding]: [Binding[K]] extends [Date | null] ? string | null : Binding[K] }
    : never
  : never;

/**
 * The `jsonb`-persisted form of a `SourceScopeRef` (`source_scope_ref` column,
 * SS-7). Like {@link ScopePathBindingRow}, the only field `jsonb` cannot hold is
 * the `Date` `confirmedAt`, stored as an ISO-8601 **string** (or `null`) and
 * converted back to a `Date` by the resource-binding mapper; `components`
 * (`{ key, fieldPath }[]`) and `confirmedBy` are JSON-safe. Pinned to the domain
 * `SourceScopeRef` so a domain rename breaks the build here. The whole column is
 * **nullable**: a NULL column is the domain **absent** `sourceScopeRef` key.
 */
export type SourceScopeRefRow = {
  [K in keyof SourceScopeRef]: [SourceScopeRef[K]] extends [Date | null]
    ? string | null
    : SourceScopeRef[K];
};

/**
 * The `jsonb`-persisted form of an `AdapterEndpoint.postMergePagination` (AD-1).
 * Like {@link SourceScopeRefRow}, the only field `jsonb` cannot hold is the
 * `Date` `confirmedAt`, stored as an ISO-8601 **string** (or `null`) and
 * converted back to a `Date` by the adapter-endpoint mapper. `convention`
 * (the discriminated pagination union) and `confirmedBy` are JSON-safe. Pinned to
 * the domain `PostMergePagination` so a domain rename breaks the build here. The
 * column is **nullable**: a NULL is the domain **absent** key.
 */
export type PostMergePaginationRow = {
  [K in keyof PostMergePagination]: [PostMergePagination[K]] extends [Date | null]
    ? string | null
    : PostMergePagination[K];
};

// ── Phase-2 mapping enums (pinned to @mediator/domain unions) ─────────────────

export const mappingProposalStatusEnum = pgEnum("mapping_proposal_status", [
  "pending",
  "partially_approved",
  "approved",
  "rejected",
  "failed",
] as const satisfies readonly MappingProposalStatus[]);

export const mappingProposalItemKindEnum = pgEnum("mapping_proposal_item_kind", [
  "operation",
  "field",
  "parameter",
] as const satisfies readonly MappingProposalItemKind[]);

export const reviewStateEnum = pgEnum("review_state", [
  "pending",
  "accepted",
  "edited",
  "rejected",
] as const satisfies readonly ReviewState[]);

export const mappingPhaseEnum = pgEnum("mapping_phase", [
  "request",
  "response",
] as const satisfies readonly MappingPhase[]);

// ── Phase-3 approved-mapping enums (pinned to @mediator/domain unions) ─────────

export const mappingVariantEnum = pgEnum("mapping_variant", [
  "peer-peer",
  "consumer-provider",
] as const satisfies readonly MappingVariant[]);

export const transformKindEnum = pgEnum("transform_kind", [
  "rename",
  "coerce",
  "aggregate",
  "expression",
] as const satisfies readonly TransformKind[]);

export const conflictPolicyEnum = pgEnum("conflict_policy", [
  "manual-resolve",
] as const satisfies readonly ConflictPolicy[]);

export const operationActionEnum = pgEnum("operation_action", [
  "create",
  "read",
  "update",
  "delete",
] as const satisfies readonly OperationAction[]);

export const approvedMappingStatusEnum = pgEnum("approved_mapping_status", [
  "active",
  "suspended",
  "stale",
  "superseded",
  "archived",
] as const satisfies readonly ApprovedMappingStatus[]);

// ── Phase-3 downstream-artifact enums (pinned to @mediator/domain unions) ──────

export const syncRuleStatusEnum = pgEnum("sync_rule_status", [
  "enabled",
  "disabled",
] as const satisfies readonly SyncRuleStatus[]);

export const adapterEndpointStatusEnum = pgEnum("adapter_endpoint_status", [
  "active",
  "composition-required",
  "disabled",
] as const satisfies readonly AdapterEndpointStatus[]);

export const adapterBindingRoleEnum = pgEnum("adapter_binding_role", [
  "primary",
  "fallback",
  "supplement",
] as const satisfies readonly AdapterBindingRole[]);

export const adapterBindingStatusEnum = pgEnum("adapter_binding_status", [
  "active",
  "proposed",
  "disabled",
] as const satisfies readonly AdapterBindingStatus[]);

/**
 * `AdapterEndpoint.aggregationStrategy` (Phase-5 AD-1). Pinned to the
 * `@mediator/domain` `AggregationStrategy` union; the column is nullable (a
 * not-yet-composed endpoint has none).
 */
export const aggregationStrategyEnum = pgEnum("aggregation_strategy", [
  "single",
  "fanout-merge",
  "collection-union",
  "fanout-first-success",
] as const satisfies readonly AggregationStrategy[]);

/**
 * `AdapterEndpoint.strictness` (AD-1) — the partial-failure mode. Nullable: a
 * not-yet-composed endpoint has none, and it is set at composition (never a DB
 * default, per AD-6.2).
 */
export const endpointStrictnessEnum = pgEnum("endpoint_strictness", [
  "strict",
  "degraded",
] as const satisfies readonly EndpointStrictness[]);

/**
 * `AdapterWriteOutcome.result.outcome` (AD-4) — whether the recorded original
 * execution succeeded or failed, the top-level discriminant of the write-outcome
 * store row.
 */
export const adapterWriteOutcomeStatusEnum = pgEnum("adapter_write_outcome_status", [
  "success",
  "failure",
] as const satisfies readonly AdapterWriteOutcomeStatus[]);

/**
 * `audit_log.cause` on an `adapter-request` row (AD-5) — which of the six named
 * causes (or a generic `upstream-error`) an adapter request failed with. A
 * SEPARATE column from `audit_log.status`, which reuses the Phase-4 enum
 * unchanged (AD-5.5). Nullable: NULL on a clean success and on every non-adapter
 * row.
 */
export const adapterRequestCauseEnum = pgEnum("adapter_request_cause", [
  "not-yet-mapped",
  "endpoint-disabled",
  "mapping-stale",
  "mapping-suspended",
  "backend-disabled",
  "mediator-transform-error",
  "upstream-error",
] as const satisfies readonly AdapterRequestCause[]);

export const graphEdgeTypeEnum = pgEnum("graph_edge_type", [
  "sync",
  "adapter-dependency",
] as const satisfies readonly GraphEdgeType[]);

export const auditLogTypeEnum = pgEnum("audit_log_type", [
  "poll-run",
  "backfill-run",
  "sync-execution",
  "adapter-request",
  "mapping-decision",
  "credential-access",
] as const satisfies readonly AuditLogType[]);

export const mappingDecisionEnum = pgEnum("mapping_decision", [
  "accept",
  "edit",
  "reject",
  "approve",
] as const satisfies readonly MappingDecision[]);

/**
 * The `status` of a `sync-execution` (or `adapter-request`) `audit_log` row — the
 * SD-4 per-record execution outcome vocabulary (`docs/architecture/data-model.md`
 * `SyncEvent / AuditLog` `status`; requirement SD-4 / OC-5). Pinned to the
 * `@mediator/domain` `AuditLogStatus` union; the `schema.spec.ts` parity test
 * asserts the pg enum lists exactly the domain schema's options. NULL on a
 * `mapping-decision` / `credential-access` / `poll-run` row (the column is
 * nullable — a decision has no execution outcome).
 */
export const auditLogStatusEnum = pgEnum("audit_log_status", [
  "success",
  "failure",
  "skipped-loop",
  "skipped-policy",
  "conflict",
] as const satisfies readonly AuditLogStatus[]);

/**
 * The lifecycle of a `mapping_detection_job` (below). This is an **infrastructure**
 * enum — a durability/scheduling concern, not a glossary entity — so it is defined
 * here rather than pinned to a `@mediator/domain` union: `pending` (enqueued, not
 * yet claimed), `running` (claimed by the worker, in flight), `completed` (the
 * engine finished a detection run for the spec), `failed` (parked after exhausting
 * the worker's attempt ceiling).
 */
export const DETECTION_JOB_STATUSES = ["pending", "running", "completed", "failed"] as const;
/** One `mapping_detection_job` lifecycle state. */
export type DetectionJobStatus = (typeof DETECTION_JOB_STATUSES)[number];
export const detectionJobStatusEnum = pgEnum("detection_job_status", DETECTION_JOB_STATUSES);

/**
 * The lifecycle of an `ordering_queue` entry (below). Like `detection_job_status`
 * this is an **infrastructure** enum — the Sync Engine's per-key ordering substrate
 * (`docs/architecture/sync-engine.md` *Ordering and consistency*), not a glossary
 * entity — so it is defined here rather than pinned to a `@mediator/domain` union:
 * `pending` (enqueued, awaiting a worker), `processing` (claimed under a live lease
 * by one worker — the `SKIP LOCKED` discipline guarantees at most one per
 * `queue_key`), `done` (the injected pipeline handler completed), `parked`
 * (dead-lettered at the retry ceiling — the OC-4 concept: it releases its key's
 * worker and blocks neither that key nor others, OQ-1 criterion 5).
 */
export const ORDERING_QUEUE_STATUSES = ["pending", "processing", "done", "parked"] as const;
/** One `ordering_queue` entry lifecycle state. */
export type OrderingQueueStatus = (typeof ORDERING_QUEUE_STATUSES)[number];
export const orderingQueueStatusEnum = pgEnum("ordering_queue_status", ORDERING_QUEUE_STATUSES);

// ── Phase-4 identity-resolution / RecordLink enums (pinned to @mediator/domain) ──

export const recordLinkEstablishedByEnum = pgEnum("record_link_established_by", [
  "create-propagation",
  "identity-match",
  "manual",
] as const satisfies readonly RecordLinkEstablishedBy[]);

export const recordLinkStatusEnum = pgEnum("record_link_status", [
  "active",
  "tombstoned",
  "archived",
] as const satisfies readonly RecordLinkStatus[]);

export const recordLinkTombstoneReasonEnum = pgEnum("record_link_tombstone_reason", [
  "propagated-delete",
  "observed-delete",
] as const satisfies readonly TombstoneReason[]);

// ── Phase-4 scoped-resource-sync L3 / ScopeLink enums (SS-10) ─────────────────

export const scopeLinkEstablishedByEnum = pgEnum("scope_link_established_by", [
  "constant",
  "identity-match",
  "manual",
] as const satisfies readonly ScopeLinkEstablishedBy[]);

export const scopeLinkStatusEnum = pgEnum("scope_link_status", [
  "active",
  "archived",
] as const satisfies readonly ScopeLinkStatus[]);

export const syncFieldStateSideEnum = pgEnum("sync_field_state_side", [
  "A",
  "B",
] as const satisfies readonly SyncFieldStateSide[]);

export const syncFieldStateStatusEnum = pgEnum("sync_field_state_status", [
  "active",
  "archived",
] as const satisfies readonly SyncFieldStateStatus[]);

// ── Phase-4 parked-conflict enums (SA-4, pinned to @mediator/domain unions) ─────

export const parkedConflictKindEnum = pgEnum("parked_conflict_kind", [
  "manual-resolve",
  "withheld",
  "drifted-delete",
] as const satisfies readonly ParkedConflictKind[]);

export const parkedConflictStatusEnum = pgEnum("parked_conflict_status", [
  "open",
  "resolved",
] as const satisfies readonly ParkedConflictStatus[]);

export const parkedConflictResolutionChoiceEnum = pgEnum("parked_conflict_resolution_choice", [
  "source-wins",
  "target-wins",
  "propagate",
  "sever",
] as const satisfies readonly ParkedConflictResolutionChoice[]);

// ── Phase-4 SyncRule execution/policy enums (SD-1, pinned to @mediator/domain) ──

export const deletePropagationEnum = pgEnum("delete_propagation", [
  "ignore",
  "propagate",
] as const satisfies readonly DeletePropagation[]);

export const targetDriftCheckEnum = pgEnum("target_drift_check", [
  "none",
  "read-before-write",
] as const satisfies readonly TargetDriftCheck[]);

export const backfillModeEnum = pgEnum("backfill_mode", [
  "link-only",
  "push",
] as const satisfies readonly BackfillMode[]);

export const backfillStatusEnum = pgEnum("backfill_status", [
  "pending",
  "running",
  "completed",
  "skipped",
] as const satisfies readonly BackfillStatus[]);

// SS-13 — the operator override of a scoped rule's derived poll-enumeration mode.
export const pollScopeModeEnum = pgEnum("poll_scope_mode", [
  "cross-scope",
  "per-scope-enumerated",
  "per-scope-pinned",
] as const satisfies readonly PollScopeMode[]);

// ── Tables ───────────────────────────────────────────────────────────────────

/** `RegisteredApp` — an application in the landscape (data-model.md). */
export const registeredApp = pgTable("registered_app", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: registeredAppStatusEnum("status").notNull(),
  // Nullable: absent for a consumer-only app whose endpoint the mediator hosts.
  baseUrl: text("base_url"),
  capabilities: jsonb("capabilities").$type<AppCapabilities>().notNull(),
  // Phase-4 additive (OC-3): the per-app outbound concurrency + request-rate
  // ceilings the shared Outbound Call Executor enforces across all traffic to
  // this app. Nullable jsonb (like a NULL `base_url`): a NULL column is the
  // domain **absent** `outboundLimits` key — the executor's configured defaults
  // apply. Operational config on the registration, deferred from Phase 1
  // (README open question 10).
  outboundLimits: jsonb("outbound_limits").$type<OutboundLoadLimits>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** `ApiSpec` — an OpenAPI document registered for an app in a given role. */
export const apiSpec = pgTable(
  "api_spec",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => registeredApp.id),
    role: apiSpecRoleEnum("role").notNull(),
    rawDocument: jsonb("raw_document").$type<Record<string, unknown>>().notNull(),
    parsedIr: jsonb("parsed_ir").$type<Ir>().notNull(),
    analysisExclusions: jsonb("analysis_exclusions").$type<string[]>().notNull().default([]),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    status: apiSpecStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("api_spec_app_id_idx").on(table.appId)],
);

/**
 * `ResourceBinding` — one resource's operational bindings for an `ApiSpec`.
 *
 * The confirmable refs are normalized into `resource_binding_ref` (below);
 * `scope_path_bindings` is instead a `jsonb` collection on the parent, because it
 * is an open-ended per-parameter set of a discriminated union (SS-1/SS-2), not
 * the fixed six ref kinds — the same `jsonb` treatment as the refs' `value`.
 * `NOT NULL DEFAULT '[]'` so existing rows migrate to an empty collection.
 * `source_scope_ref` (SS-7) is a nullable `jsonb` for the same open-ended reason
 * (a component set); NULL is the domain **absent** ref, so existing rows migrate
 * to NULL.
 */
export const resourceBinding = pgTable(
  "resource_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiSpecId: uuid("api_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    resourceRef: text("resource_ref").notNull(),
    scopePathBindings: jsonb("scope_path_bindings")
      .$type<ScopePathBindingRow[]>()
      .notNull()
      .default([]),
    // `sourceScopeRef` (SS-7): a whole confirmable ref whose value is the scope
    // component set. `jsonb` (like `scope_path_bindings`) because it is an
    // open-ended component list, not one of the six normalized ref kinds.
    // NULLABLE (no default) — a NULL column is the domain **absent** ref (records
    // carry no container field); existing rows migrate to NULL.
    sourceScopeRef: jsonb("source_scope_ref").$type<SourceScopeRefRow>(),
  },
  (table) => [index("resource_binding_api_spec_id_idx").on(table.apiSpecId)],
);

/**
 * One `ConfirmableRef` of a `ResourceBinding`, normalized to its own row so
 * `confirmed_at` is a real `timestamptz` (never a stringified `Date` buried in
 * `jsonb`) and "list the still-unconfirmed refs of a spec" is a plain
 * `WHERE confirmed_at IS NULL` (Phase-4 rule enablement). An **absent** ref is
 * the absence of a row for that `(binding, kind)`; a **present-unconfirmed** ref
 * is a row with `confirmed_by`/`confirmed_at` NULL — the two stay distinct.
 */
export const resourceBindingRef = pgTable(
  "resource_binding_ref",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceBindingId: uuid("resource_binding_id")
      .notNull()
      .references(() => resourceBinding.id),
    refKind: resourceBindingRefKindEnum("ref_kind").notNull(),
    value: jsonb("value").$type<IrRefTarget>().notNull(),
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    // At most one row per (binding, kind); its leading column also serves the
    // by-binding lookups the read path issues.
    uniqueIndex("resource_binding_ref_binding_kind_uq").on(table.resourceBindingId, table.refKind),
  ],
);

/**
 * `Credential` — encrypted per-app auth material. `encrypted_payload` is the
 * only payload column and it is opaque ciphertext (or, for an `adapterToken` row,
 * a salted hash — see the domain `Credential`); there is deliberately **no
 * plaintext column** and no read path that returns this column (see
 * `CredentialRepository`).
 *
 * `valid_until` (Phase-5 AD-3) bounds a token's validity for the rotation overlap
 * window: **nullable, NO DB default** — NULL is the unbounded current token (and
 * every non-`adapterToken` row), so this column adds nothing to a pre-Phase-5 row
 * (backward compatible). "Still valid" is the queryable predicate
 * `valid_until IS NULL OR valid_until > now()`; an elapsed overlap and an explicit
 * revocation are the same fact (a `valid_until` in the past), so there is no
 * separate `revoked_at`.
 */
export const credential = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => registeredApp.id),
    type: credentialTypeEnum("type").notNull(),
    encryptedPayload: text("encrypted_payload").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    // NOT NULL: the domain contract is `Credential.lastRotatedAt: Date`, always
    // set at creation by `CredentialStore.store` (data-model.md `Credential`).
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
  },
  (table) => [index("credential_app_id_idx").on(table.appId)],
);

// ── Event Bus (transactional outbox + consumer idempotency ledger) ────────────

/**
 * `event_outbox` — the transactional outbox that makes the Event Bus durable and
 * at-least-once (overview.md *Components* / *Event Bus*). A producer writes its
 * event here **inside the same transaction** as the state change that produced it
 * (`EventBus.emit(event, tx)`), so the event and its cause commit or roll back
 * together — the bus never records a change that didn't happen, and never loses
 * one that did. The dispatcher later claims unpublished rows, delivers them to
 * registered consumers, and stamps `published_at`.
 *
 * `payload` holds only the event's **type-specific** fields; the envelope
 * (`id`/`type`/`occurred_at`) lives in dedicated columns so the dispatcher's
 * "unpublished, ready" scan and the `event_id` uniqueness are plain SQL, not
 * jsonb probing. `event_id` is the domain event id (`DomainEventEnvelope.id`) and
 * is UNIQUE, so emitting the same event twice is a no-op (idempotent emit).
 *
 * A row with `published_at IS NULL AND attempts >= <ceiling>` is a **parked
 * (dead-letter)** event: it exhausted its retry budget and is skipped by the
 * dispatcher's ready scan (the ceiling is the dispatcher's, not the schema's, so
 * it stays a plain `attempts` comparison).
 */
export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The domain event id (`DomainEventEnvelope.id`); UNIQUE → idempotent emit.
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    // Only the type-specific payload fields (the envelope is columnar).
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // NULL until a dispatch run has delivered the row to every registered
    // consumer for its type; set once, never cleared in normal operation.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_outbox_event_id_uq").on(table.eventId),
    // The dispatcher's claim query: unpublished rows in arrival order. A partial
    // index keeps it tight — published rows (the vast majority over time) are not
    // indexed, and the leading `created_at` matches the `ORDER BY created_at`.
    index("event_outbox_unpublished_idx")
      .on(table.createdAt)
      .where(sql`${table.publishedAt} IS NULL`),
  ],
);

/**
 * `processed_event` — the consumer-side idempotency ledger that makes consumers
 * dedupe by event id (overview.md: "idempotent consumers (deduplicating by event
 * id)"). One row per `(consumer_name, event_id)` that a consumer has successfully
 * handled; the dispatcher inserts it **in the same transaction as the handler's
 * own writes**, so "handled" and "its effects" commit atomically. Before invoking
 * a consumer the dispatcher checks for this row and skips if present, so an
 * at-least-once redelivery runs the committed side effect exactly once.
 */
export const processedEvent = pgTable(
  "processed_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consumerName: text("consumer_name").notNull(),
    eventId: text("event_id").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The dedup key: a consumer handles each event id at most once. Its leading
    // column also serves the `isProcessed(consumer, event)` lookup.
    uniqueIndex("processed_event_consumer_event_uq").on(table.consumerName, table.eventId),
  ],
);

// ── Phase-2 mapping-detection tables (proposal persistence) ──────────────────

/**
 * `MappingProposal` — the output of one Mapping Engine run over a *directional*
 * pair of specs (`docs/architecture/data-model.md` `MappingProposal`, PP-1). Its
 * `MappingProposalItem`s hang off `mapping_proposal_item` below.
 *
 * `shortlist_result` is **nullable**: a stage-1 (shortlist) failure never
 * produced a valid shortlist, so a `status = 'failed'` proposal carries NULL here
 * and has no items (PP-1 criterion 4). A successful run stores the mechanically-
 * enriched `ShortlistResult` (candidate pairs + no-counterpart set + per-pair
 * `analysisFailed` markers, PP-3). There is deliberately **no** `review_required`
 * column on the item table below — that flag is DERIVED (`isReviewRequired`).
 */
export const mappingProposal = pgTable(
  "mapping_proposal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSpecId: uuid("source_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    targetSpecId: uuid("target_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    generatedBy: jsonb("generated_by").$type<GeneratedBy>().notNull(),
    // Nullable: NULL for a stage-1 `failed` proposal (nothing reviewable).
    shortlistResult: jsonb("shortlist_result").$type<ShortlistResult>(),
    status: mappingProposalStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "proposals produced for this spec" (as source of a directional analysis).
    index("mapping_proposal_source_spec_id_idx").on(table.sourceSpecId),
    // "the directional proposal for this ordered spec pair".
    index("mapping_proposal_source_target_idx").on(table.sourceSpecId, table.targetSpecId),
  ],
);

/**
 * `MappingProposalItem` — a single candidate correspondence within a proposal
 * (`docs/architecture/data-model.md` `MappingProposalItem`, PP-2). One row per
 * operation/field/parameter correspondence; the fields that only apply to some
 * kinds (`phase`, `transform_suggestion`) are nullable.
 *
 * **CASCADE deviation.** `proposal_id` is `ON DELETE CASCADE` — items are wholly
 * owned by their proposal and have no independent existence or audit value once
 * the proposal is gone. This deliberately deviates from the Phase-1 registration
 * entities, which are retained rather than deleted (an `ApiSpec` is `archived`,
 * never dropped, so archived mappings still pin it for audit). A proposal is a
 * pre-approval review artifact, not an audit-pinned entity, so deleting a
 * proposal genuinely removes its items rather than orphaning them.
 *
 * `transform_suggestion` is a single nullable column encoding the domain's THREE
 * states with help from `unmapped`: an **object** for a mapped field/parameter
 * item; **NULL + `unmapped = false`** for a mapped `operation` item (domain
 * `null`); **NULL + `unmapped = true`** for an unmapped item (domain absent). The
 * mapper reconstructs the absent-vs-null distinction from `unmapped` (see
 * `src/mappers/mapping-proposal-item.ts`).
 *
 * `confidence_score` is `double precision` (float8): it round-trips every JS
 * `number` exactly and matches the domain `number` type — and the same precision
 * the nested `ambiguousAlternatives[].confidence` values ride at inside the
 * `jsonb` column, so a confidence is never stored at two fidelities. The mapper
 * reads it back as a plain `number`.
 *
 * `identity_candidate` (boolean) and `target_lookup_param_ref` (text) are the
 * peer-peer field detection metadata (PP-2): both nullable, set only on a
 * peer-peer `kind = field` item. A NULL column is the domain **absent** key
 * (`stripUndefined`); a stored `false`/value round-trips as-is. The domain schema
 * makes them unrepresentable on any other item, so their being NULL there is an
 * invariant, not just a convention.
 */
export const mappingProposalItem = pgTable(
  "mapping_proposal_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => mappingProposal.id, { onDelete: "cascade" }),
    kind: mappingProposalItemKindEnum("kind").notNull(),
    sourceRef: jsonb("source_ref").$type<ProposalElementRef>().notNull(),
    // Nullable: absent when `unmapped = true` (no counterpart).
    targetRef: jsonb("target_ref").$type<ProposalElementRef>(),
    // Nullable: only on `kind = field` items of consumer-provider proposals.
    phase: mappingPhaseEnum("phase"),
    // Nullable: NULL for an operation item (domain `null`) and for an unmapped
    // item (domain absent); the mapper disambiguates via `unmapped`.
    transformSuggestion: jsonb("transform_suggestion").$type<TransformSuggestion>(),
    confidenceScore: doublePrecision("confidence_score").notNull(),
    ambiguousAlternatives: jsonb("ambiguous_alternatives")
      .$type<ProposalItemAlternative[]>()
      .notNull()
      .default([]),
    unmapped: boolean("unmapped").notNull(),
    rationale: text("rationale").notNull(),
    reviewState: reviewStateEnum("review_state").notNull(),
    // Peer-peer field detection metadata (PP-2). Nullable → domain absent key;
    // a stored `false`/value round-trips. Only ever set on a peer-peer field item.
    identityCandidate: boolean("identity_candidate"),
    targetLookupParamRef: text("target_lookup_param_ref"),
  },
  (table) => [index("mapping_proposal_item_proposal_id_idx").on(table.proposalId)],
);

// ── Phase-2 detection-trigger (durable async detection job) ───────────────────

/**
 * `mapping_detection_job` — the durable record of intent to run mapping detection
 * for one `ApiSpec`. It exists so the `SpecIngested` consumer can **record intent
 * and commit fast** inside the Event Bus dispatcher transaction, while the slow
 * LLM/network detection (~1,000 calls landscape-wide, seconds–minutes) runs
 * **outside** that transaction in a separate durable worker (`DetectionWorker`) —
 * the dispatcher never holds a row lock across the analysis (DT-2).
 *
 * The lifecycle (`detection_job_status`) is `pending → running → completed|failed`.
 * `attempts` is bumped each time the worker claims the job; a job that fails the
 * detection run enough times to reach the worker's attempt ceiling is parked as
 * `failed` (surfaced, not silently retried forever). `started_at`/`finished_at`
 * bracket a run; a job left `running` by a process crash is reclaimed (its
 * `started_at` is older than the worker's stale timeout) and re-run — detection is
 * idempotent-safe to re-run.
 *
 * Two partial indexes carry the two hot paths:
 *  - `..._pending_idx` — the worker's claim query (`pending` rows in arrival order).
 *  - `..._active_spec_uq` — a **partial UNIQUE** index over `(api_spec_id)` where the
 *    job is un-finished (`pending`/`running`), so `enqueue` is idempotent per spec:
 *    an `INSERT … ON CONFLICT DO NOTHING` never double-enqueues a spec that already
 *    has a job in flight (the consumer under at-least-once delivery, or the
 *    reconciler, both stay a no-op). A `completed`/`failed` job leaves the set, so a
 *    later re-analysis of the same spec (Phase 6) can enqueue afresh.
 */
export const mappingDetectionJob = pgTable(
  "mapping_detection_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiSpecId: uuid("api_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    status: detectionJobStatusEnum("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // NULL until the worker claims the job; set on each claim, cleared when the job
    // is returned to `pending` for a retry.
    startedAt: timestamp("started_at", { withTimezone: true }),
    // NULL until the job reaches a terminal state (`completed`/`failed`).
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // The worker's claim query: pending rows in arrival order. Partial so the vast
    // majority of rows (terminal jobs) are not indexed.
    index("mapping_detection_job_pending_idx")
      .on(table.createdAt, table.id)
      .where(sql`${table.status} = 'pending'`),
    // Supports the worker's stale-reclaim scan (`running` rows past the lease).
    index("mapping_detection_job_running_idx")
      .on(table.startedAt)
      .where(sql`${table.status} = 'running'`),
    // At most one un-finished (pending|running) job per spec → idempotent enqueue.
    uniqueIndex("mapping_detection_job_active_spec_uq")
      .on(table.apiSpecId)
      .where(sql`${table.status} in ('pending', 'running')`),
  ],
);

// ── Phase-3 approved-mapping tables (the executable review outcome) ───────────

/**
 * `ApprovedMapping` — the reviewed, human-approved result the Sync/Adapter
 * engines act on (`docs/architecture/data-model.md` `ApprovedMapping`, AS-2). One
 * row per directional proposal, **updated in place** across incremental partial
 * approvals (AS-2 criterion 4) — never a new row per approve.
 *
 * `source_spec_id`/`target_spec_id` pin the exact `ApiSpec` on each side (the
 * source of truth); `source_app_id`/`target_app_id` denormalize them for query
 * convenience. `variant` routes the AI-* instantiation (peer-peer → `SyncRule`s,
 * consumer-provider → `AdapterBinding`s). Phase 3 only ever creates rows at
 * `status = 'active'` — non-execution comes from the disabled downstream
 * artifacts, never a mapping status (AS-6 criterion 3).
 *
 * `counterpart_mapping_id` is a nullable **self-reference**: peer-peer only, set
 * on both rows when the reverse-direction mapping is also approved (AS-6
 * criterion 2). No cascade — clearing it on archival is a deliberate Phase-6
 * action, not an incidental delete.
 *
 * The partial UNIQUE index enforces the core invariant that at most **one active**
 * `ApprovedMapping` exists per directional spec pair, which is what makes the
 * update-in-place lookup (`getActiveByDirectionalSpecPair`) unambiguous. Non-active
 * rows (a future `superseded`/`archived`) are excluded, so successor adoption can
 * still hold both rows.
 */
export const approvedMapping = pgTable(
  "approved_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSpecId: uuid("source_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    targetSpecId: uuid("target_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    sourceAppId: uuid("source_app_id")
      .notNull()
      .references(() => registeredApp.id),
    targetAppId: uuid("target_app_id")
      .notNull()
      .references(() => registeredApp.id),
    variant: mappingVariantEnum("variant").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    status: approvedMappingStatusEnum("status").notNull(),
    // Nullable self-reference: peer-peer reverse-direction link (AS-6). No cascade.
    counterpartMappingId: uuid("counterpart_mapping_id").references(
      (): AnyPgColumn => approvedMapping.id,
    ),
  },
  (table) => [
    // The update-in-place / counterpart lookups: by directional spec pair.
    index("approved_mapping_source_target_idx").on(table.sourceSpecId, table.targetSpecId),
    // At most one ACTIVE mapping per directional spec pair (update-in-place).
    uniqueIndex("approved_mapping_active_direction_uq")
      .on(table.sourceSpecId, table.targetSpecId)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * `FieldMapping` — one approved field-level correspondence under an
 * `ApprovedMapping` (`docs/architecture/data-model.md` `FieldMapping`, AS-2). The
 * persisted form of an accepted/edited `kind = field` `MappingProposalItem`.
 *
 * `mapping_id` is `ON DELETE CASCADE`: a field mapping is wholly owned by its
 * `ApprovedMapping` and the approve action reconciles the child set by replacing
 * it, so an orphaned field row has no meaning.
 *
 * Conditionally-meaningful columns match the domain's variant conditionality
 * (`FieldMapping`): `phase` is present only on consumer-provider rows;
 * `is_identity_key`/`target_lookup_param_ref`/`conflict_policy` only on peer-peer
 * rows. All are nullable → the mapper collapses NULL to an **absent** domain key.
 * Phase 3 writes `is_identity_key = true` **only** on the one reviewer-confirmed
 * identity field per resource pair (all others NULL), and never writes
 * `conflict_policy` (a Phase-4 concern).
 */
export const fieldMapping = pgTable(
  "field_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mappingId: uuid("mapping_id")
      .notNull()
      .references(() => approvedMapping.id, { onDelete: "cascade" }),
    sourcePath: text("source_path").notNull(),
    targetPath: text("target_path").notNull(),
    transform: transformKindEnum("transform").notNull(),
    // Nullable: only multi-input transforms declare additional input paths.
    transformConfig: jsonb("transform_config").$type<TransformConfig>(),
    // Nullable: only on consumer-provider rows.
    phase: mappingPhaseEnum("phase"),
    // Nullable: peer-peer only; `true` on the single confirmed identity field.
    isIdentityKey: boolean("is_identity_key"),
    targetLookupParamRef: text("target_lookup_param_ref"),
    // Nullable: peer-peer only; Phase 3 always leaves it NULL.
    conflictPolicy: conflictPolicyEnum("conflict_policy"),
  },
  (table) => [index("field_mapping_mapping_id_idx").on(table.mappingId)],
);

/**
 * `OperationMapping` — one approved operation-level correspondence under an
 * `ApprovedMapping` (`docs/architecture/data-model.md` `OperationMapping`, AS-2/
 * AS-4). Tells the executing engines which target operation to call.
 *
 * `action` is classified mechanically from the target operation's IR at approval,
 * reviewer-overridable (AS-4). `target_id_param_ref` is nullable: present only on
 * `action = update | delete` rows of a **peer-peer** mapping (the linked record's
 * target-side native id parameter); absent on `create`/`read`, and — a
 * construction-time invariant, not a column constraint — absent on
 * consumer-provider mappings, which fill inputs via `parameter_mapping` instead.
 */
export const operationMapping = pgTable(
  "operation_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mappingId: uuid("mapping_id")
      .notNull()
      .references(() => approvedMapping.id, { onDelete: "cascade" }),
    sourceOperationRef: text("source_operation_ref").notNull(),
    targetOperationRef: text("target_operation_ref").notNull(),
    action: operationActionEnum("action").notNull(),
    // Nullable: peer-peer update/delete only.
    targetIdParamRef: text("target_id_param_ref"),
  },
  (table) => [index("operation_mapping_mapping_id_idx").on(table.mappingId)],
);

/**
 * `ParameterMapping` — one approved operation-input correspondence under a
 * **consumer-provider** `ApprovedMapping` (`docs/architecture/data-model.md`
 * `ParameterMapping`, AS-2). Hangs off the `OperationMapping` that pairs the two
 * operations (`operation_mapping_id`, `ON DELETE CASCADE`), not off the mapping
 * directly, because parameters are inherently per-operation. Peer-peer mappings
 * have **no** rows of this table.
 *
 * `transform`/`transform_config` are nullable: a parameter may pass through
 * untransformed.
 */
export const parameterMapping = pgTable(
  "parameter_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operationMappingId: uuid("operation_mapping_id")
      .notNull()
      .references(() => operationMapping.id, { onDelete: "cascade" }),
    sourceParamRef: text("source_param_ref").notNull(),
    targetParamRef: text("target_param_ref").notNull(),
    // Nullable: a pass-through parameter carries no transform.
    transform: transformKindEnum("transform"),
    transformConfig: jsonb("transform_config").$type<TransformConfig>(),
  },
  (table) => [index("parameter_mapping_operation_mapping_id_idx").on(table.operationMappingId)],
);

// ── Audit / Event Log (mapping-decision rows; sync rows arrive in Phase 4) ─────

/**
 * `SyncEvent / AuditLog` — the durable, queryable record of mapping decisions,
 * credential accesses, and (from Phase 4) sync executions and adapter requests
 * (`docs/architecture/data-model.md` `SyncEvent / AuditLog`;
 * `docs/architecture/security.md` *Audit logging*). Phase 3 writes only
 * `type = 'mapping-decision'` rows — one per per-item review decision (AS-1
 * criterion 5) and one per approve action, attributing each to its authenticated
 * actor.
 *
 * The `related_*` references are **loose** (no foreign key): an audit row is
 * retained for traceability even after its proposal/items are deleted, so it must
 * not cascade with them — the same "retained for audit" discipline the data model
 * applies to archived specs/mappings. `details` is a metadata-only note; the
 * schema layer carries no secret material by construction (only ids/enums/short
 * notes).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: auditLogTypeEnum("type").notNull(),
    actor: text("actor").notNull(),
    // Present on mapping-decision rows; NULL on the sync-focused types.
    decision: mappingDecisionEnum("decision"),
    relatedProposalId: uuid("related_proposal_id"),
    relatedItemId: uuid("related_item_id"),
    relatedMappingId: uuid("related_mapping_id"),
    details: text("details"),
    // ── Phase-4 sync-execution columns (SD-4 / OC-5) ──────────────────────────
    // A `sync-execution` row's per-record execution context, written once per
    // resolved outbound call (OC-5 criterion 1). All nullable + loose (no FK),
    // like the other `related_*` refs, so the audit row survives later deletion
    // of the rule/link it references. NULL on non-execution row types.
    // `status` is the execution outcome; `idempotency_key` is what OC-2's
    // per-record dedup lookback queries by (indexed below); `payload_hash`,
    // `related_rule_id`, `record_link_id`, `source_native_id` are the remaining
    // SD-4 per-record fields. HASHES/IDS ONLY — never a live payload value.
    status: auditLogStatusEnum("status"),
    relatedRuleId: uuid("related_rule_id"),
    recordLinkId: uuid("record_link_id"),
    sourceNativeId: text("source_native_id"),
    idempotencyKey: text("idempotency_key"),
    payloadHash: text("payload_hash"),
    // ── Phase-4 credential-access columns (CD-3) ──────────────────────────────
    // The credential a `credential-access` row concerns + the app whose credential
    // it was. Loose (no FK), like the other `related_*` refs, so the audit row
    // survives a later rotation/deletion of the credential (and of the app). NULL
    // on every other row type; NULL too on a `no credential used` access row,
    // which is what makes that public-app case distinguishable from a real
    // decrypt (CD-3 criterion 3).
    relatedCredentialId: uuid("related_credential_id"),
    originAppId: uuid("origin_app_id"),
    // OpenTelemetry correlation: every `credential-access` row carries these (CD-3
    // criterion 4) so an operator can jump from the credential access to the
    // outbound-call trace. `text` (not `uuid`): OTel trace/span ids are hex, not
    // UUIDs. NULL on the pre-existing `mapping-decision` rows (they set neither).
    // The remaining SD-4 per-record columns (status/relatedRuleId/recordLinkId/
    // sourceNativeId/idempotencyKey/payloadHash) arrive with the sync/adapter
    // slices that write them; CD-3 adds only what a credential-access row needs.
    traceId: text("trace_id"),
    spanId: text("span_id"),
    // ── Phase-5 adapter-request columns (AD-5) ────────────────────────────────
    // An `adapter-request` row's serving context. `related_binding_id` (named by
    // the data model) and `related_endpoint_id` are loose (no FK), like every
    // other `related_*` ref, so the audit row survives a later deletion of the
    // binding/endpoint it served. `cause` is which of the six named causes an
    // adapter request failed with (a SEPARATE column from `status`, which reuses
    // the Phase-4 enum unchanged — AD-5.5); `degraded` marks a served-but-degraded
    // response (a failed supplement under non-strict mode), distinct from both a
    // clean success and a failure (AD-5.3). All nullable; NULL on every non-adapter
    // row and on a clean adapter success. IDS/ENUM/BOOL ONLY — never a payload
    // value (AD-5.4).
    relatedBindingId: uuid("related_binding_id"),
    relatedEndpointId: uuid("related_endpoint_id"),
    cause: adapterRequestCauseEnum("cause"),
    degraded: boolean("degraded"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "the decision history for this proposal" / "for this mapping".
    index("audit_log_related_proposal_id_idx").on(table.relatedProposalId),
    index("audit_log_related_mapping_id_idx").on(table.relatedMappingId),
    // OC-2's bounded-lookback dedup: "is there a prior successful sync-execution
    // for this idempotency key within the retention window?" A partial index over
    // the non-NULL keys keeps it tight — the vast majority of rows (decisions,
    // credential accesses, skipped executions with no key) are not indexed.
    index("audit_log_idempotency_key_idx")
      .on(table.idempotencyKey, table.timestamp)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

// ── Phase-3 downstream artifacts (the disabled instantiation of an approval) ───
//
// The `MappingApproved` consumer instantiates these in a NON-executing state
// (`docs/flows/mapping-review-and-approval.md` steps 9-10; requirements AI-1..AI-3):
// a peer-peer mapping yields disabled `sync_rule`s + a `sync` `graph_edge`; a
// consumer-provider mapping yields an `adapter_endpoint` with `proposed`
// `adapter_binding`s + an `adapter-dependency` `graph_edge`. These carry ONLY the
// AM-6 minimal columns — no Phase-4 execution state (cursor/snapshot/backfill/
// deletePropagation/intervals) and no Phase-5 composition state (aggregation
// strategy, post-merge filters/sorts/pagination, execution order, chaining,
// cache TTL). Those columns arrive with the phases that write them.

/**
 * `SyncRule` — the disabled, per-resource-pair sync configuration a peer-peer
 * `ApprovedMapping` instantiates (`docs/architecture/data-model.md` `SyncRule`,
 * AI-1). One row per mapped resource pair; created `status = 'disabled'`, with no
 * live execution state — enablement (Phase 4) is what seeds the cursor/snapshot
 * and triggers the backfill.
 *
 * `resource_pair_ref` is the mapped resource pair in its **canonical
 * direction-agnostic form** (the two `(app, resource)` sides ordered by a stable
 * key, never by this rule's direction), so both directions of a bidirectional pair
 * name the same links/field state (data-model.md `SyncRule`/`RecordLink`).
 *
 * `mapping_id` is `ON DELETE CASCADE`: a rule is wholly instantiated by its
 * `ApprovedMapping` (the child-mapping discipline). The partial-free UNIQUE index
 * over `(approved_mapping_id, resource_pair_ref)` is the idempotency/upsert key: a
 * redelivered `MappingApproved` (or an incremental one) re-inserts each rule with
 * `ON CONFLICT DO NOTHING`, so an already-instantiated rule (and any operator state
 * on it) is left untouched while a newly-covered pair adds a row (AI-3 criteria 1/2).
 */
export const syncRule = pgTable(
  "sync_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvedMappingId: uuid("approved_mapping_id")
      .notNull()
      .references(() => approvedMapping.id, { onDelete: "cascade" }),
    resourcePairRef: text("resource_pair_ref").notNull(),
    status: syncRuleStatusEnum("status").notNull(),
    // ── Phase-4 SD-1 execution/policy columns ─────────────────────────────────
    // Every column is **nullable with NO DB default** — the SD-1 `.optional()`
    // discipline (`docs/domain/downstream-artifacts.ts`): a `.default()` here would
    // make the mapper reconstruct a *present* value on a Phase-3 minimal-row rule
    // (only the four columns above), whereas a disabled rule must carry **absent**
    // execution state. The concept's defaults (`deletePropagation = ignore`,
    // `targetDriftCheck = none`, `backfillStatus = pending`) are applied by the
    // enablement/instantiation layer (BE-*), not the column. The `sync-rule` mapper
    // collapses each NULL back to an absent domain key. Backward-compatible with the
    // Phase-3 AI-1 insert, which sets none of them (they land NULL).
    pollIntervalOverride: integer("poll_interval_override"),
    pollOperationRef: text("poll_operation_ref"),
    deletePropagation: deletePropagationEnum("delete_propagation"),
    targetDriftCheck: targetDriftCheckEnum("target_drift_check"),
    backfillMode: backfillModeEnum("backfill_mode"),
    backfillStatus: backfillStatusEnum("backfill_status"),
    // SS-13.5 — the operator override of the derived poll-enumeration mode (nullable;
    // NULL = use the derived mode). Additive/backward-compatible: a pre-SS-13 rule row
    // has it NULL and polls cross-scope exactly as before.
    pollScopeMode: pollScopeModeEnum("poll_scope_mode"),
    // Live polling state, seeded at the transition to live polling (BE) and advanced
    // atomically by the Poller (SP-5). `last_run_at` advances with the cursor;
    // `cursor` is delta-only; `last_snapshot_ref` points at this rule's
    // `poll_snapshot` row (full-fetch only).
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    cursor: text("cursor"),
    lastSnapshotRef: uuid("last_snapshot_ref"),
  },
  (table) => [
    index("sync_rule_approved_mapping_id_idx").on(table.approvedMappingId),
    // Idempotent instantiation: at most one rule per (mapping, resource pair).
    uniqueIndex("sync_rule_mapping_resource_pair_uq").on(
      table.approvedMappingId,
      table.resourcePairRef,
    ),
    // The Scheduler's "which rules might be due to poll" scan: enabled rules only.
    // Partial so the (eventually many) disabled rows are not indexed.
    index("sync_rule_enabled_idx")
      .on(table.status)
      .where(sql`${table.status} = 'enabled'`),
  ],
);

/**
 * SS-13 — the non-NULL **sentinel** scope key for the cross-scope (non-per-scope)
 * case. Postgres treats NULLs as *distinct* in a unique index, so modeling the
 * single-snapshot cross-scope case as `scope_key = NULL` under a `(sync_rule_id,
 * scope_key)` unique index would let a rule accumulate many NULL-keyed snapshot rows
 * and break the "one cross-scope snapshot per rule" invariant. A fixed non-NULL
 * sentinel keeps that row unique. It can never collide with a real per-scope key: a
 * per-scope key is a `ScopeLink` id (a uuid), never this string.
 */
export const CROSS_SCOPE_SCOPE_KEY = "__cross_scope__";

/**
 * `poll_snapshot` — the per-record content-hash snapshot a full-fetch `SyncRule`
 * diffs against (`docs/architecture/data-model.md` `SyncRule.lastSnapshotRef`;
 * `docs/architecture/sync-engine.md` *Polling pull pipeline*, SP-2/SP-4/SP-5).
 *
 * **Per-`(rule, scope)` since SS-13.** A cross-scope rule (SS-13.1) keeps its single
 * snapshot under the {@link CROSS_SCOPE_SCOPE_KEY} sentinel — unchanged from SP-5. A
 * per-scope rule (SS-13.3) keeps one snapshot **per scope**, keyed by the scope's
 * `ScopeLink` id, so a partial fetch for one scope replaces only that scope's
 * snapshot and never touches another's. The unique key is therefore
 * `(sync_rule_id, scope_key)`, never `sync_rule_id` alone.
 *
 * **Why one jsonb blob per (rule, scope), not a row-per-native-id table.** The Poller
 * loads the *entire* prior snapshot for a scope once per poll, diffs the complete
 * fetch against it in memory, and rewrites the whole map — it never queries an
 * individual native id from SQL, so per-row queryability buys the algorithm nothing.
 * A blob makes the SP-5 "replace the snapshot" a single `UPDATE`, which is what lets
 * the snapshot replacement and the cursor/`last_run_at` advance commit in **one
 * transaction** — the atomic advance SP-5 requires, now per scope.
 *
 * `sync_rule_id` FKs `sync_rule` `ON DELETE CASCADE`: the snapshot is wholly owned
 * by its rule. In cross-scope mode `sync_rule.last_snapshot_ref` points back at this
 * row's `id`; in per-scope mode `poll_scope_state.last_snapshot_ref` does.
 */
export const pollSnapshot = pgTable(
  "poll_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRuleId: uuid("sync_rule_id")
      .notNull()
      .references(() => syncRule.id, { onDelete: "cascade" }),
    // SS-13 — the scope discriminator: a per-scope `ScopeLink` id, or the sentinel
    // {@link CROSS_SCOPE_SCOPE_KEY} for a cross-scope rule (NOT NULL → no NULL-in-
    // unique-index trap). Defaulted to the sentinel so existing per-rule rows stay
    // unique under the new (sync_rule_id, scope_key) key (additive migration).
    scopeKey: text("scope_key").notNull().default(CROSS_SCOPE_SCOPE_KEY),
    // The native id → content-hash map from the last complete fetch.
    entries: jsonb("entries").$type<Record<string, string>>().notNull(),
    // Denormalized `Object.keys(entries).length` for observability (no blob parse).
    recordCount: integer("record_count").notNull(),
    // When the complete fetch this snapshot was captured from finished.
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One snapshot per (rule, scope) → the replace-in-place UPDATE key and load lookup.
    // The cross-scope sentinel keeps the single-snapshot invariant (SS-13.3).
    uniqueIndex("poll_snapshot_rule_scope_uq").on(table.syncRuleId, table.scopeKey),
  ],
);

/**
 * `poll_scope_state` — SS-13.3 the **per-`(rule, scope)`** live polling state for a
 * per-scope rule (`docs/requirements/scoped-resource-sync.md` SS-13.3;
 * `docs/architecture/sync-engine.md` *Polling pull pipeline*). Each scope keeps its
 * **own** `cursor` (delta) / `last_snapshot_ref` (full-fetch) / `last_run_at`, so a
 * partial fetch or a write failure for one scope aborts and preserves **only that
 * scope's** state — never another's (per-scope isolation, mirroring SP-4/SP-5 per
 * scope). A cross-scope rule (SS-13.1) uses **none** of this — its single cursor
 * stays on `sync_rule.cursor`/`sync_rule.last_snapshot_ref`, unchanged from SP-5.
 *
 * `scope_key` is the scope's `ScopeLink` id (constant / manual / discovered scopes
 * all fit — SS-11). `sync_rule_id` FKs `sync_rule` `ON DELETE CASCADE` (owned by its
 * rule). The `(sync_rule_id, scope_key)` UNIQUE index is the upsert key the atomic
 * per-scope advance writes through, and `scope_key` is NOT NULL so there is no
 * NULL-in-unique-index trap. `last_snapshot_ref` FKs `poll_snapshot` `ON DELETE SET
 * NULL` (the snapshot is replaced in place; a cascade-deleted snapshot leaves the
 * pointer NULL, i.e. "no snapshot yet", never dangling).
 */
export const pollScopeState = pgTable(
  "poll_scope_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    syncRuleId: uuid("sync_rule_id")
      .notNull()
      .references(() => syncRule.id, { onDelete: "cascade" }),
    // The scope's `ScopeLink` id (the per-scope discriminator).
    scopeKey: text("scope_key").notNull(),
    // Delta-polling cursor for this scope; NULL until seeded (BE-6 per scope).
    cursor: text("cursor"),
    // Last successful poll-run completion for this scope.
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    // This scope's `poll_snapshot` row (full-fetch); NULL until its first complete fetch.
    lastSnapshotRef: uuid("last_snapshot_ref").references(() => pollSnapshot.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One state row per (rule, scope) → the per-scope atomic-advance upsert key.
    uniqueIndex("poll_scope_state_rule_scope_uq").on(table.syncRuleId, table.scopeKey),
  ],
);

/**
 * `AdapterEndpoint` — the mediator-hosted virtual provider for one CONSUMER-spec
 * operation (`docs/architecture/data-model.md` `AdapterEndpoint`, AI-2). Created
 * when the first consumer-provider mapping covering that operation is approved,
 * then reused (never duplicated) as further mappings attach bindings — the
 * `(consumer_app_id, consumer_operation_id)` UNIQUE index is what makes the
 * ensure-exists idempotent (AI-2 criterion 1).
 *
 * Phase 3 creates it NON-serving: none of the AD-1 composition columns below and
 * its `status` reflects that composition and serving are deferred —
 * `composition-required`, the enum value that means "binding(s) attached, an
 * aggregation decision is still owed before anything serves" (AI-2 criterion 4;
 * the flow's single-binding "activate immediately" is overridden by the phase-3
 * reconciliation note in the requirement — there is no Adapter Server Runtime
 * until Phase 5).
 *
 * ## Phase-5 AD-1 composition/serving columns
 *
 * The serving state the Request Router, Resolution Planner, Response Aggregator,
 * and response cache read at request time. **Every column is nullable with NO DB
 * default** — the same SD-1 discipline the `sync_rule` execution columns use: a
 * `.default()` here would reconstruct a *present* value on a Phase-3
 * `composition-required` row that was composed with nothing (AD-1.6/AD-6.2). The
 * concept's auto-activation defaults (`single` + non-strict + no caching for a
 * single-binding endpoint) are applied by the CO-1 auto-activation slice, not by
 * these columns, so a Phase-3 row loads with all of them NULL and the mapper
 * collapses each back to an absent domain key. The four `post_merge_*` columns are
 * `collection-union` only (the domain refinement enforces that); they are `jsonb`
 * because their open-ended per-parameter shapes don't fit fixed columns — the same
 * treatment as `resource_binding.scope_path_bindings`.
 */
export const adapterEndpoint = pgTable(
  "adapter_endpoint",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    consumerAppId: uuid("consumer_app_id")
      .notNull()
      .references(() => registeredApp.id),
    consumerOperationId: text("consumer_operation_id").notNull(),
    status: adapterEndpointStatusEnum("status").notNull(),
    // ── AD-1 composition/serving columns (all nullable, NO DB default) ────────
    aggregationStrategy: aggregationStrategyEnum("aggregation_strategy"),
    // Response-cache lifetime in milliseconds; NULL = no caching (the default).
    cacheTtl: integer("cache_ttl"),
    strictness: endpointStrictnessEnum("strictness"),
    postMergeFilters: jsonb("post_merge_filters").$type<PostMergeFilter[]>(),
    postMergeSorts: jsonb("post_merge_sorts").$type<PostMergeSort[]>(),
    // `jsonb` cannot hold the `Date` `confirmedAt` — stored ISO-8601 string, the
    // mapper converts it back (see {@link PostMergePaginationRow}).
    postMergePagination: jsonb("post_merge_pagination").$type<PostMergePaginationRow>(),
    postMergeDedup: jsonb("post_merge_dedup").$type<PostMergeDedup>(),
    // ── CO-5.4 acknowledged-ignored consumer inputs (nullable, NO DB default) ──
    // NULL = no acknowledgements (the backward-compatible default: every unmapped
    // input rejects at request validation, RP-2.4). Existing rows read back NULL.
    acknowledgedIgnoredInputs: jsonb("acknowledged_ignored_inputs").$type<
      AcknowledgedIgnoredInput[]
    >(),
  },
  (table) => [
    index("adapter_endpoint_consumer_app_id_idx").on(table.consumerAppId),
    // Ensure-exists key: one endpoint per (consumer app, consumer operation).
    uniqueIndex("adapter_endpoint_consumer_operation_uq").on(
      table.consumerAppId,
      table.consumerOperationId,
    ),
  ],
);

/**
 * `AdapterBinding` — a binding from an `AdapterEndpoint` to a backend
 * app + operation, attached by a consumer-provider `ApprovedMapping`
 * (`docs/architecture/data-model.md` `AdapterBinding`, AI-2). Phase 3 attaches it
 * `status = 'proposed'` (not yet composed into a serving configuration) with the
 * default `role = 'primary'`; `backend_operation_id` is one of the approved
 * `OperationMapping`s' target operations, not free-form.
 *
 * Both foreign keys `ON DELETE CASCADE` (a binding is owned by its endpoint and by
 * its mapping). The UNIQUE index over
 * `(adapter_endpoint_id, backend_app_id, backend_operation_id, approved_mapping_id)`
 * is the idempotency/upsert key: a redelivered or incremental `MappingApproved`
 * re-inserts each binding with `ON CONFLICT DO NOTHING`. `approved_mapping_id` is
 * part of the key deliberately — two DIFFERENT mappings attaching a binding to the
 * same endpoint for the same backend operation are distinct candidate bindings
 * (a Phase-5 composition decision), not a duplicate.
 *
 * ## Phase-5 AD-2 execution/chaining columns
 *
 * `execution_order`, `depends_on_binding_id`, and `chain_inputs` — the composition
 * state that decides parallel-vs-sequential execution at request time. **All
 * nullable, NO DB default** (AD-6.2): a Phase-3-attached `proposed` binding loads
 * with `execution_order` NULL (the reader resolves the documented default `0` via
 * `resolveExecutionOrder`, never a column default that would fabricate a present
 * value on an uncomposed row) and the other two absent.
 *
 * `depends_on_binding_id` is constrained to a binding of the **same** endpoint
 * (AD-6.3) by the composite self-foreign-key
 * `(depends_on_binding_id, adapter_endpoint_id) → (id, adapter_endpoint_id)`,
 * backed by the `(id, adapter_endpoint_id)` UNIQUE below. Postgres MATCH SIMPLE
 * skips the check when `depends_on_binding_id` is NULL (an unchained binding is
 * unconstrained), and a cross-endpoint dependency is simply not representable.
 */
export const adapterBinding = pgTable(
  "adapter_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapterEndpointId: uuid("adapter_endpoint_id")
      .notNull()
      .references(() => adapterEndpoint.id, { onDelete: "cascade" }),
    backendAppId: uuid("backend_app_id")
      .notNull()
      .references(() => registeredApp.id),
    backendOperationId: text("backend_operation_id").notNull(),
    approvedMappingId: uuid("approved_mapping_id")
      .notNull()
      .references(() => approvedMapping.id, { onDelete: "cascade" }),
    role: adapterBindingRoleEnum("role").notNull(),
    status: adapterBindingStatusEnum("status").notNull(),
    // ── AD-2 execution/chaining columns (all nullable, NO DB default) ─────────
    executionOrder: integer("execution_order"),
    dependsOnBindingId: uuid("depends_on_binding_id"),
    chainInputs: jsonb("chain_inputs").$type<ChainInput[]>(),
  },
  (table) => [
    index("adapter_binding_adapter_endpoint_id_idx").on(table.adapterEndpointId),
    index("adapter_binding_approved_mapping_id_idx").on(table.approvedMappingId),
    // Idempotent attach: one binding per (endpoint, backend op, mapping).
    uniqueIndex("adapter_binding_endpoint_backend_mapping_uq").on(
      table.adapterEndpointId,
      table.backendAppId,
      table.backendOperationId,
      table.approvedMappingId,
    ),
    // The referenced side of the composite same-endpoint self-FK (AD-6.3). `id`
    // is already unique alone, so this pair is trivially unique; Postgres requires
    // the exact `(id, adapter_endpoint_id)` unique constraint for the FK below.
    unique("adapter_binding_id_endpoint_uq").on(table.id, table.adapterEndpointId),
    // A chained binding may depend only on a binding of the SAME endpoint.
    foreignKey({
      name: "adapter_binding_depends_on_same_endpoint_fk",
      columns: [table.dependsOnBindingId, table.adapterEndpointId],
      foreignColumns: [table.id, table.adapterEndpointId],
    }),
  ],
);

/**
 * `AdapterWriteOutcome` — the bounded **write-outcome store** (AD-4). A record of
 * a completed adapter write's status + response body, so a deduplicated repeat
 * delivery is answered with what actually happened rather than re-executed or
 * fabricated (`docs/architecture/adapter-engine.md` *Write operations*).
 *
 * Deliberately its **own** table, not a `SyncEvent`/`audit_log` row, because it
 * retains a live response body — the Audit Log stays metadata-only (AD-4.2). The
 * store is **bounded** (AD-4.3): every row carries `expires_at` (scoped to the
 * dedup window) and the pruning index below makes "delete the expired rows" a
 * range scan. It holds NO credential material and its `response_body` is never
 * dumped through the operator API/UI — only its metadata is readable (AD-4.4;
 * enforced by the mapper's metadata projection, mirroring `credential`).
 *
 * `outcome` (`success` | `failure`) is the top-level discriminant so a recorded
 * failure can never be read as a success on replay (AD-4.5); `response_status` and
 * `response_body` are nullable — absent on a bodyless success (`204`) and on a
 * failure that never reached the backend.
 *
 * Both FKs `ON DELETE CASCADE`: the store is scoped to its `adapter_endpoint`
 * (AD-4.4 boundedness + AD-6.4 cascade — write-outcome rows are removed with the
 * endpoint) and to the `adapter_binding` that executed the write. The dedup
 * lookup is `(adapter_endpoint_id, idempotency_key)` — a write endpoint is always
 * `single`, so the endpoint + key identify the delivery; that UNIQUE also stops a
 * double-insert of the same original outcome.
 */
export const adapterWriteOutcome = pgTable(
  "adapter_write_outcome",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    adapterEndpointId: uuid("adapter_endpoint_id")
      .notNull()
      .references(() => adapterEndpoint.id, { onDelete: "cascade" }),
    adapterBindingId: uuid("adapter_binding_id")
      .notNull()
      .references(() => adapterBinding.id, { onDelete: "cascade" }),
    outcome: adapterWriteOutcomeStatusEnum("outcome").notNull(),
    // On a recorded FAILURE, the specific cause the original delivery failed with —
    // so a deduplicated replay is answered with the same specific `AdapterRequestCause`
    // (WR-3.4 / WR-5.1), never a generic one. NULL on a success row (a success has no
    // cause). Reuses the `adapter_request_cause` enum the audit log already uses.
    cause: adapterRequestCauseEnum("cause"),
    responseStatus: integer("response_status"),
    // The recorded response body — a live payload value, which is exactly why this
    // store is separate from the metadata-only audit log. `unknown` (the domain
    // `AdapterWriteResult.responseBody`), NULL for a bodyless/absent response.
    responseBody: jsonb("response_body").$type<AdapterWriteResult["responseBody"]>(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // The dedup lookup + double-insert guard: one recorded outcome per
    // (endpoint, idempotency key). A write endpoint is single-binding, so the
    // endpoint + key identify the delivery.
    uniqueIndex("adapter_write_outcome_endpoint_key_uq").on(
      table.adapterEndpointId,
      table.idempotencyKey,
    ),
    // "delete every outcome past its dedup window" — the boundedness sweep.
    index("adapter_write_outcome_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * `GraphEdge` — the materialized projection of one sync/adapter-dependency
 * relationship between two app nodes (`docs/architecture/data-model.md`
 * `GraphEdge`, AI-1/AI-2 criterion 3). Upserted on approval, aggregating that
 * `(app pair, direction)`'s rules/bindings; not a source of truth.
 *
 * `status` is a plain `text` (the concept does NOT enumerate `GraphEdge.status` —
 * it projects the underlying rule/binding state). `metadata` is the one jsonb
 * column carrying the aggregated `direction` (`sourceSpecId → targetSpecId`) and
 * `lastActivityAt` (NULL before anything executes) — the mapper reconstructs the
 * `Date` on read.
 *
 * The UNIQUE index over `(source_node_id, target_node_id, type)` keys the edge by
 * its node pair + type + direction (direction is encoded by the ordered node
 * pair): a bidirectional pair is two directed rows. The upsert is ensure-exists
 * (`ON CONFLICT DO NOTHING`): for a fixed `(source app, target app, type)` the
 * projected direction is invariant and Phase 3 produces no activity, so a repeat
 * approval finds the edge already correct and must NOT clobber a later phase's
 * `lastActivityAt`/`status` (AI-3 criterion 2). Node columns FK `registered_app`.
 */
export const graphEdge = pgTable(
  "graph_edge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceNodeId: uuid("source_node_id")
      .notNull()
      .references(() => registeredApp.id),
    targetNodeId: uuid("target_node_id")
      .notNull()
      .references(() => registeredApp.id),
    type: graphEdgeTypeEnum("type").notNull(),
    status: text("status").notNull(),
    metadata: jsonb("metadata").$type<GraphEdgeMetadata>().notNull(),
  },
  (table) => [
    // Node pair + type + direction (direction = ordered node pair) → one edge.
    uniqueIndex("graph_edge_nodes_type_uq").on(table.sourceNodeId, table.targetNodeId, table.type),
  ],
);

// ── Phase-4 ordering queue (the Sync Engine's per-key consistency backbone) ────

/**
 * `ordering_queue` — the durable, single-active-worker-per-`queue_key` queue that
 * serializes the Sync Engine's pipeline executions (`docs/architecture/sync-engine.md`
 * *Ordering and consistency*; requirements OQ-1). This is the queue **mechanics**
 * only: `queue_key` is an **opaque string** supplied by the caller — what the key
 * *is* (a `RecordLink`, an identity value, a native id) is OQ-2/OQ-3, not this table.
 *
 * **The claim discipline (OQ-1 criteria 1-2, 5).** A worker claims the lowest-seq
 * non-terminal (`pending`/`processing`) entry **per key** — provided that entry is
 * actually claimable now: either `pending`, or a `processing` entry whose lease has
 * expired (a crashed worker, criterion 3). Because a `processing` entry is always
 * the lowest-seq non-terminal entry of its key, "lowest-seq non-terminal" collapses
 * the two guarantees into one predicate:
 *   1. **at most one active worker per key** — while an entry is `processing` under a
 *      live lease it is its key's lowest non-terminal entry, so no later entry of that
 *      key is claimable (they are excluded by the earlier-non-terminal check); and
 *   2. **sequential in enqueue order** — `enqueue_seq` is a `bigserial`, so a key's
 *      earlier entry always has a lower seq and is claimed first.
 * Entries under **different** keys have independent lowest-seq entries, so they are
 * claimed and processed **in parallel** (criterion 4 — no cross-key serialization).
 * The claim uses `FOR UPDATE SKIP LOCKED` so the one candidate row per key that two
 * workers race on is taken by exactly one; the loser skips it rather than blocking,
 * and — since only the single lowest-seq candidate per key is ever eligible — never
 * falls through to a *later* entry of the same key. The exact SQL lives in
 * `OrderingQueueRepository.claimNext` (raw `sql`, not the query builder).
 *
 * **Durability / crash recovery (criterion 3).** Entries are rows, so they survive a
 * crash; enqueue committing before the poll cursor advances is what makes SP-5's
 * enqueue-then-advance safe. A worker holds a **lease** (`lease_owner` +
 * `lease_expires_at`) across its handler run; if it dies, the lease expires and the
 * same `claimNext` predicate re-claims that still-`processing` entry (no separate
 * sweep needed — expiry is folded into the claim), preserving its key order.
 *
 * **Park moves on (criterion 5).** `park`ing an entry (dead-letter at the retry
 * ceiling) makes it terminal and clears its lease, so its key's next entry becomes
 * the lowest non-terminal and is claimed — a park holds neither its own key nor any
 * other. `done` is likewise terminal.
 *
 * `payload` is an **opaque** work descriptor (`Record<string, unknown>`): the actual
 * pipeline (RL/EP/CF/TX/OC) that runs per entry is out of scope for OQ-1 and consumes
 * this via an injected handler seam.
 */
export const orderingQueue = pgTable(
  "ordering_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The opaque ordering key (OQ-2/OQ-3 decide what goes here; this table does not).
    queueKey: text("queue_key").notNull(),
    // DB-assigned monotonic enqueue order. A `bigserial` gives a total order that
    // matches insert order exactly, so a key's later entry always sorts after its
    // earlier one (criterion 2). Only ever compared/ordered DB-side — never read
    // into the app — so int8's >2^53 range is irrelevant.
    enqueueSeq: bigserial("enqueue_seq", { mode: "bigint" }).notNull(),
    // The opaque work descriptor handed to the injected pipeline handler.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: orderingQueueStatusEnum("status").notNull(),
    // Bumped on every claim (a fresh claim or a lease-expiry re-claim); the
    // dispatcher parks an entry once this reaches its attempt ceiling (OC-4).
    attempts: integer("attempts").notNull().default(0),
    // The lease: who holds the entry and until when, while `processing`. Both NULL
    // in every non-`processing` state (cleared on done/park/retry). The claim treats
    // a `processing` entry with `lease_expires_at <= now` as a crashed worker and
    // re-claims it.
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Phase-4 retry-delay (OC-4 / OC-3): a **not-before** gate. NULL means "claim
    // whenever the per-key order allows"; a set timestamp defers the entry until
    // then, so a claim skips it while `available_at > now`. Set by the dispatcher
    // on a failed-write retry (exponential backoff **inside** the per-record
    // queue — OC-4 criterion 1) and on a load-discipline `defer` (a ceiling /
    // `Retry-After` wait — OC-3 criterion 5) so the worker is freed to process
    // other records instead of blocking the whole engine. Cleared on claim.
    availableAt: timestamp("available_at", { withTimezone: true }),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    // Stamped on each claim (observability); NULL until first claimed.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    // Stamped when the entry reaches a terminal state (`done`/`parked`).
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    // The claim query's index: the lowest-seq non-terminal entry per key, plus the
    // per-key "is there an earlier non-terminal / an active lease" checks. Partial so
    // the vast majority of rows (terminal `done`/`parked`) are not indexed; the
    // leading `queue_key` serves the per-key subqueries and `enqueue_seq` matches the
    // `ORDER BY enqueue_seq`.
    index("ordering_queue_claim_idx")
      .on(table.queueKey, table.enqueueSeq)
      .where(sql`${table.status} in ('pending', 'processing')`),
    // Supports monitoring/reclaiming stuck leases (`processing` rows past expiry).
    index("ordering_queue_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'processing'`),
  ],
);

// ── Phase-4 Identity Resolution: RecordLink + SyncFieldState (RL-1..RL-5) ──────

/**
 * `RecordLink` — the persisted pairing of one logical record's native id in app A
 * with the same record's native id in app B (`docs/architecture/data-model.md`
 * `RecordLink`; `docs/architecture/sync-engine.md` *Identity correlation*, RL-1..RL-5).
 * Everything stateful in sync (update routing, conflict detection, delete
 * propagation, delete-echo detection) runs over it, so it is the pipeline's first
 * resolved artifact.
 *
 * `app_a_id`/`app_b_id` are plain `uuid` with **no FK** to `registered_app`, exactly
 * like `audit_log`'s loose `related_*` refs: a link is **tombstoned, never deleted**
 * on a record deletion and **archived (not deleted)** when an app is deregistered
 * (Phase 6), so it must survive its apps in the table for audit and delete-echo
 * detection — an `ON DELETE` FK would defeat that. `resource_pair_ref` is the
 * mapped resource pair in its **canonical direction-agnostic form** (the two
 * `(app, resource)` sides ordered by a stable key), so both directions of a
 * bidirectional pair name the same link.
 *
 * `establishing_queue_key` is the retained pre-link ordering-queue key (SD-2 /
 * OQ-4), stored as the `RecordLinkEstablishingQueueKey` discriminated union in
 * jsonb (the `both-native-id-queues` marker carries no value). `tombstone_reason`
 * is NULL except on a `tombstoned` link; `tombstoned_at` is NULL until tombstoned.
 *
 * **The unique-active-link invariant (RL-4 safety).** Two partial UNIQUE indexes —
 * one per side, both `WHERE status = 'active'` — guarantee **at most one active
 * link per (resource pair, app, native id)** on each side. This is what the
 * resolve-by-(app, native id) lookup depends on and what makes a wrong/ambiguous
 * identity match unable to silently establish a second active link over a record
 * that already has one. Tombstoned/archived links are excluded from the index, so a
 * tombstone-then-recreate legitimately establishes a fresh active link.
 */
export const recordLink = pgTable(
  "record_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appAId: uuid("app_a_id").notNull(),
    appANativeId: text("app_a_native_id").notNull(),
    appBId: uuid("app_b_id").notNull(),
    appBNativeId: text("app_b_native_id").notNull(),
    // SS-19 — each side's frozen **container-relative address** (a Gitea issue's
    // `number`), captured at establishment via that side's
    // `ResourceBinding.recordAddressRef`, so a linked update/delete can address the
    // record inside its container without re-reading a source record that may be gone.
    // NULLABLE — a NULL column is the domain **absent** address (that side addresses by
    // its native id); existing rows migrate to NULL and keep the native-id behavior.
    // Deliberately NOT indexed and NOT unique: an address collides across containers, so
    // it must never be used to correlate records. The unique-active indexes below stay on
    // the native ids — identity is unchanged.
    appARecordAddress: text("app_a_record_address"),
    appBRecordAddress: text("app_b_record_address"),
    resourcePairRef: text("resource_pair_ref").notNull(),
    establishedBy: recordLinkEstablishedByEnum("established_by").notNull(),
    status: recordLinkStatusEnum("status").notNull(),
    // NULL except on a `tombstoned` link (the domain refinement enforces the pairing).
    tombstoneReason: recordLinkTombstoneReasonEnum("tombstone_reason"),
    // The retained pre-link ordering-queue key (SD-2 discriminated union) as jsonb.
    establishingQueueKey: jsonb("establishing_queue_key")
      .$type<RecordLinkEstablishingQueueKey>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // NULL on an active/archived link; set when the link is tombstoned.
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    // `scopeRef` (SS-10): the record's persisted container, captured at link
    // establishment on a **scoped** rule. NULLABLE `jsonb` — a NULL column is the
    // domain **absent** ref (a non-scoped rule's link); existing rows migrate to NULL.
    // The stored `{ kind: "scope-link", scopeLinkId }` reference resolves even against
    // an *archived* `ScopeLink`, so a final delete/audit still routes (SS-10 crit 5).
    scopeRef: jsonb("scope_ref").$type<RecordLinkScopeRef>(),
  },
  (table) => [
    // The unique-active invariant, per side (partial on active): at most one active
    // link per (resource pair, app, native id). Also serves the resolve-by-(app,
    // native id) lookup, which probes both sides.
    uniqueIndex("record_link_active_side_a_uq")
      .on(table.resourcePairRef, table.appAId, table.appANativeId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("record_link_active_side_b_uq")
      .on(table.resourcePairRef, table.appBId, table.appBNativeId)
      .where(sql`${table.status} = 'active'`),
    // The tombstone lookups (survivor / resurrection checks) probe by side-record too;
    // these non-unique indexes cover a record's history across statuses.
    index("record_link_side_a_idx").on(table.resourcePairRef, table.appAId, table.appANativeId),
    index("record_link_side_b_idx").on(table.resourcePairRef, table.appBId, table.appBNativeId),
  ],
);

/**
 * `ScopeCorrespondence` — the direction-agnostic **configuration** for one scoped
 * resource pair's container correlation, the home of the scope identity key
 * (`docs/architecture/data-model.md` `ScopeCorrespondence`, SS-10). **One per scoped
 * resource pair**, enforced by the UNIQUE index on `resource_pair_ref`.
 *
 * The open-ended shapes are `jsonb` (the same treatment as `resource_binding`'s
 * `scope_path_bindings`): `scope_identity_key` (a pairing array), and the container
 * refs (`{ appId, resourceRef }`). None carries a `Date`, so — unlike the confirmable
 * refs — they round-trip through `jsonb` verbatim; the scope-identity-key confirmation
 * is a real `timestamptz` column (`confirmed_at`, NULL while unconfirmed).
 */
export const scopeCorrespondence = pgTable(
  "scope_correspondence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourcePairRef: text("resource_pair_ref").notNull(),
    scopeIdentityKey: jsonb("scope_identity_key").$type<ScopeIdentityKey>().notNull(),
    targetContainerRef: jsonb("target_container_ref").$type<ScopeContainerRef>().notNull(),
    // NULL when the source container is knowable only from records' `sourceScopeRef`.
    sourceContainerRef: jsonb("source_container_ref").$type<ScopeContainerRef>(),
    // The scope-identity-key confirmation: both NULL while unconfirmed, both set on
    // confirmation (the domain refinement enforces the pairing).
    confirmedBy: text("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    // "One per scoped resource pair" — the config uniqueness invariant, and the
    // getByResourcePair / confirm-or-update key.
    uniqueIndex("scope_correspondence_resource_pair_uq").on(table.resourcePairRef),
  ],
);

/**
 * `ScopeLink` — a persisted container ↔ container correspondence established under a
 * `ScopeCorrespondence`, the one-level-up analog of `RecordLink`
 * (`docs/architecture/data-model.md` `ScopeLink`, SS-10). `scope_correspondence_id`
 * FKs its parent config. Each side's scope key is an open-ended `{ component → value }`
 * map (`jsonb`, no `Date`), so a `scope-link` binding's `scopeKeyRef` can select one
 * component. `resource_pair_ref` is the same canonical direction-agnostic form as
 * `record_link`, so both directions resolve the same link.
 *
 * Archiving (SS-10.5) sets `status = 'archived'` (never deletes), so a
 * `record_link.scope_ref` pointing here still resolves its frozen key for a final
 * delete/audit — which is why the FK does **not** cascade-delete.
 */
export const scopeLink = pgTable(
  "scope_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeCorrespondenceId: uuid("scope_correspondence_id")
      .notNull()
      .references(() => scopeCorrespondence.id),
    appAId: uuid("app_a_id").notNull(),
    appAScopeKey: jsonb("app_a_scope_key").$type<ScopeKey>().notNull(),
    appBId: uuid("app_b_id").notNull(),
    appBScopeKey: jsonb("app_b_scope_key").$type<ScopeKey>().notNull(),
    resourcePairRef: text("resource_pair_ref").notNull(),
    establishedBy: scopeLinkEstablishedByEnum("established_by").notNull(),
    status: scopeLinkStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // list-by-correspondence + the archive-by-correspondence sweep.
    index("scope_link_correspondence_idx").on(table.scopeCorrespondenceId),
    // lookup-by-scope-key narrows by (resource pair, side app) before the jsonb match.
    index("scope_link_side_a_idx").on(table.resourcePairRef, table.appAId),
    index("scope_link_side_b_idx").on(table.resourcePairRef, table.appBId),
  ],
);

/**
 * `SyncFieldState` — one row per mapped field **on one side** of a linked record,
 * in that side's own canonical representation (`docs/architecture/data-model.md`
 * `SyncFieldState`, SD-3). Echo and conflict detection compare against these
 * per-side baselines; RL-3 **seeds** them on an identity match (agree/disagree, the
 * BE-4 seed invoked per link).
 *
 * **Keyed by (record_link_id, side, field_path)** — the SD-3 natural key and the
 * seed's upsert key — enforced by the UNIQUE index. `record_link_id` FKs
 * `record_link` `ON DELETE CASCADE`: a manual unlink (RL-5) severs the link and its
 * per-side state together. `last_synced_hash`/`last_synced_at` are **both NULL**
 * when the seed found the sides divergent for this field (no reconciled baseline —
 * the first change is then a conflict by construction); the domain refinement
 * enforces present-together / absent-together.
 */
export const syncFieldState = pgTable(
  "sync_field_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordLinkId: uuid("record_link_id")
      .notNull()
      .references(() => recordLink.id, { onDelete: "cascade" }),
    side: syncFieldStateSideEnum("side").notNull(),
    fieldPath: text("field_path").notNull(),
    // The last-reconciled baseline (this side's canonical representation). Both NULL
    // on a divergent seed — present-together / absent-together (domain refinement).
    lastSyncedHash: text("last_synced_hash"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // The latest observed value hash + timestamp for this side-field.
    observedHash: text("observed_hash").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    // The app-reported change timestamp of the latest observation; NULL when the side
    // declares no change timestamps or its ref is unconfirmed.
    observedChangeTimestamp: timestamp("observed_change_timestamp", { withTimezone: true }),
    // The mapping (direction) that produced the last write to this side; NULL until
    // this side has been written (a link-only / identity-match seed writes nothing).
    lastWrittenByMappingId: uuid("last_written_by_mapping_id"),
    status: syncFieldStateStatusEnum("status").notNull(),
  },
  (table) => [
    index("sync_field_state_record_link_id_idx").on(table.recordLinkId),
    // The SD-3 natural key + the seed's upsert key: one row per (link, side, field).
    uniqueIndex("sync_field_state_link_side_field_uq").on(
      table.recordLinkId,
      table.side,
      table.fieldPath,
    ),
  ],
);

// ── Phase-4 parked conflict (the SA-4 structured operator-resolution record) ────

/**
 * `parked_conflict` — the **structured** record of a conflict the pipeline parked for
 * a human to resolve (`docs/architecture/data-model.md`; `docs/requirements/phase-4-sync-api.md`
 * SA-4; `docs/architecture/sync-engine.md` *Conflict handling*). It closes the CF-review
 * gap: a prose `conflict` `SyncEvent` carries no addressable `(RecordLink, side, field)`
 * and no contested-value marker, so SA-4 could not reliably resolve a specific field
 * from it. One row per parked field conflict (`manual-resolve`/`withheld` — CF-3/CF-4/CF-5)
 * or per parked drifted-delete (`drifted-delete` — CF-7). The pipeline handler writes it
 * alongside the `conflict` `SyncEvent`; the operator API reads the open queue and resolves
 * a row **through the normal pipeline** (SA-4.2/4.3).
 *
 * **Data-boundary invariant (load-bearing).** Only ids/enums/paths/metadata and the two
 * contested sides' `SyncFieldState.observedHash` **at park time** are stored — **never** a
 * raw contested value, a live payload value, or credential material
 * (`docs/architecture/security.md`). There is deliberately no value column.
 *
 * `record_link_id`/`sync_rule_id`/`mapping_id` are plain `uuid` with **no FK**, exactly
 * like `audit_log`'s loose `related_*` refs and `record_link`'s app ids: a parked
 * conflict is retained for audit and must survive a later tombstone/deletion of the
 * link/rule it references.
 *
 * **Idempotent re-park (SA-4 / the CF-review requirement).** Two partial UNIQUE indexes
 * keep at most one **open** row per contested target: `(record_link_id, side, kind,
 * field_path) WHERE status = 'open' AND field_path IS NOT NULL` for a field conflict, and
 * `(record_link_id) WHERE status = 'open' AND kind = 'drifted-delete'` for a drifted
 * delete (whose `field_path` is NULL). Re-processing the same still-conflicting field
 * updates the open row's hashes rather than duplicating it; a `resolved` row leaves the
 * open set, so a later re-park opens a fresh row.
 */
export const parkedConflict = pgTable(
  "parked_conflict",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Loose refs (no FK) — retained for audit past a link/rule tombstone/deletion.
    recordLinkId: uuid("record_link_id").notNull(),
    syncRuleId: uuid("sync_rule_id").notNull(),
    mappingId: uuid("mapping_id").notNull(),
    kind: parkedConflictKindEnum("kind").notNull(),
    // The contested (target) side; the target field path for a field conflict, NULL for
    // a drifted-delete (the whole record is contested).
    side: syncFieldStateSideEnum("side").notNull(),
    fieldPath: text("field_path"),
    // The two contested sides' observedHash at park time (content hashes only, never a
    // value); NULL on a drifted-delete (the source record is gone).
    sourceObservedHash: text("source_observed_hash"),
    targetObservedHash: text("target_observed_hash"),
    status: parkedConflictStatusEnum("status").notNull(),
    // The OA-3 resolution triple — present only on a resolved row.
    resolutionChoice: parkedConflictResolutionChoiceEnum("resolution_choice"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The contested source record's native id (queue context) + a metadata note.
    sourceNativeId: text("source_native_id"),
    details: text("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The SA-4.1 queue read ("open conflicts, by link") + the by-link resolve lookup.
    index("parked_conflict_open_idx")
      .on(table.recordLinkId)
      .where(sql`${table.status} = 'open'`),
    // Idempotent re-park: one open field-conflict row per (link, side, kind, field).
    uniqueIndex("parked_conflict_open_field_uq")
      .on(table.recordLinkId, table.side, table.kind, table.fieldPath)
      .where(sql`${table.status} = 'open' AND ${table.fieldPath} IS NOT NULL`),
    // Idempotent re-park: one open drifted-delete row per link.
    uniqueIndex("parked_conflict_open_delete_uq")
      .on(table.recordLinkId)
      .where(sql`${table.status} = 'open' AND ${table.kind} = 'drifted-delete'`),
  ],
);
