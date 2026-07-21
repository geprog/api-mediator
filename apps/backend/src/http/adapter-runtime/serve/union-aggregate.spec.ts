import type { EndpointStrictness } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import {
  aggregateCollectionUnion,
  type CollectionUnionContext,
  type UnionDedupPlan,
} from "./union-aggregate.js";
import type { BindingFailure, BindingResult } from "./pipeline-types.js";

function unionPlan(strictness: EndpointStrictness = "degraded") {
  return {
    endpointId: "e1",
    aggregationStrategy: "collection-union" as const,
    strictness,
    groups: [],
    eliminated: [],
  };
}

function contributor(
  bindingId: string,
  executionOrder: number,
  backendAppId: string,
  rows: readonly JsonValue[],
  nativeIds?: readonly (string | undefined)[],
): BindingResult {
  return {
    kind: "success",
    bindingId,
    role: "supplement",
    executionOrder,
    backendAppId,
    payload: [...rows],
    ...(nativeIds !== undefined ? { rowProvenance: nativeIds } : {}),
  };
}

function failed(bindingId: string, executionOrder: number, failure: BindingFailure): BindingResult {
  return { kind: "failure", bindingId, role: "supplement", executionOrder, failure };
}

function ctx(overrides: Partial<CollectionUnionContext> = {}): CollectionUnionContext {
  return {
    backendAppIdByBinding: new Map([
      ["a", "backend-a"],
      ["b", "backend-b"],
    ]),
    dedup: { mode: "none" },
    postMergeFilters: [],
    sort: undefined,
    pagination: undefined,
    ...overrides,
  };
}

const upstream: BindingFailure = {
  cause: "upstream-error",
  backendAppId: "backend-b",
  detail: "HTTP 503",
};

describe("aggregateCollectionUnion — AG-3", () => {
  it("AG-3.5 none: with no dedup config, duplicates are returned exactly as mapped (never guessed)", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor("a", 0, "backend-a", [{ id: "1", title: "Ada" }], ["1"]),
        contributor("b", 1, "backend-b", [{ id: "1", title: "Ada" }], ["1"]),
      ],
      ctx({ sort: { fieldName: "title", direction: "asc" } }),
    );
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    // Both rows survive — identical content is NOT collapsed without a link/key.
    expect(outcome.payload).toEqual([
      { id: "1", title: "Ada" },
      { id: "1", title: "Ada" },
    ]);
  });

  it("AG-3.4 dedup-key: equal key values collapse by precedence (order, then binding id)", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor("a", 0, "backend-a", [{ id: "1", title: "from-a", extra: "x" }], ["na"]),
        contributor("b", 1, "backend-b", [{ id: "1", title: "from-b" }], ["nb"]),
      ],
      ctx({ dedup: { mode: "dedup-key", fieldName: "id" } }),
    );
    expect(outcome.kind === "success" && outcome.payload).toEqual([
      // order-0 `a` wins each conflicting field; `b` contributes nothing new.
      { id: "1", title: "from-a", extra: "x" },
    ]);
  });

  it("AG-3.3 record-link: link-paired rows collapse into one, field conflicts by precedence", () => {
    const dedup: UnionDedupPlan = {
      mode: "record-link",
      linkGroupKeyByBinding: new Map([
        ["a", ["g1"]],
        ["b", ["g1"]],
      ]),
    };
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor("a", 0, "backend-a", [{ id: "A1", title: "from-a" }], ["A1"]),
        contributor("b", 1, "backend-b", [{ id: "B1", title: "from-b", note: "n" }], ["B1"]),
      ],
      ctx({ dedup }),
    );
    expect(outcome.kind === "success" && outcome.payload).toEqual([
      // Collapsed to one row; order-0 `a` wins `id`/`title`, `b` supplies `note`.
      { id: "A1", title: "from-a", note: "n" },
    ]);
  });

  it("AG-3.3 record-link: an UNLINKED row (undefined key) is never merged with anything", () => {
    const dedup: UnionDedupPlan = {
      mode: "record-link",
      linkGroupKeyByBinding: new Map([
        ["a", ["g1", undefined]],
        ["b", ["g1"]],
      ]),
    };
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor("a", 0, "backend-a", [{ id: "A1" }, { id: "A2" }], ["A1", "A2"]),
        contributor("b", 1, "backend-b", [{ id: "B1" }], ["B1"]),
      ],
      ctx({ dedup }),
    );
    // A1↔B1 collapse (1 row); A2 is unlinked and stands alone → 2 rows total.
    expect(outcome.kind === "success" && (outcome.payload as JsonValue[]).length).toBe(2);
  });

  it("AG-3.6 no per-row source annotation is injected into the body", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [contributor("a", 0, "backend-a", [{ id: "1", title: "Ada" }], ["1"])],
      ctx(),
    );
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    const rows = outcome.payload as Record<string, JsonValue>[];
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "title"]);
    // Provenance is out of band — the contributing backends are named on the outcome, not the body.
    expect(outcome.contributingBackendAppIds).toEqual(["backend-a"]);
  });

  it("AG-3.2 non-strict: a failed contributor is DROPPED, its backend named out of band", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan("degraded"),
      [contributor("a", 0, "backend-a", [{ id: "1" }], ["1"]), failed("b", 1, upstream)],
      ctx(),
    );
    expect(outcome).toMatchObject({
      kind: "success",
      payload: [{ id: "1" }],
      degraded: true,
      degradedBackendAppIds: ["backend-b"],
      contributingBackendAppIds: ["backend-a"],
    });
  });

  it("AG-3.2 strict: any contributor failure fails the whole request", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan("strict"),
      [contributor("a", 0, "backend-a", [{ id: "1" }], ["1"]), failed("b", 1, upstream)],
      ctx(),
    );
    expect(outcome).toEqual({ kind: "failure", failure: upstream });
  });

  it("AG-3.2 non-strict: when EVERY contributor fails, the request fails (never an empty union)", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan("degraded"),
      [
        failed("a", 0, { cause: "upstream-error", backendAppId: "backend-a", detail: "x" }),
        failed("b", 1, upstream),
      ],
      ctx(),
    );
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") return;
    expect(outcome.failure.cause).toBe("upstream-error");
  });

  it("AG-3.1 fails loud on a stray non-supplement role", () => {
    const stray: BindingResult = {
      kind: "success",
      bindingId: "a",
      role: "primary",
      executionOrder: 0,
      backendAppId: "backend-a",
      payload: [],
    };
    const outcome = aggregateCollectionUnion(unionPlan(), [stray], ctx());
    expect(outcome.kind === "failure" && outcome.failure.cause).toBe("mediator-transform-error");
  });

  it("a mediator-transform-error among contributors fails loud (never silently dropped)", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan("degraded"),
      [
        contributor("a", 0, "backend-a", [{ id: "1" }], ["1"]),
        failed("b", 1, { cause: "mediator-transform-error", detail: "boom" }),
      ],
      ctx(),
    );
    expect(outcome.kind === "failure" && outcome.failure.cause).toBe("mediator-transform-error");
  });

  it("fails loud on a non-collection-union plan, and on a contributor that did not return a list", () => {
    expect(
      aggregateCollectionUnion({ ...unionPlan(), aggregationStrategy: "single" }, [], ctx()).kind,
    ).toBe("failure");
    const nonList: BindingResult = {
      kind: "success",
      bindingId: "a",
      role: "supplement",
      executionOrder: 0,
      backendAppId: "backend-a",
      payload: { not: "a list" },
    };
    const outcome = aggregateCollectionUnion(unionPlan(), [nonList], ctx());
    expect(outcome.kind === "failure" && outcome.failure.cause).toBe("mediator-transform-error");
  });
});

describe("aggregateCollectionUnion — AG-4 (filter / sort / paginate / order)", () => {
  it("AG-4.2 applies a post-merge filter to the merged result", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor(
          "a",
          0,
          "backend-a",
          [
            { id: "1", state: "open" },
            { id: "2", state: "closed" },
          ],
          ["1", "2"],
        ),
        contributor("b", 1, "backend-b", [{ id: "3", state: "open" }], ["3"]),
      ],
      ctx({ postMergeFilters: [{ fieldName: "state", operator: "eq", value: "open" }] }),
    );
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    const ids = (outcome.payload as { id: string }[]).map((row) => row.id);
    expect(ids.sort()).toEqual(["1", "3"]);
  });

  it("AG-4.3 sorts the merged result and paginates it (page window over the union)", () => {
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor(
          "a",
          0,
          "backend-a",
          [
            { id: "1", title: "cherry" },
            { id: "2", title: "apple" },
          ],
          ["1", "2"],
        ),
        contributor("b", 1, "backend-b", [{ id: "3", title: "banana" }], ["3"]),
      ],
      ctx({
        sort: { fieldName: "title", direction: "asc" },
        pagination: { offset: 1, limit: 1 },
      }),
    );
    // Sorted: apple(2), banana(3), cherry(1). Page offset 1 limit 1 → banana.
    expect(outcome.kind === "success" && outcome.payload).toEqual([{ id: "3", title: "banana" }]);
  });

  it("AG-4.5 deterministic (backend, native-id) tiebreak → identical repeated requests are stable", () => {
    const results: readonly BindingResult[] = [
      contributor("a", 0, "backend-a", [{ id: "a2" }, { id: "a1" }], ["a2", "a1"]),
      contributor("b", 0, "backend-b", [{ id: "b1" }], ["b1"]),
    ];
    // Same executionOrder for a and b — the tiebreak then orders by binding id (a<b), then
    // native id within a contributor. No configured sort.
    const first = aggregateCollectionUnion(unionPlan(), results, ctx());
    const second = aggregateCollectionUnion(unionPlan(), results, ctx());
    expect(first).toEqual(second);
    expect(
      first.kind === "success" && (first.payload as { id: string }[]).map((r) => r.id),
    ).toEqual(["a1", "a2", "b1"]);
  });

  it("AG-4.6 order is fetch→merge→dedup→filter→sort→paginate (dedup runs BEFORE the filter)", () => {
    // Same dedup key; the order-0 winner is `open`. If the filter ran before dedup, `b`'s
    // `closed` row would match and survive — proving dedup precedes filtering.
    const outcome = aggregateCollectionUnion(
      unionPlan(),
      [
        contributor("a", 0, "backend-a", [{ id: "1", state: "open" }], ["1"]),
        contributor("b", 1, "backend-b", [{ id: "1", state: "closed" }], ["1"]),
      ],
      ctx({
        dedup: { mode: "dedup-key", fieldName: "id" },
        postMergeFilters: [{ fieldName: "state", operator: "eq", value: "closed" }],
      }),
    );
    expect(outcome.kind === "success" && outcome.payload).toEqual([]);
  });
});
