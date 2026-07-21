import type { AdapterRequest } from "@mediator/adapter-engine";
import type { AdapterEndpoint } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  resolvePostMergeFilters,
  resolvePostMergePage,
  resolvePostMergeSort,
} from "./union-request.js";

function endpoint(overrides: Partial<AdapterEndpoint> = {}): AdapterEndpoint {
  return {
    id: "e1",
    consumerAppId: "consumer",
    consumerOperationId: "todos/listTodos",
    status: "active",
    aggregationStrategy: "collection-union",
    ...overrides,
  };
}

function request(query: Record<string, string>): AdapterRequest {
  return {
    consumerAppId: "consumer",
    operationKey: "todos/listTodos",
    pathParameters: {},
    query,
    headers: {},
    body: undefined,
  };
}

const now = new Date();

describe("resolvePostMergeFilters — AG-4.2", () => {
  const ep = endpoint({
    postMergeFilters: [
      {
        consumerParamRef: "todos/listTodos#status",
        consumerFieldPath: "todos/state",
        operator: "eq",
      },
    ],
  });

  it("binds a supplied filter parameter to its consumer field + value", () => {
    expect(resolvePostMergeFilters(ep, request({ status: "open" }))).toEqual([
      { fieldName: "state", operator: "eq", value: "open" },
    ]);
  });

  it("an unsupplied filter parameter yields no filter", () => {
    expect(resolvePostMergeFilters(ep, request({}))).toEqual([]);
  });
});

describe("resolvePostMergeSort — AG-4.3", () => {
  const ep = endpoint({
    postMergeSorts: [
      {
        consumerParamRef: "todos/listTodos#sort",
        paramValue: "title",
        consumerFieldPath: "todos/title",
        direction: "asc",
      },
      {
        consumerParamRef: "todos/listTodos#sort",
        paramValue: "created",
        consumerFieldPath: "todos/createdAt",
        direction: "desc",
      },
    ],
  });

  it("selects the entry matching the supplied value-driven sort value", () => {
    expect(resolvePostMergeSort(ep, request({ sort: "title" }))).toEqual({
      fieldName: "title",
      direction: "asc",
    });
    expect(resolvePostMergeSort(ep, request({ sort: "created" }))).toEqual({
      fieldName: "createdAt",
      direction: "desc",
    });
  });

  it("an unmatched / unsupplied sort value yields no sort", () => {
    expect(resolvePostMergeSort(ep, request({ sort: "unknown" }))).toBeUndefined();
    expect(resolvePostMergeSort(ep, request({}))).toBeUndefined();
  });

  it("a fixed sort parameter (no paramValue) matches on mere presence", () => {
    const fixed = endpoint({
      postMergeSorts: [
        {
          consumerParamRef: "todos/listTodos#sort",
          consumerFieldPath: "todos/title",
          direction: "asc",
        },
      ],
    });
    expect(resolvePostMergeSort(fixed, request({ sort: "anything" }))).toEqual({
      fieldName: "title",
      direction: "asc",
    });
  });
});

describe("resolvePostMergePage — AG-4.3", () => {
  it("computes an offset window from a confirmed page-number convention", () => {
    const ep = endpoint({
      postMergePagination: {
        convention: {
          convention: "page-number",
          pageParamRef: "todos/listTodos#page",
          sizeParamRef: "todos/listTodos#size",
          firstPageNumber: 1,
        },
        confirmedBy: "op",
        confirmedAt: now,
      },
    });
    // page 3, size 10, first page 1 → offset (3-1)*10 = 20, limit 10.
    expect(resolvePostMergePage(ep, request({ page: "3", size: "10" }))).toEqual({
      offset: 20,
      limit: 10,
    });
    // Missing page defaults to the first page (offset 0).
    expect(resolvePostMergePage(ep, request({ size: "10" }))).toEqual({ offset: 0, limit: 10 });
    // Missing size → no window computed.
    expect(resolvePostMergePage(ep, request({ page: "3" }))).toBeUndefined();
  });

  it("computes an offset window from a confirmed offset convention", () => {
    const ep = endpoint({
      postMergePagination: {
        convention: {
          convention: "offset",
          offsetParamRef: "todos/listTodos#offset",
          sizeParamRef: "todos/listTodos#limit",
        },
        confirmedBy: "op",
        confirmedAt: now,
      },
    });
    expect(resolvePostMergePage(ep, request({ offset: "5", limit: "25" }))).toEqual({
      offset: 5,
      limit: 25,
    });
  });

  it("an UNCONFIRMED pagination convention is not honored (no window)", () => {
    const ep = endpoint({
      postMergePagination: {
        convention: {
          convention: "page-number",
          pageParamRef: "todos/listTodos#page",
          sizeParamRef: "todos/listTodos#size",
          firstPageNumber: 1,
        },
        confirmedBy: null,
        confirmedAt: null,
      },
    });
    expect(resolvePostMergePage(ep, request({ page: "1", size: "10" }))).toBeUndefined();
  });
});
