import type { IrResourceGroup } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { giteaIssues, giteaSpec, makeSpec, vikunjaTasks } from "./fixtures.js";
import {
  buildSpecSummaryIR,
  inScopeResources,
  MAX_OPERATION_SUMMARIES,
  MAX_TOP_LEVEL_FIELDS,
  toResourceSummary,
} from "./summaries.js";

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

  it("falls back to METHOD PATH when an operation has no summary or description", () => {
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations: [{ operationId: "op", method: "get", path: "/r", parameters: [] }],
      schemas: [],
      crossResourceRefs: [],
    };
    expect(toResourceSummary(group).operationSummaries).toEqual(["GET /r"]);
  });

  it("uses the operation description when it has no summary", () => {
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations: [
        {
          operationId: "op",
          method: "get",
          path: "/r",
          description: "Read one thing",
          parameters: [],
        },
      ],
      schemas: [],
      crossResourceRefs: [],
    };
    expect(toResourceSummary(group).operationSummaries).toEqual(["Read one thing"]);
  });

  it("bounds a large group to the operation-summary and field caps", () => {
    const operations = Array.from({ length: 60 }, (_, i) => ({
      operationId: `op${String(i)}`,
      method: "get" as const,
      path: `/r/${String(i)}`,
      summary: `Operation ${String(i)}`,
      parameters: [],
    }));
    const fields = Array.from({ length: 100 }, (_, i) => ({
      name: `field${String(i)}`,
      type: "string" as const,
      required: false,
    }));
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations,
      schemas: [{ name: "Big", fields }],
      crossResourceRefs: [],
    };

    const summary = toResourceSummary(group);
    expect(summary.operationSummaries.length).toBe(MAX_OPERATION_SUMMARIES);
    expect(summary.operationSummaries.length).toBeLessThanOrEqual(10);
    expect(summary.topLevelFields.length).toBe(MAX_TOP_LEVEL_FIELDS);
    expect(summary.topLevelFields.length).toBeLessThanOrEqual(30);
  });

  it("collapses duplicate operation summaries to distinct entries", () => {
    const operations = Array.from({ length: 60 }, (_, i) => ({
      operationId: `op${String(i)}`,
      method: "get" as const,
      path: `/r/${String(i)}`,
      summary: "List things",
      parameters: [],
    }));
    const group: IrResourceGroup = {
      resourceRef: "r",
      name: "R",
      operations,
      schemas: [],
      crossResourceRefs: [],
    };
    expect(toResourceSummary(group).operationSummaries).toEqual(["List things"]);
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
