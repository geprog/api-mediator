import type { Ir } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { deriveMountedOperations, operationKey } from "./operation-key.js";

/**
 * A three-operation consumer IR mirroring the scenario-3 `todo-widget` CONSUMER
 * spec (`/todos`, `/lists/{listId}/todos`, `/todos/{todoId}/complete`). Only the
 * protocol-neutral fields the core reads are populated with meaning; method/path
 * are present (the IR carries them) but the core must ignore them.
 */
const consumerIr: Ir = [
  {
    resourceRef: "todos",
    name: "Todos",
    operations: [
      { operationId: "listTodos", method: "get", path: "/todos", parameters: [] },
      {
        operationId: "completeTodo",
        method: "post",
        path: "/todos/{todoId}/complete",
        parameters: [{ name: "todoId", location: "path", required: true }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
  {
    resourceRef: "lists",
    name: "Lists",
    operations: [
      {
        operationId: "createTodo",
        method: "post",
        path: "/lists/{listId}/todos",
        parameters: [{ name: "listId", location: "path", required: true }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

describe("operationKey", () => {
  it("serializes to resourceRef/operationId — the same form Phase-3 stores on the endpoint", () => {
    // Must match apps/backend/src/modules/approval/refs.ts serializeRef(operation).
    expect(operationKey("todos", "listTodos")).toBe("todos/listTodos");
    expect(operationKey("search", "searchIssues")).toBe("search/searchIssues");
  });
});

describe("deriveMountedOperations", () => {
  it("enumerates every operation of every resource group (RT-2.1, no narrowing)", () => {
    const operations = deriveMountedOperations(consumerIr);

    expect(operations.map((operation) => operation.operationKey)).toEqual([
      "todos/listTodos",
      "todos/completeTodo",
      "lists/createTodo",
    ]);
  });

  it("carries the neutral resourceRef/operationId for each mounted operation", () => {
    const operations = deriveMountedOperations(consumerIr);

    expect(operations).toContainEqual({
      operationKey: "lists/createTodo",
      resourceRef: "lists",
      operationId: "createTodo",
    });
  });

  it("returns an empty surface for a spec with no operations", () => {
    const empty: Ir = [
      { resourceRef: "misc", name: "Misc", operations: [], schemas: [], crossResourceRefs: [] },
    ];
    expect(deriveMountedOperations(empty)).toEqual([]);
  });
});
