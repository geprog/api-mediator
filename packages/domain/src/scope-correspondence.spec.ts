import { describe, expect, it } from "vitest";

import { type ScopeCorrespondence, scopeCorrespondenceSchema } from "./index.js";

/** A confirmed correspondence for the Gitea issues ↔ Vikunja tasks scoped pair. */
function confirmedCorrespondence(): ScopeCorrespondence {
  return {
    id: "sc-1",
    // Canonical direction-agnostic form (the two (spec lineage, resource) sides).
    resourcePairRef: "lineage-gitea:issues|lineage-vikunja:tasks",
    scopeIdentityKey: [
      { sourceScopeKey: "owner", targetFieldPath: "owner_username" },
      { sourceScopeKey: "name", targetFieldPath: "title" },
    ],
    targetContainerRef: { appId: "app-vikunja", resourceRef: "projects" },
    sourceContainerRef: { appId: "app-gitea", resourceRef: "repos" },
    confirmedBy: "operator@example.test",
    confirmedAt: new Date("2026-07-17T00:00:00.000Z"),
  };
}

describe("ScopeCorrespondence schema — core shape (SS-10 crit 1)", () => {
  it("accepts a confirmed correspondence and round-trips its fields", () => {
    const parsed = scopeCorrespondenceSchema.parse(confirmedCorrespondence());
    expect(parsed.resourcePairRef).toBe("lineage-gitea:issues|lineage-vikunja:tasks");
    expect(parsed.targetContainerRef).toStrictEqual({
      appId: "app-vikunja",
      resourceRef: "projects",
    });
    expect(parsed.scopeIdentityKey).toHaveLength(2);
  });

  it("carries exactly the SS-10 fields", () => {
    const parsed = scopeCorrespondenceSchema.parse(confirmedCorrespondence());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "id",
        "resourcePairRef",
        "scopeIdentityKey",
        "targetContainerRef",
        "sourceContainerRef",
        "confirmedBy",
        "confirmedAt",
      ].sort(),
    );
  });

  it("allows an absent sourceContainerRef (source container knowable only from records)", () => {
    const base = confirmedCorrespondence();
    const parsed = scopeCorrespondenceSchema.parse({
      id: base.id,
      resourcePairRef: base.resourcePairRef,
      scopeIdentityKey: base.scopeIdentityKey,
      targetContainerRef: base.targetContainerRef,
      confirmedBy: base.confirmedBy,
      confirmedAt: base.confirmedAt,
    });
    expect(parsed.sourceContainerRef).toBeUndefined();
    expect("sourceContainerRef" in parsed).toBe(false);
  });
});

describe("ScopeCorrespondence schema — value-preserving scopeIdentityKey (SS-10 crit 2)", () => {
  it("accepts a value-preserving pairing carrying an explicit rename transform", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      scopeIdentityKey: [
        { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "rename" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-value-preserving pairing (coerce), mirroring the identity-key rename-only rule", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      scopeIdentityKey: [
        { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "coerce" } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an aggregate/expression pairing too", () => {
    for (const kind of ["aggregate", "expression"] as const) {
      const result = scopeCorrespondenceSchema.safeParse({
        ...confirmedCorrespondence(),
        scopeIdentityKey: [
          { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind } },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects an empty scopeIdentityKey (a correspondence must pair at least one component)", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      scopeIdentityKey: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate source components in the scopeIdentityKey (they key the captured scope)", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      scopeIdentityKey: [
        { sourceScopeKey: "name", targetFieldPath: "title" },
        { sourceScopeKey: "name", targetFieldPath: "identifier" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("ScopeCorrespondence schema — confirmed-pair invariant", () => {
  it("accepts an unconfirmed correspondence (both confirmedBy and confirmedAt null)", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects confirmedBy set while confirmedAt null", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      confirmedBy: "operator@example.test",
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confirmedAt set while confirmedBy null", () => {
    const result = scopeCorrespondenceSchema.safeParse({
      ...confirmedCorrespondence(),
      confirmedBy: null,
      confirmedAt: new Date("2026-07-17T00:00:00.000Z"),
    });
    expect(result.success).toBe(false);
  });
});
