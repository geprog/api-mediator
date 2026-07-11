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
  DETECTION_JOB_STATUSES,
  RESOURCE_BINDING_REF_KINDS,
  apiSpec,
  apiSpecRoleEnum,
  apiSpecStatusEnum,
  credential,
  credentialTypeEnum,
  detectionJobStatusEnum,
  eventOutbox,
  mappingDetectionJob,
  mappingPhaseEnum,
  mappingProposal,
  mappingProposalItem,
  mappingProposalItemKindEnum,
  mappingProposalStatusEnum,
  processedEvent,
  registeredApp,
  registeredAppStatusEnum,
  resourceBinding,
  resourceBindingRef,
  resourceBindingRefKindEnum,
  reviewStateEnum,
  type DetectionJobStatus,
  type ResourceBindingRefKind,
} from "./schema.js";

// Mappers + their domain-facing types (row/insert types stay internal to the
// mapper modules but the projection/patch types are part of the repo surface).
export {
  mapApiSpecRow,
  mapCredentialMetadataRow,
  mapEventOutboxRow,
  mapMappingProposalItemRow,
  mapMappingProposalRow,
  mapRegisteredAppRow,
  mapResourceBinding,
  toApiSpecInsert,
  toCredentialInsert,
  toEventOutboxInsert,
  toMappingProposalInsert,
  toMappingProposalItemInsert,
  toRegisteredAppInsert,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ConfirmableRefPatch,
  type CredentialMetadata,
  type MappingProposalInsert,
  type MappingProposalItemInsert,
  type MappingProposalItemRow,
  type MappingProposalRow,
  type OutboxInsert,
  type OutboxRecord,
  type ResourceBindingRefPatch,
} from "./mappers/index.js";

// Repositories.
export {
  ApiSpecRepository,
  CredentialRepository,
  DetectionJobRepository,
  EventOutboxRepository,
  MappingProposalRepository,
  ProcessedEventRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  type ClaimedDetectionJob,
  type DetectionJob,
  type DetectionJobEnqueueOps,
  type DetectionJobWorkerOps,
  type OutboxOps,
  type ProcessedEventOps,
} from "./repositories/index.js";
