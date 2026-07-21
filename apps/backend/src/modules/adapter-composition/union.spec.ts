import type {
  IrParameter,
  PostMergeDedup,
  PostMergeFilter,
  PostMergePaginationConventionValue,
  PostMergeSort,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  classifyUnionParameter,
  deriveUnionCompositionAnalysis,
  paginationConventionParamRefs,
  pushdownEligibleParamNames,
  validateUnionConfiguration,
  type UnionBindingFacts,
  type UnionRejectionReason,
  type UnionSubmission,
} from "./union.js";

/**
 * Unit coverage for the CO-3 pure union derivation + validation: the parameter classifier,
 * dedup option validation (link-based needs every backend's confirmed nativeIdRef; `none`
 * explicit; a union must choose one), the composability preconditions (collectionReadRef +
 * paginationRef-where-paged), post-merge ref validity, the derive-then-confirm analysis
 * (unserviceable filters + unconfigured sort/pagination), and the large-collection flag.
 */

function queryParam(name: string): IrParameter {
  return { name, location: "query", required: false, type: "string" };
}

function facts(overrides: Partial<UnionBindingFacts> & { bindingId: string }): UnionBindingFacts {
  return {
    backendResourceRef: `res-${overrides.bindingId}`,
    nativeIdRefConfirmed: true,
    collectionReadRefConfirmed: true,
    paginationRefPresent: false,
    paginationRefConfirmed: false,
    pushdownConsumerParamNames: new Set<string>(),
    ...overrides,
  };
}

function codesOf(reasons: readonly UnionRejectionReason[]): UnionRejectionReason["code"][] {
  return reasons.map((reason) => reason.code);
}

const NONE_DEDUP: PostMergeDedup = { mode: "none" };

describe("classifyUnionParameter (CO-3.4/3.5 heuristic)", () => {
  it("classifies well-known pagination spellings", () => {
    for (const name of ["page", "offset", "limit", "cursor", "per_page", "pageSize"]) {
      expect(classifyUnionParameter(queryParam(name))).toBe("pagination");
    }
  });
  it("classifies well-known sort spellings", () => {
    for (const name of ["sort", "order", "orderBy", "sort_by", "ordering"]) {
      expect(classifyUnionParameter(queryParam(name))).toBe("sort");
    }
  });
  it("defaults everything else to filter (conservative — the composer's config is authoritative)", () => {
    for (const name of ["status", "assignee", "q", "priority"]) {
      expect(classifyUnionParameter(queryParam(name))).toBe("filter");
    }
  });
});

describe("validateUnionConfiguration — union config off a non-union (CO-3.1)", () => {
  it("rejects stray union config on a non-union strategy", () => {
    const reasons = validateUnionConfiguration({
      strategy: "fanout-merge",
      submission: { postMergeDedup: NONE_DEDUP, postMergeFilters: [] },
      unionBindingFacts: [],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    expect(codesOf(reasons)).toEqual(["union-config-on-non-union", "union-config-on-non-union"]);
  });

  it("accepts a non-union submission carrying no union config", () => {
    const reasons = validateUnionConfiguration({
      strategy: "single",
      submission: {},
      unionBindingFacts: [],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    expect(reasons).toEqual([]);
  });
});

describe("validateUnionConfiguration — dedup (CO-3.1/3.2)", () => {
  const base = {
    strategy: "collection-union" as const,
    unionBindingFacts: [facts({ bindingId: "b1" }), facts({ bindingId: "b2" })],
    consumerParameters: [],
    consumerResponseFieldNames: new Set<string>(),
  };

  it("rejects a union that submits no dedup choice (none is explicit, never a default)", () => {
    const reasons = validateUnionConfiguration({ ...base, submission: {} });
    expect(codesOf(reasons)).toContain("union-missing-dedup-choice");
  });

  it("accepts an explicit 'none' dedup", () => {
    const reasons = validateUnionConfiguration({
      ...base,
      submission: { postMergeDedup: NONE_DEDUP },
    });
    expect(reasons).toEqual([]);
  });

  it("rejects link-based dedup when a contributing backend lacks a confirmed nativeIdRef, naming it", () => {
    const reasons = validateUnionConfiguration({
      ...base,
      unionBindingFacts: [
        facts({ bindingId: "b1", nativeIdRefConfirmed: true }),
        facts({ bindingId: "b2", nativeIdRefConfirmed: false, backendResourceRef: "issues" }),
      ],
      submission: { postMergeDedup: { mode: "record-link" } },
    });
    const rejected = reasons.filter(
      (reason) => reason.code === "union-link-based-native-id-unconfirmed",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ bindingId: "b2", backendResourceRef: "issues" });
  });

  it("accepts link-based dedup when every backend's nativeIdRef is confirmed", () => {
    const reasons = validateUnionConfiguration({
      ...base,
      submission: { postMergeDedup: { mode: "record-link" } },
    });
    expect(reasons).toEqual([]);
  });

  it("rejects a dedup-key that is not a consumer response field", () => {
    const reasons = validateUnionConfiguration({
      ...base,
      consumerResponseFieldNames: new Set(["id", "title"]),
      submission: { postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "todos/ghost" } },
    });
    expect(codesOf(reasons)).toContain("union-dedup-key-unknown-field");
  });

  it("accepts a dedup-key naming a real consumer response field", () => {
    const reasons = validateUnionConfiguration({
      ...base,
      consumerResponseFieldNames: new Set(["id", "title"]),
      submission: { postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "todos/id" } },
    });
    expect(reasons).toEqual([]);
  });
});

describe("validateUnionConfiguration — composability preconditions (CO-3.7)", () => {
  it("rejects a union not composable over a resource whose collectionReadRef is unconfirmed", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: { postMergeDedup: NONE_DEDUP },
      unionBindingFacts: [
        facts({ bindingId: "b1", collectionReadRefConfirmed: false, backendResourceRef: "tasks" }),
      ],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    const rejected = reasons.filter((r) => r.code === "union-not-composable-collection-read");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ bindingId: "b1", backendResourceRef: "tasks" });
  });

  it("rejects a paged read whose paginationRef is present but unconfirmed", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: { postMergeDedup: NONE_DEDUP },
      unionBindingFacts: [
        facts({ bindingId: "b1", paginationRefPresent: true, paginationRefConfirmed: false }),
      ],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    expect(codesOf(reasons)).toContain("union-not-composable-pagination");
  });

  it("accepts a non-paged read (paginationRef absent) with a confirmed collection read", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: { postMergeDedup: NONE_DEDUP },
      unionBindingFacts: [facts({ bindingId: "b1", paginationRefPresent: false })],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    expect(reasons).toEqual([]);
  });

  it("accepts a paged read whose paginationRef is confirmed", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: { postMergeDedup: NONE_DEDUP },
      unionBindingFacts: [
        facts({ bindingId: "b1", paginationRefPresent: true, paginationRefConfirmed: true }),
      ],
      consumerParameters: [],
      consumerResponseFieldNames: new Set(),
    });
    expect(reasons).toEqual([]);
  });
});

describe("validateUnionConfiguration — post-merge ref validity (CO-3.4/3.5)", () => {
  const base = {
    strategy: "collection-union" as const,
    unionBindingFacts: [facts({ bindingId: "b1" })],
    consumerParameters: [
      queryParam("status"),
      queryParam("sort"),
      queryParam("page"),
      queryParam("size"),
    ],
    consumerResponseFieldNames: new Set(["id", "state"]),
  };

  it("rejects a postMergeFilters entry naming an unknown param or unknown field", () => {
    const filters: PostMergeFilter[] = [
      { consumerParamRef: "todos/list#ghost", consumerFieldPath: "todos/state", operator: "eq" },
      { consumerParamRef: "todos/list#status", consumerFieldPath: "todos/ghost", operator: "eq" },
    ];
    const reasons = validateUnionConfiguration({
      ...base,
      submission: { postMergeDedup: NONE_DEDUP, postMergeFilters: filters },
    });
    expect(codesOf(reasons)).toEqual(
      expect.arrayContaining(["union-filter-unknown-param", "union-filter-unknown-field"]),
    );
  });

  it("rejects a postMergeSorts entry naming an unknown param or field", () => {
    const sorts: PostMergeSort[] = [
      { consumerParamRef: "todos/list#ghost", consumerFieldPath: "todos/state", direction: "asc" },
      { consumerParamRef: "todos/list#sort", consumerFieldPath: "todos/ghost", direction: "asc" },
    ];
    const reasons = validateUnionConfiguration({
      ...base,
      submission: { postMergeDedup: NONE_DEDUP, postMergeSorts: sorts },
    });
    expect(codesOf(reasons)).toEqual(
      expect.arrayContaining(["union-sort-unknown-param", "union-sort-unknown-field"]),
    );
  });

  it("rejects a pagination convention referencing a param the operation does not declare", () => {
    const pagination: PostMergePaginationConventionValue = {
      convention: "page-number",
      pageParamRef: "todos/list#page",
      sizeParamRef: "todos/list#ghostSize",
      firstPageNumber: 1,
    };
    const reasons = validateUnionConfiguration({
      ...base,
      submission: { postMergeDedup: NONE_DEDUP, postMergePagination: pagination },
    });
    const rejected = reasons.filter((r) => r.code === "union-pagination-unknown-param");
    expect(rejected).toHaveLength(1);
  });

  it("accepts a fully valid union configuration", () => {
    const submission: UnionSubmission = {
      postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: "todos/id" },
      postMergeFilters: [
        { consumerParamRef: "todos/list#status", consumerFieldPath: "todos/state", operator: "eq" },
      ],
      postMergeSorts: [
        { consumerParamRef: "todos/list#sort", consumerFieldPath: "todos/state", direction: "asc" },
      ],
      postMergePagination: {
        convention: "page-number",
        pageParamRef: "todos/list#page",
        sizeParamRef: "todos/list#size",
        firstPageNumber: 1,
      },
    };
    const reasons = validateUnionConfiguration({ ...base, submission });
    expect(reasons).toEqual([]);
  });
});

describe("deriveUnionCompositionAnalysis (CO-3.4/3.5/3.8 derive-then-confirm)", () => {
  it("lists a filter neither pushdown-eligible nor covered by a postMergeFilters entry as unserviceable", () => {
    const analysis = deriveUnionCompositionAnalysis({
      unionBindingFacts: [
        facts({ bindingId: "b1", pushdownConsumerParamNames: new Set(["status"]) }),
        facts({ bindingId: "b2", pushdownConsumerParamNames: new Set() }),
      ],
      consumerParameters: [queryParam("status"), queryParam("priority")],
      submission: { postMergeDedup: NONE_DEDUP },
      cacheTtlConfigured: false,
    });
    // `status` mapped in b1 but not b2 → not pushdown-eligible; `priority` mapped nowhere.
    expect([...analysis.unserviceableFilters].sort()).toEqual(["priority", "status"]);
  });

  it("does not list a filter pushed down in every binding or covered by postMergeFilters", () => {
    const analysis = deriveUnionCompositionAnalysis({
      unionBindingFacts: [
        facts({ bindingId: "b1", pushdownConsumerParamNames: new Set(["status", "assignee"]) }),
        facts({ bindingId: "b2", pushdownConsumerParamNames: new Set(["status", "assignee"]) }),
      ],
      consumerParameters: [queryParam("status"), queryParam("q")],
      submission: {
        postMergeDedup: NONE_DEDUP,
        postMergeFilters: [
          {
            consumerParamRef: "todos/list#q",
            consumerFieldPath: "todos/title",
            operator: "contains",
          },
        ],
      },
      cacheTtlConfigured: false,
    });
    expect(analysis.unserviceableFilters).toEqual([]);
  });

  it("flags an unconfigured sort parameter, cleared once a postMergeSorts entry covers it", () => {
    const withoutSort = deriveUnionCompositionAnalysis({
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [queryParam("sort")],
      submission: { postMergeDedup: NONE_DEDUP },
      cacheTtlConfigured: false,
    });
    expect(withoutSort.unconfiguredSortParameters).toEqual(["sort"]);

    const withSort = deriveUnionCompositionAnalysis({
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [queryParam("sort")],
      submission: {
        postMergeDedup: NONE_DEDUP,
        postMergeSorts: [
          {
            consumerParamRef: "todos/list#sort",
            consumerFieldPath: "todos/title",
            direction: "asc",
          },
        ],
      },
      cacheTtlConfigured: false,
    });
    expect(withSort.unconfiguredSortParameters).toEqual([]);
  });

  it("flags an unconfigured pagination parameter", () => {
    const analysis = deriveUnionCompositionAnalysis({
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [queryParam("page"), queryParam("size")],
      submission: { postMergeDedup: NONE_DEDUP },
      cacheTtlConfigured: false,
    });
    expect([...analysis.unconfiguredPaginationParameters].sort()).toEqual(["page", "size"]);
  });

  it("always flags the large-collection size risk, reflecting whether cacheTtl is set", () => {
    const off = deriveUnionCompositionAnalysis({
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [],
      submission: { postMergeDedup: NONE_DEDUP },
      cacheTtlConfigured: false,
    });
    expect(off.largeCollectionRisk).toEqual({
      flagged: true,
      mitigation: "cacheTtl",
      cacheTtlConfigured: false,
    });
    expect(off.dedupConflictPrecedence).toBe("executionOrder-then-bindingId");

    const on = deriveUnionCompositionAnalysis({
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [],
      submission: { postMergeDedup: NONE_DEDUP },
      cacheTtlConfigured: true,
    });
    expect(on.largeCollectionRisk.cacheTtlConfigured).toBe(true);
  });
});

describe("pushdownEligibleParamNames / paginationConventionParamRefs", () => {
  it("intersects the per-binding pushdown sets", () => {
    const result = pushdownEligibleParamNames([
      facts({ bindingId: "b1", pushdownConsumerParamNames: new Set(["a", "b", "c"]) }),
      facts({ bindingId: "b2", pushdownConsumerParamNames: new Set(["b", "c", "d"]) }),
      facts({ bindingId: "b3", pushdownConsumerParamNames: new Set(["c", "b"]) }),
    ]);
    expect([...result].sort()).toEqual(["b", "c"]);
  });

  it("is empty for no bindings (nothing is pushed down over zero contributors)", () => {
    expect([...pushdownEligibleParamNames([])]).toEqual([]);
  });

  it("extracts the parameter refs of each pagination convention", () => {
    expect(
      paginationConventionParamRefs({
        convention: "page-number",
        pageParamRef: "p",
        sizeParamRef: "s",
        firstPageNumber: 1,
      }),
    ).toEqual(["p", "s"]);
    expect(
      paginationConventionParamRefs({
        convention: "offset",
        offsetParamRef: "o",
        sizeParamRef: "s",
      }),
    ).toEqual(["o", "s"]);
    expect(paginationConventionParamRefs(undefined)).toEqual([]);
  });
});

describe("validateUnionConfiguration — name-shadow cross-check (configured-but-dead trap)", () => {
  it("rejects a postMergeFilters entry for a param whose name classifies as sort", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: {
        postMergeDedup: NONE_DEDUP,
        postMergeFilters: [
          {
            consumerParamRef: "todos/list#order",
            consumerFieldPath: "todos/state",
            operator: "eq",
          },
        ],
      },
      unionBindingFacts: [facts({ bindingId: "b1" })],
      consumerParameters: [queryParam("order")],
      consumerResponseFieldNames: new Set(["state"]),
    });
    const shadow = reasons.filter(
      (reason) => reason.code === "union-filter-name-shadowed-by-sort-or-pagination",
    );
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ consumerParamName: "order", shadowingKind: "sort" });
  });

  it("rejects a pushdown-eligible filter whose name classifies as pagination", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: { postMergeDedup: NONE_DEDUP },
      unionBindingFacts: [
        facts({ bindingId: "b1", pushdownConsumerParamNames: new Set(["size"]) }),
        facts({ bindingId: "b2", pushdownConsumerParamNames: new Set(["size"]) }),
      ],
      consumerParameters: [queryParam("size")],
      consumerResponseFieldNames: new Set(),
    });
    const shadow = reasons.filter(
      (reason) => reason.code === "union-filter-name-shadowed-by-sort-or-pagination",
    );
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({ consumerParamName: "size", shadowingKind: "pagination" });
  });

  it("accepts a normally-named filter (status) — not shadowed", () => {
    const reasons = validateUnionConfiguration({
      strategy: "collection-union",
      submission: {
        postMergeDedup: NONE_DEDUP,
        postMergeFilters: [
          {
            consumerParamRef: "todos/list#status",
            consumerFieldPath: "todos/state",
            operator: "eq",
          },
        ],
      },
      unionBindingFacts: [
        facts({ bindingId: "b1", pushdownConsumerParamNames: new Set(["status"]) }),
      ],
      consumerParameters: [queryParam("status")],
      consumerResponseFieldNames: new Set(["state"]),
    });
    expect(
      reasons.some((reason) => reason.code === "union-filter-name-shadowed-by-sort-or-pagination"),
    ).toBe(false);
  });
});
