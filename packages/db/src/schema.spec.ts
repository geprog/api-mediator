import {
  adapterBindingRoleSchema,
  adapterBindingStatusSchema,
  adapterEndpointStatusSchema,
  apiSpecRoleSchema,
  apiSpecStatusSchema,
  approvedMappingStatusSchema,
  auditLogStatusSchema,
  auditLogTypeSchema,
  conflictPolicySchema,
  credentialTypeSchema,
  graphEdgeTypeSchema,
  mappingDecisionSchema,
  mappingPhaseSchema,
  mappingProposalItemKindSchema,
  mappingProposalStatusSchema,
  mappingVariantSchema,
  operationActionSchema,
  registeredAppStatusSchema,
  reviewStateSchema,
  syncRuleStatusSchema,
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
  conflictPolicyEnum,
  credentialTypeEnum,
  graphEdgeTypeEnum,
  mappingDecisionEnum,
  mappingPhaseEnum,
  mappingProposalItemKindEnum,
  mappingProposalStatusEnum,
  mappingVariantEnum,
  operationActionEnum,
  registeredAppStatusEnum,
  reviewStateEnum,
  syncRuleStatusEnum,
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
