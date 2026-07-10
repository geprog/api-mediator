import { sql } from "drizzle-orm";
import {
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
  Ir,
  IrRefTarget,
  RegisteredAppStatus,
  ResourceBinding,
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
