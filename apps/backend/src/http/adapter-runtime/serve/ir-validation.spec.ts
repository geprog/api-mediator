import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation, IrParameter, IrSchema } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  validateAgainstSchema,
  validateConsumerResponse,
  validateInboundRequest,
  type UnionServeConfig,
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
    const result = validateInboundRequest(op, request(), new Set(["todoId"]), new Set());
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
      new Set(),
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
      new Set(),
    );
    expect(result).toEqual({
      ok: false,
      reason: "unmapped-consumer-input",
      detail: "consumer parameter 'assignee' has no configured mapping to a backend",
    });
  });

  it("CO-5.4: an acknowledged-ignored unmapped parameter is served (dropped), not rejected", () => {
    const filterOp = operation({
      parameters: [
        param({ name: "todoId", location: "path", required: true }),
        param({ name: "assignee", location: "query" }),
      ],
    });
    // `assignee` is supplied and mapped by no binding, but the composer acknowledged it —
    // so it is served with the value dropped, not rejected as unmapped-consumer-input.
    const result = validateInboundRequest(
      filterOp,
      request({ pathParameters: { todoId: "42" }, query: { assignee: "sam" } }),
      new Set(["todoId"]),
      new Set(["assignee"]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("CO-5.4: acknowledging one unmapped parameter does not serve a different unmapped one", () => {
    const filterOp = operation({
      parameters: [
        param({ name: "todoId", location: "path", required: true }),
        param({ name: "assignee", location: "query" }),
        param({ name: "label", location: "query" }),
      ],
    });
    // `assignee` acknowledged, `label` not → `label` still rejects loud (RP-2.4).
    const result = validateInboundRequest(
      filterOp,
      request({
        pathParameters: { todoId: "42" },
        query: { assignee: "sam", label: "urgent" },
      }),
      new Set(["todoId"]),
      new Set(["assignee"]),
    );
    expect(result).toEqual({
      ok: false,
      reason: "unmapped-consumer-input",
      detail: "consumer parameter 'label' has no configured mapping to a backend",
    });
  });

  it("RP-2.5: an omitted optional mapped parameter is accepted (absence is not an error)", () => {
    const optionalOp = operation({
      parameters: [param({ name: "cursor", location: "query", required: false })],
    });
    const result = validateInboundRequest(optionalOp, request(), new Set(["cursor"]), new Set());
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
    expect(validateInboundRequest(writeOp, request({ body: {} }), new Set(), new Set()).ok).toBe(
      false,
    );
    expect(
      validateInboundRequest(writeOp, request({ body: { title: "x" } }), new Set(), new Set()),
    ).toEqual({
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

describe("validateInboundRequest — RP-2.2/2.3 union parameters (CO-3↔RP-2 contract)", () => {
  // A collection-union list operation with a filter, a sort, and a pagination parameter.
  const unionOp = operation({
    operationId: "listTodos",
    path: "/todos",
    parameters: [
      param({ name: "status", location: "query" }),
      param({ name: "sort", location: "query" }),
      param({ name: "page", location: "query" }),
    ],
  });

  function unionConfig(overrides: Partial<UnionServeConfig> = {}): UnionServeConfig {
    return {
      pushdownEligibleParamNames: new Set<string>(),
      postMergeFilterParamNames: new Set<string>(),
      paginationParamNames: new Set<string>(),
      sortConfigByParam: new Map(),
      ...overrides,
    };
  }

  it("rejects a supplied sort parameter with no configured postMergeSorts (distinct cause)", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { sort: "title" } }),
      // `sort` IS mapped (so it is not an unmapped-consumer-input) — sort is still never
      // pushed down, so without post-merge semantics it must reject.
      new Set(["sort"]),
      new Set(),
      unionConfig(),
    );
    expect(result).toMatchObject({ ok: false, reason: "union-parameter-unconfigured" });
  });

  it("passes RP-2 for a sort parameter with a matching postMergeSorts value", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { sort: "title" } }),
      new Set(["sort"]),
      new Set(),
      unionConfig({
        sortConfigByParam: new Map([["sort", { fixed: false, values: new Set(["title"]) }]]),
      }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a sort value not among the configured accepted values", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { sort: "priority" } }),
      new Set(["sort"]),
      new Set(),
      unionConfig({
        sortConfigByParam: new Map([["sort", { fixed: false, values: new Set(["title"]) }]]),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "union-parameter-unconfigured" });
  });

  it("rejects a supplied pagination parameter with no confirmed postMergePagination", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { page: "2" } }),
      new Set(["page"]),
      new Set(),
      unionConfig(),
    );
    expect(result).toMatchObject({ ok: false, reason: "union-parameter-unconfigured" });
  });

  it("passes RP-2 for a pagination parameter named by the confirmed convention", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { page: "2" } }),
      new Set(["page"]),
      new Set(),
      unionConfig({ paginationParamNames: new Set(["page"]) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a filter mapped in some but not every binding (not pushdown-eligible, no postMergeFilters)", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { status: "open" } }),
      // `status` is in the union of mapped params (mapped in SOME binding) so it is not
      // unmapped-consumer-input; but not pushdown-eligible → union-parameter-unconfigured.
      new Set(["status"]),
      new Set(),
      unionConfig(),
    );
    expect(result).toMatchObject({ ok: false, reason: "union-parameter-unconfigured" });
  });

  it("passes RP-2 for a pushdown-eligible filter (mapped in every binding)", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { status: "open" } }),
      new Set(["status"]),
      new Set(),
      unionConfig({ pushdownEligibleParamNames: new Set(["status"]) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("passes RP-2 for a filter covered by a postMergeFilters entry", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { status: "open" } }),
      new Set(["status"]),
      new Set(),
      unionConfig({ postMergeFilterParamNames: new Set(["status"]) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("leaves a non-union endpoint entirely unaffected (no unionConfig → the sort passes)", () => {
    const result = validateInboundRequest(
      unionOp,
      request({ query: { sort: "title" } }),
      new Set(["sort"]),
      new Set(),
      // no unionConfig
    );
    expect(result).toEqual({ ok: true });
  });
});
