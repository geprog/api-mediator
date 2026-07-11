import { sql } from "drizzle-orm";
import {
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
} from "drizzle-orm/pg-core";

import type {
  ApiSpecRole,
  ApiSpecStatus,
  AppCapabilities,
  ConfirmableRef,
  CredentialType,
  GeneratedBy,
  Ir,
  IrRefTarget,
  MappingPhase,
  MappingProposalItemKind,
  MappingProposalStatus,
  ProposalElementRef,
  ProposalItemAlternative,
  RegisteredAppStatus,
  ResourceBinding,
  ReviewState,
  ShortlistResult,
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
