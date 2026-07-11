import type { ApiSpec, IrOperation, IrResourceGroup } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  buildOperationRefLookup,
  fieldRoot,
  operationRefKey,
  parameterName,
  resolveResourceRef,
} from "./align.js";
import { parseOperationRef } from "./ground-truth.js";

function op(operationId: string, method: IrOperation["method"], path: string): IrOperation {
  return { operationId, method, path, parameters: [] };
}

function group(resourceRef: string, operations: IrOperation[]): IrResourceGroup {
  return { resourceRef, name: resourceRef, operations, schemas: [], crossResourceRefs: [] };
}

function specOf(parsedIR: IrResourceGroup[]): ApiSpec {
  return {
    id: "spec",
    appId: "app",
    role: "PROVIDER",
    rawDocument: {},
    parsedIR,
    analysisExclusions: [],
    version: 1,
    contentHash: "h",
    status: "active",
    createdAt: new Date(0),
  };
}

describe("resolveResourceRef", () => {
  // A coarse IR group `issue` owns issues, labels AND milestones operations —
  // the real scenario-1 grouping the harness must align through.
  const spec = specOf([
    group("issue", [
      op("listIssues", "get", "/repos/{owner}/{repo}/issues"),
      op("listLabels", "get", "/repos/{owner}/{repo}/labels"),
    ]),
    group("project", [op("listProjects", "get", "/projects")]),
  ]);

  it("aligns a ground-truth resource to the IR group owning its operations", () => {
    const ref = parseOperationRef("GET /repos/{owner}/{repo}/labels");
    expect(ref).not.toBeNull();
    // Labels' operations live in the coarse `issue` group.
    expect(resolveResourceRef(spec, ref === null ? [] : [ref], "labels")).toBe("issue");
  });

  it("falls back to a normalized name match when a resource lists no operations", () => {
    expect(resolveResourceRef(spec, [], "projects")).toBe("project");
  });

  it("returns undefined for a resource absent from the detection input", () => {
    expect(resolveResourceRef(spec, [], "buckets")).toBeUndefined();
  });
});

describe("operation identity", () => {
  it("parses a METHOD/path ref, ignoring a trailing note", () => {
    expect(parseOperationRef("GET /work-items/{itemId} (deliberately absent)")).toEqual({
      method: "GET",
      path: "/work-items/{itemId}",
    });
  });

  it("resolves a produced item's operationId back to its METHOD/path", () => {
    const spec = specOf([
      group("issue", [op("issueCreate", "post", "/repos/{owner}/{repo}/issues")]),
    ]);
    const lookup = buildOperationRefLookup(spec);
    const resolved = lookup("issue", "issueCreate");
    expect(resolved).toBeDefined();
    expect(resolved === undefined ? "" : operationRefKey(resolved)).toBe(
      "POST /repos/{owner}/{repo}/issues",
    );
  });
});

describe("field and parameter identity", () => {
  it("reduces a field path to its root name", () => {
    expect(fieldRoot("labels[].name")).toBe("labels");
    expect(fieldRoot("user.login")).toBe("user");
    expect(fieldRoot("title")).toBe("title");
  });

  it("drops the location prefix from a parameter ref", () => {
    expect(parameterName("query:page")).toBe("page");
    expect(parameterName("path:listId")).toBe("listId");
    expect(parameterName("id")).toBe("id");
  });
});
