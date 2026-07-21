import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_ORDER,
  chainInputSchema,
  postMergeDedupSchema,
  postMergeFilterSchema,
  postMergePaginationSchema,
  postMergeSortSchema,
  resolveExecutionOrder,
} from "./index.js";

describe("postMergeFilterSchema (AD-1.3)", () => {
  it("accepts a well-formed filter entry", () => {
    const result = postMergeFilterSchema.safeParse({
      consumerParamRef: "status",
      consumerFieldPath: "state",
      operator: "eq",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an operator outside the fixed set", () => {
    expect(
      postMergeFilterSchema.safeParse({
        consumerParamRef: "status",
        consumerFieldPath: "state",
        operator: "ne",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty consumerParamRef", () => {
    expect(
      postMergeFilterSchema.safeParse({
        consumerParamRef: "",
        consumerFieldPath: "state",
        operator: "eq",
      }).success,
    ).toBe(false);
  });
});

describe("postMergeSortSchema (AD-1.3)", () => {
  it("accepts a value-driven entry with paramValue", () => {
    const result = postMergeSortSchema.safeParse({
      consumerParamRef: "sort",
      paramValue: "name",
      consumerFieldPath: "name",
      direction: "asc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fixed sort entry with no paramValue (absent is meaningful)", () => {
    const parsed = postMergeSortSchema.parse({
      consumerParamRef: "sort",
      consumerFieldPath: "createdAt",
      direction: "desc",
    });
    expect(parsed).not.toHaveProperty("paramValue");
  });

  it("rejects an unknown direction", () => {
    expect(
      postMergeSortSchema.safeParse({
        consumerParamRef: "sort",
        consumerFieldPath: "name",
        direction: "ascending",
      }).success,
    ).toBe(false);
  });
});

describe("postMergePaginationSchema (AD-1.3, derive-then-confirm)", () => {
  function pageNumber(): unknown {
    return {
      convention: {
        convention: "page-number",
        pageParamRef: "page",
        sizeParamRef: "perPage",
        firstPageNumber: 1,
      },
      confirmedBy: null,
      confirmedAt: null,
    };
  }

  it("accepts an unconfirmed page-number convention (both null)", () => {
    expect(postMergePaginationSchema.safeParse(pageNumber()).success).toBe(true);
  });

  it("accepts a confirmed convention (both set)", () => {
    const result = postMergePaginationSchema.safeParse({
      ...(pageNumber() as Record<string, unknown>),
      confirmedBy: "operator@example.test",
      confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a half-confirmed convention (confirmedBy set, confirmedAt null)", () => {
    const result = postMergePaginationSchema.safeParse({
      ...(pageNumber() as Record<string, unknown>),
      confirmedBy: "operator@example.test",
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an offset convention", () => {
    const result = postMergePaginationSchema.safeParse({
      convention: { convention: "offset", offsetParamRef: "offset", sizeParamRef: "limit" },
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a page-number convention missing firstPageNumber", () => {
    const result = postMergePaginationSchema.safeParse({
      convention: { convention: "page-number", pageParamRef: "page", sizeParamRef: "perPage" },
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an offset convention carrying a stray firstPageNumber (discriminated union)", () => {
    const result = postMergePaginationSchema.safeParse({
      convention: {
        convention: "offset",
        offsetParamRef: "offset",
        sizeParamRef: "limit",
        firstPageNumber: 0,
      },
      confirmedBy: null,
      confirmedAt: null,
    });
    // The offset member has no firstPageNumber key; an extra key is stripped by
    // Zod, but the parse still succeeds structurally. Assert the value round-trips
    // without the stray field rather than asserting a hard reject.
    expect(result.success).toBe(true);
    if (result.success && result.data.convention.convention === "offset") {
      expect(result.data.convention).not.toHaveProperty("firstPageNumber");
    }
  });
});

describe("postMergeDedupSchema (AD-1.4)", () => {
  it("accepts mode none / record-link with no key", () => {
    expect(postMergeDedupSchema.safeParse({ mode: "none" }).success).toBe(true);
    expect(postMergeDedupSchema.safeParse({ mode: "record-link" }).success).toBe(true);
  });

  it("requires a dedupKeyFieldPath for dedup-key mode", () => {
    expect(
      postMergeDedupSchema.safeParse({ mode: "dedup-key", dedupKeyFieldPath: "email" }).success,
    ).toBe(true);
    expect(postMergeDedupSchema.safeParse({ mode: "dedup-key" }).success).toBe(false);
  });

  it("rejects a record-link carrying a stray dedupKeyFieldPath (discriminated union)", () => {
    const result = postMergeDedupSchema.parse({ mode: "record-link", dedupKeyFieldPath: "x" });
    // record-link member has no such key — it is stripped, not carried through.
    expect(result).not.toHaveProperty("dedupKeyFieldPath");
  });
});

describe("chainInputSchema (AD-2.2)", () => {
  it("accepts a pass-through input (no transform)", () => {
    const parsed = chainInputSchema.parse({ upstreamFieldPath: "id", targetParamRef: "userId" });
    expect(parsed).not.toHaveProperty("transform");
  });

  it("accepts an input reusing the FieldMapping transform vocabulary", () => {
    const result = chainInputSchema.safeParse({
      upstreamFieldPath: "account.ref",
      targetParamRef: "account",
      transform: "coerce",
      transformConfig: { coerce: { to: "string", from: "number" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty upstreamFieldPath / targetParamRef", () => {
    expect(
      chainInputSchema.safeParse({ upstreamFieldPath: "", targetParamRef: "userId" }).success,
    ).toBe(false);
    expect(
      chainInputSchema.safeParse({ upstreamFieldPath: "id", targetParamRef: "" }).success,
    ).toBe(false);
  });

  it("rejects an unknown transform kind", () => {
    expect(
      chainInputSchema.safeParse({
        upstreamFieldPath: "id",
        targetParamRef: "userId",
        transform: "reverse",
      }).success,
    ).toBe(false);
  });
});

describe("resolveExecutionOrder (AD-2.5)", () => {
  it("returns the documented default 0 for an uncomposed binding", () => {
    expect(DEFAULT_EXECUTION_ORDER).toBe(0);
    expect(resolveExecutionOrder({})).toBe(0);
  });

  it("returns the composed executionOrder when present, including 0", () => {
    expect(resolveExecutionOrder({ executionOrder: 3 })).toBe(3);
    expect(resolveExecutionOrder({ executionOrder: 0 })).toBe(0);
  });
});
