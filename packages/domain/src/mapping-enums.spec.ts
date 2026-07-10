import { describe, expect, it } from "vitest";

import {
  MappingPhase,
  mappingPhaseSchema,
  MappingProposalItemKind,
  mappingProposalItemKindSchema,
  MappingProposalStatus,
  mappingProposalStatusSchema,
  MappingVariant,
  mappingVariantSchema,
  ReviewState,
  reviewStateSchema,
  TransformKind,
  transformKindSchema,
} from "./index.js";

describe("Phase-2 mapping enums", () => {
  it("expose glossary-verbatim literals as schema, union type, and const object", () => {
    expect(mappingProposalStatusSchema.options).toEqual([
      "pending",
      "partially_approved",
      "approved",
      "rejected",
      "failed",
    ]);
    expect(MappingProposalStatus).toEqual({
      pending: "pending",
      partially_approved: "partially_approved",
      approved: "approved",
      rejected: "rejected",
      failed: "failed",
    });

    expect(mappingProposalItemKindSchema.options).toEqual(["operation", "field", "parameter"]);
    expect(MappingProposalItemKind).toEqual({
      operation: "operation",
      field: "field",
      parameter: "parameter",
    });

    expect(reviewStateSchema.options).toEqual(["pending", "accepted", "edited", "rejected"]);
    expect(ReviewState).toEqual({
      pending: "pending",
      accepted: "accepted",
      edited: "edited",
      rejected: "rejected",
    });

    expect(mappingPhaseSchema.options).toEqual(["request", "response"]);
    expect(MappingPhase).toEqual({ request: "request", response: "response" });

    expect(transformKindSchema.options).toEqual(["rename", "coerce", "aggregate", "expression"]);
    expect(TransformKind).toEqual({
      rename: "rename",
      coerce: "coerce",
      aggregate: "aggregate",
      expression: "expression",
    });

    expect(mappingVariantSchema.options).toEqual(["peer-peer", "consumer-provider"]);
    expect(MappingVariant).toEqual({
      "peer-peer": "peer-peer",
      "consumer-provider": "consumer-provider",
    });
  });

  it("accepts valid values and rejects unknown ones", () => {
    expect(mappingProposalStatusSchema.safeParse("pending").success).toBe(true);
    expect(mappingProposalStatusSchema.safeParse("in_review").success).toBe(false);

    expect(mappingProposalItemKindSchema.safeParse("parameter").success).toBe(true);
    expect(mappingProposalItemKindSchema.safeParse("schema").success).toBe(false);

    expect(transformKindSchema.safeParse("rename").success).toBe(true);
    expect(transformKindSchema.safeParse("concat").success).toBe(false);

    expect(mappingVariantSchema.safeParse("peer-peer").success).toBe(true);
    // Underscore spelling is not the glossary term — the hyphenated form is.
    expect(mappingVariantSchema.safeParse("peer_peer").success).toBe(false);
  });
});
