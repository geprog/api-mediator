import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation, IrParameter, IrSchema } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  validateAgainstSchema,
  validateConsumerResponse,
  validateInboundRequest,
} from "./ir-validation.js";

function param(
  overrides: Partial<IrParameter> & Pick<IrParameter, "name" | "location">,
): IrParameter {
  return { required: false, ...overrides };
}

function operation(overrides: Partial<IrOperation> = {}): IrOperation {
  return {
    operationId: "getTodo",
    method: "get",
    path: "/todos/{todoId}",
    parameters: [],
    ...overrides,
  };
}

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    consumerAppId: "consumer-app",
    operationKey: "todos/getTodo",
    pathParameters: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

const todoSchema: IrSchema = {
  name: "Todo",
  fields: [
    { name: "id", type: "string", required: true },
    { name: "title", type: "string", required: true },
    { name: "done", type: "boolean", required: true },
  ],
};

describe("validateAgainstSchema", () => {
  it("accepts a value satisfying required fields + coarse types", () => {
    expect(validateAgainstSchema(todoSchema, { id: "1", title: "x", done: false })).toEqual([]);
  });

  it("flags a missing required field", () => {
    expect(validateAgainstSchema(todoSchema, { id: "1", title: "x" })).toContain(
      "required field 'done' is missing",
    );
  });

  it("flags a present field of the wrong coarse type", () => {
    expect(validateAgainstSchema(todoSchema, { id: "1", title: "x", done: "nope" })).toContain(
      "field 'done' should be boolean",
    );
  });

  it("rejects a non-object body", () => {
    expect(validateAgainstSchema(todoSchema, "not-an-object")).toEqual(["expected an object body"]);
  });
});

describe("validateInboundRequest — RP-2", () => {
  const op = operation({
    parameters: [param({ name: "todoId", location: "path", required: true })],
  });

  it("rejects a missing required parameter as invalid-request", () => {
    const result = validateInboundRequest(op, request(), new Set(["todoId"]));
    expect(result).toEqual({
      ok: false,
      reason: "invalid-request",
      detail: "missing required path parameter 'todoId'",
    });
  });

  it("accepts a supplied mapped parameter", () => {
    const result = validateInboundRequest(
      op,
      request({ pathParameters: { todoId: "42" } }),
      new Set(["todoId"]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("RP-2.4: rejects a supplied consumer parameter that is not mapped anywhere", () => {
    const filterOp = operation({
      parameters: [
        param({ name: "todoId", location: "path", required: true }),
        param({ name: "assignee", location: "query" }),
      ],
    });
    const result = validateInboundRequest(
      filterOp,
      request({ pathParameters: { todoId: "42" }, query: { assignee: "sam" } }),
      new Set(["todoId"]),
    );
    expect(result).toEqual({
      ok: false,
      reason: "unmapped-consumer-input",
      detail: "consumer parameter 'assignee' has no configured mapping to a backend",
    });
  });

  it("RP-2.5: an omitted optional mapped parameter is accepted (absence is not an error)", () => {
    const optionalOp = operation({
      parameters: [param({ name: "cursor", location: "query", required: false })],
    });
    const result = validateInboundRequest(optionalOp, request(), new Set(["cursor"]));
    expect(result).toEqual({ ok: true });
  });

  it("validates the request body against the consumer's own request schema", () => {
    const writeOp = operation({
      method: "post",
      parameters: [],
      requestSchema: {
        name: "NewTodo",
        fields: [{ name: "title", type: "string", required: true }],
      },
    });
    expect(validateInboundRequest(writeOp, request({ body: {} }), new Set()).ok).toBe(false);
    expect(validateInboundRequest(writeOp, request({ body: { title: "x" } }), new Set())).toEqual({
      ok: true,
    });
  });
});

describe("validateConsumerResponse — AG-7", () => {
  const op = operation({ responseSchema: todoSchema });

  it("accepts a schema-valid consumer response", () => {
    expect(validateConsumerResponse(op, { id: "1", title: "x", done: true })).toEqual({ ok: true });
  });

  it("AG-7.2: a response missing a required field fails (mediator-transform-error material)", () => {
    const result = validateConsumerResponse(op, { id: "1", title: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("done");
  });

  it("validates a collection response per row", () => {
    const rows = [
      { id: "1", title: "a", done: true },
      { id: "2", title: "b" },
    ];
    const result = validateConsumerResponse(op, rows);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("row 1");
  });

  it("accepts anything when the operation declares no response schema", () => {
    expect(validateConsumerResponse(operation(), { anything: true })).toEqual({ ok: true });
  });
});
