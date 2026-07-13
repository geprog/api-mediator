import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type {
  AdapterBindingRole,
  AdapterBindingStatus,
  AdapterEndpointStatus,
  ApiSpecRole,
  ApiSpecStatus,
  AppCapabilities,
  ApprovedMappingStatus,
  AuditLogType,
  ConfirmableRef,
  ConflictPolicy,
  CredentialType,
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
  ProposalElementRef,
  ProposalItemAlternative,
  RegisteredAppStatus,
  ResourceBinding,
  ReviewState,
  ShortlistResult,
  SyncRuleStatus,
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

/** The six `ResourceBinding` ref kinds, in a stable order (glossary-exact). */
export const RESOURCE_BINDING_REF_KINDS = [
  "nativeIdRef",
  "collectionReadRef",
  "paginationRef",
  "deltaCursorRef",
  "deltaDeletionRef",
  "changeTimestampRef",
] as const satisfies readonly ResourceBindingRefKey[];

/** One of the six confirmable `ResourceBinding` ref kinds. */
export type ResourceBindingRefKind = (typeof RESOURCE_BINDING_REF_KINDS)[number];

export const resourceBindingRefKindEnum = pgEnum(
  "resource_binding_ref_kind",
  RESOURCE_BINDING_REF_KINDS,
);

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

// ── Tables ───────────────────────────────────────────────────────────────────

/** `RegisteredApp` — an application in the landscape (data-model.md). */
export const registeredApp = pgTable("registered_app", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  status: registeredAppStatusEnum("status").notNull(),
  // Nullable: absent for a consumer-only app whose endpoint the mediator hosts.
  baseUrl: text("base_url"),
  capabilities: jsonb("capabilities").$type<AppCapabilities>().notNull(),
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

/** `ResourceBinding` — one resource's operational bindings for an `ApiSpec`. */
export const resourceBinding = pgTable(
  "resource_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiSpecId: uuid("api_spec_id")
      .notNull()
      .references(() => apiSpec.id),
    resourceRef: text("resource_ref").notNull(),
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
 * only payload column and it is opaque ciphertext; there is deliberately **no
 * plaintext column** and no read path that returns this column (see
 * `CredentialRepository`).
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
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "the decision history for this proposal" / "for this mapping".
    index("audit_log_related_proposal_id_idx").on(table.relatedProposalId),
    index("audit_log_related_mapping_id_idx").on(table.relatedMappingId),
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
  },
  (table) => [
    index("sync_rule_approved_mapping_id_idx").on(table.approvedMappingId),
    // Idempotent instantiation: at most one rule per (mapping, resource pair).
    uniqueIndex("sync_rule_mapping_resource_pair_uq").on(
      table.approvedMappingId,
      table.resourcePairRef,
    ),
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
 * Phase 3 creates it NON-serving: no `aggregation_strategy`/`cache_ttl`/post-merge
 * columns (Phase 5) and its `status` reflects that composition and serving are
 * deferred — `composition-required`, the enum value that means "binding(s)
 * attached, an aggregation decision is still owed before anything serves" (AI-2
 * criterion 4; the flow's single-binding "activate immediately" is overridden by
 * the phase-3 reconciliation note in the requirement — there is no Adapter Server
 * Runtime until Phase 5).
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
