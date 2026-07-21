import { describe, expect, it } from "vitest";

import {
  adapterRequestCauseSchema,
  adapterWriteOutcomeStatusSchema,
  aggregationStrategySchema,
  endpointStrictnessSchema,
  postMergeDedupModeSchema,
  postMergeFilterOperatorSchema,
  postMergePaginationConventionSchema,
  postMergeSortDirectionSchema,
} from "./index.js";

describe("AggregationStrategy", () => {
  it("owns exactly the four data-model values (no list-style extra, AD-1.2)", () => {
    expect([...aggregationStrategySchema.options].sort()).toStrictEqual([
      "collection-union",
      "fanout-first-success",
      "fanout-merge",
      "single",
    ]);
  });
});

describe("EndpointStrictness", () => {
  it("is exactly strict | degraded (AD-1.5)", () => {
    expect([...endpointStrictnessSchema.options].sort()).toStrictEqual(["degraded", "strict"]);
  });
});

describe("PostMergeFilterOperator", () => {
  it("is exactly eq | contains | gte | lte (AD-1.3)", () => {
    expect([...postMergeFilterOperatorSchema.options].sort()).toStrictEqual([
      "contains",
      "eq",
      "gte",
      "lte",
    ]);
  });
});

describe("PostMergeSortDirection", () => {
  it("is exactly asc | desc (AD-1.3)", () => {
    expect([...postMergeSortDirectionSchema.options].sort()).toStrictEqual(["asc", "desc"]);
  });
});

describe("PostMergeDedupMode", () => {
  it("is exactly none | record-link | dedup-key (AD-1.4)", () => {
    expect([...postMergeDedupModeSchema.options].sort()).toStrictEqual([
      "dedup-key",
      "none",
      "record-link",
    ]);
  });
});

describe("PostMergePaginationConvention", () => {
  it("is exactly page-number | offset", () => {
    expect([...postMergePaginationConventionSchema.options].sort()).toStrictEqual([
      "offset",
      "page-number",
    ]);
  });
});

describe("AdapterRequestCause", () => {
  it("owns the six named causes plus a generic upstream-error (AD-5.2)", () => {
    expect([...adapterRequestCauseSchema.options].sort()).toStrictEqual([
      "backend-disabled",
      "endpoint-disabled",
      "mapping-stale",
      "mapping-suspended",
      "mediator-transform-error",
      "not-yet-mapped",
      "upstream-error",
    ]);
  });
});

describe("AdapterWriteOutcomeStatus", () => {
  it("distinguishes a recorded success from a recorded failure (AD-4.5)", () => {
    expect([...adapterWriteOutcomeStatusSchema.options].sort()).toStrictEqual([
      "failure",
      "success",
    ]);
  });
});
