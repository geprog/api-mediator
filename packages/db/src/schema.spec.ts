import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  apiSpecRoleSchema,
  apiSpecStatusSchema,
  approvedMappingStatusSchema,
  auditLogStatusSchema,
  auditLogTypeSchema,
  backfillModeSchema,
  backfillStatusSchema,
  conflictPolicySchema,
  credentialTypeSchema,
  deletePropagationSchema,
  graphEdgeTypeSchema,
  mappingDecisionSchema,
  mappingPhaseSchema,
  mappingProposalItemKindSchema,
  mappingProposalStatusSchema,
  mappingVariantSchema,
  operationActionSchema,
  parkedConflictKindSchema,
  parkedConflictResolutionChoiceSchema,
  parkedConflictStatusSchema,
  recordLinkEstablishedBySchema,
  recordLinkStatusSchema,
  registeredAppStatusSchema,
  reviewStateSchema,
  scopeLinkEstablishedBySchema,
  scopeLinkStatusSchema,
  syncFieldStateSideSchema,
  syncFieldStateStatusSchema,
  syncRuleStatusSchema,
  targetDriftCheckSchema,
  tombstoneReasonSchema,
  transformKindSchema,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  RESOURCE_BINDING_REF_KINDS,
  adapterBindingRoleEnum,
  adapterBindingStatusEnum,
  adapterEndpointStatusEnum,
  apiSpecRoleEnum,
  apiSpecStatusEnum,
  approvedMappingStatusEnum,
  auditLogStatusEnum,
  auditLogTypeEnum,
  backfillModeEnum,
  backfillStatusEnum,
  conflictPolicyEnum,
  credentialTypeEnum,
  deletePropagationEnum,
  graphEdgeTypeEnum,
  mappingDecisionEnum,
  mappingPhaseEnum,
  mappingProposalItemKindEnum,
  mappingProposalStatusEnum,
  mappingVariantEnum,
  operationActionEnum,
  parkedConflictKindEnum,
  parkedConflictResolutionChoiceEnum,
  parkedConflictStatusEnum,
  recordLinkEstablishedByEnum,
  recordLinkStatusEnum,
  recordLinkTombstoneReasonEnum,
  registeredAppStatusEnum,
  reviewStateEnum,
  scopeLinkEstablishedByEnum,
  scopeLinkStatusEnum,
  syncFieldStateSideEnum,
  syncFieldStateStatusEnum,
  syncRuleStatusEnum,
  targetDriftCheckEnum,
  transformKindEnum,
} from "./schema.js";

/**
 * The pg enums must list EXACTLY their `@mediator/domain` union's values — the
 * `satisfies` in `schema.ts` catches a bad/renamed literal at compile time, but
 * only a runtime set-comparison catches a *missing* value (a column that can't
 * hold a value the domain permits).
 */
describe("pg enum ↔ domain parity", () => {
  const cases: ReadonlyArray<[string, readonly string[], readonly string[]]> = [
    [
      "registered_app_status",
      registeredAppStatusEnum.enumValues,
      registeredAppStatusSchema.options,
    ],
    ["api_spec_role", apiSpecRoleEnum.enumValues, apiSpecRoleSchema.options],
    ["api_spec_status", apiSpecStatusEnum.enumValues, apiSpecStatusSchema.options],
    ["credential_type", credentialTypeEnum.enumValues, credentialTypeSchema.options],
    [
      "mapping_proposal_status",
      mappingProposalStatusEnum.enumValues,
      mappingProposalStatusSchema.options,
    ],
    [
      "mapping_proposal_item_kind",
      mappingProposalItemKindEnum.enumValues,
      mappingProposalItemKindSchema.options,
    ],
    ["review_state", reviewStateEnum.enumValues, reviewStateSchema.options],
    ["mapping_phase", mappingPhaseEnum.enumValues, mappingPhaseSchema.options],
    ["mapping_variant", mappingVariantEnum.enumValues, mappingVariantSchema.options],
    ["transform_kind", transformKindEnum.enumValues, transformKindSchema.options],
    ["conflict_policy", conflictPolicyEnum.enumValues, conflictPolicySchema.options],
    ["operation_action", operationActionEnum.enumValues, operationActionSchema.options],
    [
      "approved_mapping_status",
      approvedMappingStatusEnum.enumValues,
      approvedMappingStatusSchema.options,
    ],
    ["audit_log_type", auditLogTypeEnum.enumValues, auditLogTypeSchema.options],
    ["audit_log_status", auditLogStatusEnum.enumValues, auditLogStatusSchema.options],
    ["mapping_decision", mappingDecisionEnum.enumValues, mappingDecisionSchema.options],
    ["sync_rule_status", syncRuleStatusEnum.enumValues, syncRuleStatusSchema.options],
    [
      "adapter_endpoint_status",
      adapterEndpointStatusEnum.enumValues,
      adapterEndpointStatusSchema.options,
    ],
    ["adapter_binding_role", adapterBindingRoleEnum.enumValues, adapterBindingRoleSchema.options],
    [
      "adapter_binding_status",
      adapterBindingStatusEnum.enumValues,
      adapterBindingStatusSchema.options,
    ],
    ["graph_edge_type", graphEdgeTypeEnum.enumValues, graphEdgeTypeSchema.options],
    [
      "record_link_established_by",
      recordLinkEstablishedByEnum.enumValues,
      recordLinkEstablishedBySchema.options,
    ],
    ["record_link_status", recordLinkStatusEnum.enumValues, recordLinkStatusSchema.options],
    [
      "record_link_tombstone_reason",
      recordLinkTombstoneReasonEnum.enumValues,
      tombstoneReasonSchema.options,
    ],
    ["sync_field_state_side", syncFieldStateSideEnum.enumValues, syncFieldStateSideSchema.options],
    [
      "sync_field_state_status",
      syncFieldStateStatusEnum.enumValues,
      syncFieldStateStatusSchema.options,
    ],
    ["delete_propagation", deletePropagationEnum.enumValues, deletePropagationSchema.options],
    ["target_drift_check", targetDriftCheckEnum.enumValues, targetDriftCheckSchema.options],
    ["backfill_mode", backfillModeEnum.enumValues, backfillModeSchema.options],
    ["backfill_status", backfillStatusEnum.enumValues, backfillStatusSchema.options],
    ["parked_conflict_kind", parkedConflictKindEnum.enumValues, parkedConflictKindSchema.options],
    [
      "parked_conflict_status",
      parkedConflictStatusEnum.enumValues,
      parkedConflictStatusSchema.options,
    ],
    [
      "parked_conflict_resolution_choice",
      parkedConflictResolutionChoiceEnum.enumValues,
      parkedConflictResolutionChoiceSchema.options,
    ],
    [
      "scope_link_established_by",
      scopeLinkEstablishedByEnum.enumValues,
      scopeLinkEstablishedBySchema.options,
    ],
    ["scope_link_status", scopeLinkStatusEnum.enumValues, scopeLinkStatusSchema.options],
  ];

  it.each(cases)("%s lists exactly the domain values", (_name, pgValues, domainValues) => {
    expect([...pgValues].sort()).toStrictEqual([...domainValues].sort());
  });

  it("resource_binding_ref_kind covers the six confirmable refs", () => {
    expect([...RESOURCE_BINDING_REF_KINDS].sort()).toStrictEqual([
      "changeTimestampRef",
      "collectionReadRef",
      "deltaCursorRef",
      "deltaDeletionRef",
      "nativeIdRef",
      "paginationRef",
    ]);
  });
});
