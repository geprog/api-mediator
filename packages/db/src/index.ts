/**
 * `@mediator/db` — the mediator database layer: a typed Drizzle instance over
 * the compose Postgres, a transaction helper, the migration runner, the Phase-1
 * schema, and repositories that accept/return `@mediator/domain` types through
 * explicit mappers (Drizzle's inferred optionality stays inside this package).
 */
export { closeDb, createDb, tx } from "./client.js";
export type { Database, DbHandle, DbTransaction, TransactionScope } from "./client.js";
export { InvalidDatabaseUrlError, MissingDatabaseUrlError, resolveDatabaseUrl } from "./env.js";
export { MIGRATIONS_FOLDER, runMigrations } from "./migrate.js";

// Schema (tables, pg enums, ref-kind vocabulary).
export {
  RESOURCE_BINDING_REF_KINDS,
  apiSpec,
  apiSpecRoleEnum,
  apiSpecStatusEnum,
  credential,
  credentialTypeEnum,
  eventOutbox,
  processedEvent,
  registeredApp,
  registeredAppStatusEnum,
  resourceBinding,
  resourceBindingRef,
  resourceBindingRefKindEnum,
  type ResourceBindingRefKind,
} from "./schema.js";

// Mappers + their domain-facing types (row/insert types stay internal to the
// mapper modules but the projection/patch types are part of the repo surface).
export {
  mapApiSpecRow,
  mapCredentialMetadataRow,
  mapEventOutboxRow,
  mapRegisteredAppRow,
  mapResourceBinding,
  toApiSpecInsert,
  toCredentialInsert,
  toEventOutboxInsert,
  toRegisteredAppInsert,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ConfirmableRefPatch,
  type CredentialMetadata,
  type OutboxInsert,
  type OutboxRecord,
  type ResourceBindingRefPatch,
} from "./mappers/index.js";

// Repositories.
export {
  ApiSpecRepository,
  CredentialRepository,
  EventOutboxRepository,
  ProcessedEventRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  type OutboxOps,
  type ProcessedEventOps,
} from "./repositories/index.js";
