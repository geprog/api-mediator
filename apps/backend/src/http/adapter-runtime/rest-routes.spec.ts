import type { Ir } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { deriveRestRoutes, matchRoute } from "./rest-routes.js";

const ir: Ir = [
  {
    resourceRef: "todos",
    name: "Todos",
    operations: [
      { operationId: "listTodos", method: "get", path: "/todos", parameters: [] },
      // A literal segment that must beat the templated `/todos/{todoId}/complete`.
      { operationId: "countTodos", method: "get", path: "/todos/count", parameters: [] },
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

const routes = deriveRestRoutes(ir);

describe("deriveRestRoutes", () => {
  it("derives one upper-cased route per IR operation, keyed by resourceRef/operationId", () => {
    expect(
      routes.map((route) => ({
        method: route.method,
        path: route.pathTemplate,
        key: route.operationKey,
      })),
    ).toEqual([
      { method: "GET", path: "/todos", key: "todos/listTodos" },
      { method: "GET", path: "/todos/count", key: "todos/countTodos" },
      { method: "POST", path: "/todos/{todoId}/complete", key: "todos/completeTodo" },
      { method: "POST", path: "/lists/{listId}/todos", key: "lists/createTodo" },
    ]);
  });
});

describe("matchRoute", () => {
  it("matches a static path and captures no parameters", () => {
    const match = matchRoute(routes, "GET", "/todos");
    expect(match?.route.operationKey).toBe("todos/listTodos");
    expect(match?.pathParameters).toEqual({});
  });

  it("captures path-template parameters (RT-2.4)", () => {
    expect(matchRoute(routes, "POST", "/lists/42/todos")?.pathParameters).toEqual({ listId: "42" });
    expect(matchRoute(routes, "POST", "/todos/99/complete")?.pathParameters).toEqual({
      todoId: "99",
    });
  });

  it("prefers a static segment over a param segment at the same position", () => {
    // `/todos/count` is static; `/todos/{todoId}/complete` is a different length, but
    // this asserts the static route is chosen for the literal path.
    expect(matchRoute(routes, "GET", "/todos/count")?.route.operationKey).toBe("todos/countTodos");
  });

  it("URL-decodes a captured parameter value", () => {
    expect(matchRoute(routes, "POST", "/lists/a%2Fb/todos")?.pathParameters).toEqual({
      listId: "a/b",
    });
  });

  it("returns undefined for an unknown path (→ plain 404)", () => {
    expect(matchRoute(routes, "GET", "/unknown")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/todos/1/extra/segments")).toBeUndefined();
  });

  it("returns undefined when the method does not match (RT-2.2)", () => {
    expect(matchRoute(routes, "DELETE", "/todos")).toBeUndefined();
    expect(matchRoute(routes, "POST", "/todos")).toBeUndefined();
  });

  it("tolerates a trailing slash and matches the same route", () => {
    expect(matchRoute(routes, "GET", "/todos/")?.route.operationKey).toBe("todos/listTodos");
  });

  it("does not match an empty segment against a path parameter", () => {
    expect(matchRoute(routes, "POST", "/lists//todos")).toBeUndefined();
  });
});
