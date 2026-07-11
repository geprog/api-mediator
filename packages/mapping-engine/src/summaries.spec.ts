import type { IrResourceGroup } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { giteaIssues, giteaSpec, makeSpec, vikunjaTasks } from "./fixtures.js";
import { buildSpecSummaryIR, inScopeResources, toResourceSummary } from "./summaries.js";

describe("inScopeResources — analysisExclusions (CE-4)", () => {
  it("returns every resource group when exclusions are empty (the default)", () => {
    expect(inScopeResources(giteaSpec).map((g) => g.resourceRef)).toEqual(["issues", "milestones"]);
  });

  it("removes an excluded resource group from scope", () => {
    const spec = makeSpec({
      id: "spec-gitea",
      appId: "app-gitea",
      role: "PROVIDER",
      parsedIR: [giteaIssues, { ...giteaIssues, resourceRef: "milestones", name: "Milestones" }],
      analysisExclusions: ["milestones"],
    });
    expect(inScopeResources(spec).map((g) => g.resourceRef)).toEqual(["issues"]);
  });

  it("ignores a stale exclusion ref that resolves to no group (excludes nothing)", () => {
    const spec = makeSpec({
      id: "spec-gitea",
      appId: "app-gitea",
      role: "PROVIDER",
      parsedIR: [giteaIssues],
      analysisExclusions: ["gone"],
    });
    expect(inScopeResources(spec).map((g) => g.resourceRef)).toEqual(["issues"]);
  });
});

describe("toResourceSummary / buildSpecSummaryIR (stage-1 input)", () => {
  it("summarizes a group to metadata only (name, op summaries, distinct fields)", () => {
    expect(toResourceSummary(giteaIssues)).toEqual({
      resourceRef: "issues",
      name: "Issues",
      operationSummaries: ["List a repository's issues", "Create an issue"],
      topLevelFields: ["id", "title", "body", "state"],
    });
  });

  it("falls back to METHOD PATH when an operation has no summary", () => {
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations: [{ operationId: "op", method: "get", path: "/r", parameters: [] }],
      schemas: [],
      crossResourceRefs: [],
    };
    expect(toResourceSummary(group).operationSummaries).toEqual(["GET /r"]);
  });

  it("de-duplicates top-level field names across a group's schemas", () => {
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations: [],
      schemas: [
        { name: "A", fields: [{ name: "id", type: "integer", required: true }] },
        {
          name: "B",
          fields: [
            { name: "id", type: "integer", required: true },
            { name: "title", type: "string", required: true },
          ],
        },
      ],
      crossResourceRefs: [],
    };
    expect(toResourceSummary(group).topLevelFields).toEqual(["id", "title"]);
  });

  it("builds a spec summary IR over the in-scope groups only", () => {
    const summary = buildSpecSummaryIR([vikunjaTasks]);
    expect(summary.map((s) => s.resourceRef)).toEqual(["tasks"]);
  });
});
