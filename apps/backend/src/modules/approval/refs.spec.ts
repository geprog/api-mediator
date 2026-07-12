import { describe, expect, it } from "vitest";

import { serializeRef, serializeTargetIdParamRef } from "./refs.js";

describe("serializeRef", () => {
  it("serializes a field ref as resourceRef/path", () => {
    expect(serializeRef({ resourceRef: "issues", target: { kind: "field", path: "title" } })).toBe(
      "issues/title",
    );
  });

  it("serializes an operation ref as resourceRef/operationId", () => {
    expect(
      serializeRef({
        resourceRef: "issues",
        target: { kind: "operation", operationId: "updateIssue" },
      }),
    ).toBe("issues/updateIssue");
  });

  it("serializes a parameter ref as resourceRef/operationId#parameter", () => {
    expect(
      serializeRef({
        resourceRef: "search",
        target: { kind: "parameter", operationId: "searchIssues", parameter: "owner" },
      }),
    ).toBe("search/searchIssues#owner");
  });
});

describe("serializeTargetIdParamRef", () => {
  it("composes the target-id parameter ref", () => {
    expect(serializeTargetIdParamRef("tasks", "updateTask", "taskId")).toBe(
      "tasks/updateTask#taskId",
    );
  });
});
