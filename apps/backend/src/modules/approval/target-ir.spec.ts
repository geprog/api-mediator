import type { Ir, IrOperation } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  deriveAction,
  deriveTargetIdParamName,
  operationHasParameter,
  refResolves,
  resolveOperation,
} from "./target-ir.js";

const IR: Ir = [
  {
    resourceRef: "tasks",
    name: "Tasks",
    operations: [
      { operationId: "listTasks", method: "get", path: "/tasks", parameters: [] },
      { operationId: "createTask", method: "post", path: "/tasks", parameters: [] },
      {
        operationId: "updateTask",
        method: "put",
        path: "/tasks/{taskId}",
        parameters: [{ name: "taskId", location: "path", required: true }],
      },
      {
        operationId: "moveTask",
        method: "patch",
        path: "/projects/{projectId}/tasks/{taskId}",
        parameters: [
          { name: "projectId", location: "path", required: true },
          { name: "taskId", location: "path", required: true },
        ],
      },
    ],
    schemas: [
      {
        name: "Task",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

function op(method: IrOperation["method"], path: string): IrOperation {
  return { operationId: "x", method, path, parameters: [] };
}

describe("deriveAction", () => {
  it("classifies POST as create", () => {
    expect(deriveAction(op("post", "/tasks"))).toBe("create");
  });
  it("classifies PUT and PATCH as update", () => {
    expect(deriveAction(op("put", "/tasks/{id}"))).toBe("update");
    expect(deriveAction(op("patch", "/tasks/{id}"))).toBe("update");
  });
  it("classifies DELETE as delete", () => {
    expect(deriveAction(op("delete", "/tasks/{id}"))).toBe("delete");
  });
  it("classifies a collection GET and a single GET both as read — never list", () => {
    expect(deriveAction(op("get", "/tasks"))).toBe("read");
    expect(deriveAction(op("get", "/tasks/{id}"))).toBe("read");
  });
});

describe("deriveTargetIdParamName", () => {
  it("returns the single path parameter's name", () => {
    const updateTask = resolveOperation(IR, "tasks", "updateTask");
    expect(updateTask && deriveTargetIdParamName(updateTask)).toBe("taskId");
  });
  it("is undefined when there is no path parameter", () => {
    const createTask = resolveOperation(IR, "tasks", "createTask");
    expect(createTask && deriveTargetIdParamName(createTask)).toBeUndefined();
  });
  it("is undefined (ambiguous) when there is more than one path parameter", () => {
    const moveTask = resolveOperation(IR, "tasks", "moveTask");
    expect(moveTask && deriveTargetIdParamName(moveTask)).toBeUndefined();
  });
});

describe("refResolves", () => {
  it("resolves a field of the resource group", () => {
    expect(
      refResolves(IR, { resourceRef: "tasks", target: { kind: "field", path: "title" } }),
    ).toBe(true);
  });
  it("does not resolve an absent field", () => {
    expect(
      refResolves(IR, { resourceRef: "tasks", target: { kind: "field", path: "ghost" } }),
    ).toBe(false);
  });
  it("resolves an operation of the resource group", () => {
    expect(
      refResolves(IR, {
        resourceRef: "tasks",
        target: { kind: "operation", operationId: "updateTask" },
      }),
    ).toBe(true);
  });
  it("does not resolve against an absent resource group", () => {
    expect(
      refResolves(IR, { resourceRef: "ghost", target: { kind: "field", path: "title" } }),
    ).toBe(false);
  });
  it("resolves a parameter of the named operation", () => {
    expect(
      refResolves(IR, {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "updateTask", parameter: "taskId" },
      }),
    ).toBe(true);
  });
  it("does not resolve a parameter absent from the operation", () => {
    expect(
      refResolves(IR, {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "updateTask", parameter: "ghost" },
      }),
    ).toBe(false);
  });
});

describe("operationHasParameter", () => {
  it("is true for a real parameter and false otherwise", () => {
    expect(operationHasParameter(IR, "tasks", "updateTask", "taskId")).toBe(true);
    expect(operationHasParameter(IR, "tasks", "updateTask", "ghost")).toBe(false);
  });
});
