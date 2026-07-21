import type { AdapterRequest } from "@mediator/adapter-engine";
import type { IrOperation, IrParameter } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  declaredIdempotencyKeyValue,
  resolveAdapterWriteIdempotencyKey,
} from "./idempotency-key.js";

function param(
  overrides: Partial<IrParameter> & Pick<IrParameter, "name" | "location">,
): IrParameter {
  return { required: false, ...overrides };
}

/** POST /todos with no declared idempotency-key parameter (the derived-key case). */
const createTodo: IrOperation = {
  operationId: "createTodo",
  method: "post",
  path: "/todos",
  parameters: [],
  requestSchema: { name: "NewTodo", fields: [{ name: "title", type: "string", required: true }] },
};

/** PUT /todos/{todoId} whose consumer spec declares an `Idempotency-Key` header (the passthrough case). */
const putTodoWithKey: IrOperation = {
  operationId: "putTodo",
  method: "put",
  path: "/todos/{todoId}",
  parameters: [
    param({ name: "todoId", location: "path", required: true }),
    param({ name: "Idempotency-Key", location: "header", required: false }),
  ],
};

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    consumerAppId: "consumer-app",
    operationKey: "todos/createTodo",
    pathParameters: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

describe("resolveAdapterWriteIdempotencyKey — WR-3.2 derived key", () => {
  it("derives the SAME key for two byte-identical write requests (one delivery)", () => {
    const first = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it" } }),
    });
    const second = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it" } }),
    });
    expect(first.source).toBe("derived");
    expect(first.key).toBe(second.key);
  });

  it("object key order in the body does not change the derived key (canonical JSON)", () => {
    const a = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it", done: false } }),
    });
    const b = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { done: false, title: "Ship it" } }),
    });
    expect(a.key).toBe(b.key);
  });

  it("a DIFFERENT body is a different delivery — a different derived key", () => {
    const a = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it" } }),
    });
    const b = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it later" } }),
    });
    expect(a.key).not.toBe(b.key);
  });

  it("the same request under a different endpoint or binding yields a different key (namespaced)", () => {
    const base = {
      consumerOperation: createTodo,
      request: request({ body: { title: "Ship it" } }),
    };
    const ep1 = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      ...base,
    });
    const ep2 = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-2",
      bindingId: "b-1",
      ...base,
    });
    const b2 = resolveAdapterWriteIdempotencyKey({ endpointId: "ep-1", bindingId: "b-2", ...base });
    expect(ep1.key).not.toBe(ep2.key);
    expect(ep1.key).not.toBe(b2.key);
  });
});

describe("resolveAdapterWriteIdempotencyKey — WR-3.1 declared passthrough", () => {
  it("keys on the caller-supplied declared value, independent of the body", () => {
    const withBodyA = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: putTodoWithKey,
      request: request({
        pathParameters: { todoId: "42" },
        headers: { "idempotency-key": "caller-abc" },
        body: { title: "one" },
      }),
    });
    const withBodyB = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: putTodoWithKey,
      request: request({
        pathParameters: { todoId: "42" },
        headers: { "idempotency-key": "caller-abc" },
        body: { title: "two — a different body" },
      }),
    });
    expect(withBodyA.source).toBe("declared");
    // Same declared key ⇒ one delivery, even though the bodies differ (WR-3.1/3.7).
    expect(withBodyA.key).toBe(withBodyB.key);
  });

  it("a different declared value is a different delivery", () => {
    const one = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: putTodoWithKey,
      request: request({
        pathParameters: { todoId: "42" },
        headers: { "idempotency-key": "caller-abc" },
      }),
    });
    const two = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: putTodoWithKey,
      request: request({
        pathParameters: { todoId: "42" },
        headers: { "idempotency-key": "caller-xyz" },
      }),
    });
    expect(one.key).not.toBe(two.key);
  });

  it("falls back to a DERIVED key when the declared parameter is not supplied", () => {
    const resolved = resolveAdapterWriteIdempotencyKey({
      endpointId: "ep-1",
      bindingId: "b-1",
      consumerOperation: putTodoWithKey,
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(resolved.source).toBe("derived");
  });
});

describe("declaredIdempotencyKeyValue", () => {
  it("reads the supplied header value case-insensitively", () => {
    expect(
      declaredIdempotencyKeyValue(
        putTodoWithKey,
        request({ pathParameters: { todoId: "1" }, headers: { "Idempotency-Key": "abc" } }),
      ),
    ).toBe("abc");
  });

  it("is undefined when the operation declares no idempotency-key parameter", () => {
    expect(
      declaredIdempotencyKeyValue(createTodo, request({ body: { title: "x" } })),
    ).toBeUndefined();
  });

  it("is undefined when the declared parameter is not supplied or is blank", () => {
    expect(
      declaredIdempotencyKeyValue(putTodoWithKey, request({ pathParameters: { todoId: "1" } })),
    ).toBeUndefined();
    expect(
      declaredIdempotencyKeyValue(
        putTodoWithKey,
        request({ pathParameters: { todoId: "1" }, headers: { "idempotency-key": "" } }),
      ),
    ).toBeUndefined();
  });
});
