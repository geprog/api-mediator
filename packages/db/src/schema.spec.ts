import {
  apiSpecRoleSchema,
  apiSpecStatusSchema,
  credentialTypeSchema,
  mappingPhaseSchema,
  mappingProposalItemKindSchema,
  mappingProposalStatusSchema,
  registeredAppStatusSchema,
  reviewStateSchema,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  RESOURCE_BINDING_REF_KINDS,
  apiSpecRoleEnum,
  apiSpecStatusEnum,
  credentialTypeEnum,
  mappingPhaseEnum,
  mappingProposalItemKindEnum,
  mappingProposalStatusEnum,
  registeredAppStatusEnum,
  reviewStateEnum,
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
