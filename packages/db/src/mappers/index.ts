export {
  mapRegisteredAppRow,
  toRegisteredAppInsert,
  type RegisteredAppInsert,
  type RegisteredAppRow,
} from "./registered-app.js";
export { mapApiSpecRow, toApiSpecInsert, type ApiSpecInsert, type ApiSpecRow } from "./api-spec.js";
export {
  applyScopePathBindingPatch,
  mapResourceBinding,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ConfirmableRefPatch,
  type ResourceBindingInsert,
  type ResourceBindingRefInsert,
  type ResourceBindingRefPatch,
  type ResourceBindingRefRow,
  type ResourceBindingRow,
  type ScopePathBindingPatch,
  type SourceScopeRefPatch,
} from "./resource-binding.js";
export {
  mapCredentialMetadataRow,
  toCredentialInsert,
  type CredentialInsert,
  type CredentialMetadata,
  type CredentialMetadataRow,
} from "./credential.js";
export {
  mapEventOutboxRow,
  toEventOutboxInsert,
  type EventOutboxInsertRow,
  type EventOutboxRow,
  type OutboxInsert,
  type OutboxRecord,
} from "./event-outbox.js";
export {
  mapMappingProposalRow,
  toMappingProposalInsert,
  type MappingProposalInsert,
  type MappingProposalRow,
} from "./mapping-proposal.js";
export {
  mapMappingProposalItemRow,
  toMappingProposalItemInsert,
  type MappingProposalItemInsert,
  type MappingProposalItemRow,
} from "./mapping-proposal-item.js";
export {
  mapApprovedMappingRow,
  toApprovedMappingInsert,
  type ApprovedMappingInsert,
  type ApprovedMappingRow,
} from "./approved-mapping.js";
export {
  mapFieldMappingRow,
  toFieldMappingInsert,
  type FieldMappingInsert,
  type FieldMappingRow,
} from "./field-mapping.js";
export {
  mapOperationMappingRow,
  toOperationMappingInsert,
  type OperationMappingInsert,
  type OperationMappingRow,
} from "./operation-mapping.js";
export {
  mapParameterMappingRow,
  toParameterMappingInsert,
  type ParameterMappingInsert,
  type ParameterMappingRow,
} from "./parameter-mapping.js";
export {
  mapAuditLogRow,
  toAuditLogInsert,
  type AuditLogInsert,
  type AuditLogRow,
} from "./audit-log.js";
export {
  mapSyncRuleRow,
  toSyncRuleInsert,
  type SyncRuleInsert,
  type SyncRuleRow,
} from "./sync-rule.js";
export {
  mapRecordLinkRow,
  toRecordLinkInsert,
  type RecordLinkInsert,
  type RecordLinkRow,
} from "./record-link.js";
export {
  mapScopeCorrespondenceRow,
  toScopeCorrespondenceInsert,
  type ScopeCorrespondenceInsert,
  type ScopeCorrespondenceRow,
} from "./scope-correspondence.js";
export {
  mapScopeLinkRow,
  toScopeLinkInsert,
  type ScopeLinkInsert,
  type ScopeLinkRow,
} from "./scope-link.js";
export {
  mapSyncFieldStateRow,
  toSyncFieldStateInsert,
  type SyncFieldStateInsert,
  type SyncFieldStateRow,
} from "./sync-field-state.js";
export {
  mapParkedConflictRow,
  toParkedConflictInsert,
  type ParkedConflictInsert,
  type ParkedConflictRow,
} from "./parked-conflict.js";
export {
  mapAdapterEndpointRow,
  toAdapterEndpointInsert,
  type AdapterEndpointInsert,
  type AdapterEndpointRow,
} from "./adapter-endpoint.js";
export {
  mapAdapterBindingRow,
  toAdapterBindingInsert,
  type AdapterBindingInsert,
  type AdapterBindingRow,
} from "./adapter-binding.js";
export {
  mapGraphEdgeRow,
  toGraphEdgeInsert,
  type GraphEdgeInsert,
  type GraphEdgeRow,
} from "./graph-edge.js";
export {
  mapAdapterWriteOutcomeRow,
  mapAdapterWriteOutcomeMetadataRow,
  toAdapterWriteOutcomeInsert,
  type AdapterWriteOutcomeInsert,
  type AdapterWriteOutcomeRow,
} from "./adapter-write-outcome.js";
