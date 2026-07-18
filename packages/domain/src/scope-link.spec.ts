import { describe, expect, it } from "vitest";

import { type ScopeLink, scopeLinkSchema } from "./index.js";

/** A discovered container link: Gitea repo alice/phoenix ↔ Vikunja project 42. */
function identityMatchLink(): ScopeLink {
  return {
    id: "sl-1",
    scopeCorrespondenceId: "sc-1",
    appAId: "app-gitea",
    appAScopeKey: { owner: "alice", name: "phoenix" },
    appBId: "app-vikunja",
    appBScopeKey: { id: "42" },
    resourcePairRef: "lineage-gitea:issues|lineage-vikunja:tasks",
    establishedBy: "identity-match",
    status: "active",
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
  };
}

describe("ScopeLink schema — core shape (SS-10 crit 3)", () => {
  it("accepts an identity-match link and round-trips both sides' scope-key maps", () => {
    const parsed = scopeLinkSchema.parse(identityMatchLink());
    expect(parsed.appAScopeKey).toStrictEqual({ owner: "alice", name: "phoenix" });
    expect(parsed.appBScopeKey).toStrictEqual({ id: "42" });
  });

  it("carries exactly the SS-10 fields and references its apps by id only (no credential material)", () => {
    const parsed = scopeLinkSchema.parse(identityMatchLink());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "id",
        "scopeCorrespondenceId",
        "appAId",
        "appAScopeKey",
        "appBId",
        "appBScopeKey",
        "resourcePairRef",
        "establishedBy",
        "status",
        "createdAt",
      ].sort(),
    );
  });

  it("resolves the same link from either direction (direction-agnostic resourcePairRef)", () => {
    // Both directions of the bidirectional pair carry the identical canonical ref,
    // so a lookup by resourcePairRef finds the one link regardless of poll direction.
    const parsed = scopeLinkSchema.parse(identityMatchLink());
    expect(parsed.resourcePairRef).toBe("lineage-gitea:issues|lineage-vikunja:tasks");
  });
});

describe("ScopeLink schema — enums (SS-10 crit 3)", () => {
  it("accepts every establishedBy value (constant | identity-match | manual)", () => {
    for (const establishedBy of ["constant", "identity-match", "manual"] as const) {
      expect(scopeLinkSchema.safeParse({ ...identityMatchLink(), establishedBy }).success).toBe(
        true,
      );
    }
  });

  it("rejects create-propagation (ScopeLink has no create-propagation, unlike RecordLink)", () => {
    const result = scopeLinkSchema.safeParse({
      ...identityMatchLink(),
      establishedBy: "create-propagation",
    });
    expect(result.success).toBe(false);
  });

  it("accepts both status values (active | archived)", () => {
    for (const status of ["active", "archived"] as const) {
      expect(scopeLinkSchema.safeParse({ ...identityMatchLink(), status }).success).toBe(true);
    }
  });

  it("rejects tombstoned (a container correspondence is archived, never tombstoned)", () => {
    const result = scopeLinkSchema.safeParse({ ...identityMatchLink(), status: "tombstoned" });
    expect(result.success).toBe(false);
  });
});

describe("ScopeLink schema — scope-key maps", () => {
  it("rejects an empty appAScopeKey (a container always has an identity)", () => {
    const result = scopeLinkSchema.safeParse({ ...identityMatchLink(), appAScopeKey: {} });
    expect(result.success).toBe(false);
  });

  it("rejects an empty appBScopeKey", () => {
    const result = scopeLinkSchema.safeParse({ ...identityMatchLink(), appBScopeKey: {} });
    expect(result.success).toBe(false);
  });

  it("accepts a single-component scope key on each side", () => {
    const result = scopeLinkSchema.safeParse({
      ...identityMatchLink(),
      appAScopeKey: { full_name: "alice/phoenix" },
      appBScopeKey: { id: "42" },
    });
    expect(result.success).toBe(true);
  });
});
