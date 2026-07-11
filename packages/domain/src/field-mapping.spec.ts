import { describe, expect, it } from "vitest";

import { type FieldMapping, fieldMappingSchema } from "./index.js";

/** A peer-peer field mapping (no phase). */
function peerPeerField(): FieldMapping {
  return {
    id: "fm-1",
    mappingId: "am-1",
    sourcePath: "issues/title",
    targetPath: "tasks/title",
    transform: "rename",
  };
}

/** A consumer-provider field mapping (carries a phase). */
function consumerProviderField(): FieldMapping {
  return {
    id: "fm-2",
    mappingId: "am-2",
    sourcePath: "search/q",
    targetPath: "list/query",
    transform: "coerce",
    phase: "request",
  };
}

describe("FieldMapping schema — core shape", () => {
  it("accepts a peer-peer field with no phase", () => {
    expect(fieldMappingSchema.safeParse(peerPeerField()).success).toBe(true);
  });

  it("accepts a consumer-provider field carrying a phase", () => {
    expect(fieldMappingSchema.safeParse(consumerProviderField()).success).toBe(true);
  });

  it("accepts a transformConfig declaring additional input paths", () => {
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      transform: "expression",
      transformConfig: { additionalInputPaths: ["issues/firstName", "issues/lastName"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transformConfig?.additionalInputPaths).toEqual([
        "issues/firstName",
        "issues/lastName",
      ]);
    }
  });

  it("rejects an unknown transform", () => {
    const result = fieldMappingSchema.safeParse({ ...peerPeerField(), transform: "concat" });
    expect(result.success).toBe(false);
  });
});

describe("FieldMapping schema — variant-conditional fields", () => {
  it("accepts isIdentityKey + targetLookupParamRef on a peer-peer field", () => {
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      isIdentityKey: true,
      targetLookupParamRef: "filterByEmail",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a conflictPolicy on a peer-peer field", () => {
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      conflictPolicy: "manual-resolve",
    });
    expect(result.success).toBe(true);
  });

  it("rejects isIdentityKey on a consumer-provider (phase-bearing) field", () => {
    const result = fieldMappingSchema.safeParse({
      ...consumerProviderField(),
      isIdentityKey: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a present isIdentityKey = false on a consumer-provider field", () => {
    // Peer-peer only means *absent* on a consumer-provider row, even for `false`.
    const result = fieldMappingSchema.safeParse({
      ...consumerProviderField(),
      isIdentityKey: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects targetLookupParamRef on a consumer-provider field", () => {
    const result = fieldMappingSchema.safeParse({
      ...consumerProviderField(),
      // isIdentityKey cannot exist here either, so a lookup ref is doubly invalid.
      targetLookupParamRef: "filter",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a conflictPolicy on a consumer-provider field", () => {
    const result = fieldMappingSchema.safeParse({
      ...consumerProviderField(),
      conflictPolicy: "manual-resolve",
    });
    expect(result.success).toBe(false);
  });
});

describe("FieldMapping schema — identity key restrictions", () => {
  it("accepts an identity field carrying transform = rename", () => {
    const result = fieldMappingSchema.safeParse({ ...peerPeerField(), isIdentityKey: true });
    expect(result.success).toBe(true);
  });

  it("rejects an identity field carrying a non-rename transform", () => {
    // An identity key may carry only the value-preserving `rename` (AM-3.4).
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      isIdentityKey: true,
      transform: "coerce",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a non-identity peer-peer field with a non-rename transform", () => {
    // The rename-only restriction binds only identity fields.
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      transform: "coerce",
      isIdentityKey: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a targetLookupParamRef without isIdentityKey = true", () => {
    const result = fieldMappingSchema.safeParse({
      ...peerPeerField(),
      targetLookupParamRef: "filter",
    });
    expect(result.success).toBe(false);
  });
});
