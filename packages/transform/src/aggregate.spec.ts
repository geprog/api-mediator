import type { AggregateConfig } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { applyAggregate } from "./aggregate.js";
import { isTransformError } from "./errors.js";
import type { JsonValue, PathRead } from "./json.js";

function present(value: JsonValue): PathRead {
  return { present: true, value };
}
const ABSENT: PathRead = { present: false };
const NULL_VALUE: PathRead = { present: true, value: null };

function expectAggregateError(config: AggregateConfig, inputs: readonly PathRead[]): void {
  try {
    applyAggregate(config, inputs);
    throw new Error("expected an aggregate-error transform error");
  } catch (error) {
    expect(isTransformError(error)).toBe(true);
    if (isTransformError(error)) {
      expect(error.kind).toBe("aggregate-error");
    }
  }
}

describe("aggregate concat", () => {
  it("joins the primary and additional inputs with the separator", () => {
    const config: AggregateConfig = { strategy: "concat", separator: " ", onMissingInput: "error" };
    expect(applyAggregate(config, [present("Ada"), present("Lovelace")])).toBe("Ada Lovelace");
  });

  it("renders numbers and booleans deterministically", () => {
    const config: AggregateConfig = { strategy: "concat", separator: "-", onMissingInput: "error" };
    expect(applyAggregate(config, [present("v"), present(2), present(true)])).toBe("v-2-true");
  });

  it("errors on a missing/null input under onMissingInput=error", () => {
    const config: AggregateConfig = { strategy: "concat", separator: " ", onMissingInput: "error" };
    expectAggregateError(config, [present("Ada"), ABSENT]);
    expectAggregateError(config, [present("Ada"), NULL_VALUE]);
  });

  it("skips a missing/null input under onMissingInput=skip (documented placeholder)", () => {
    const config: AggregateConfig = { strategy: "concat", separator: " ", onMissingInput: "skip" };
    expect(applyAggregate(config, [present("Ada"), ABSENT, present("L.")])).toBe("Ada L.");
    expect(applyAggregate(config, [present("Ada"), NULL_VALUE])).toBe("Ada");
  });

  it("rejects a non-scalar input", () => {
    const config: AggregateConfig = { strategy: "concat", separator: " ", onMissingInput: "error" };
    expectAggregateError(config, [present("a"), present({ nested: 1 })]);
    expectAggregateError(config, [present("a"), present([1, 2])]);
  });
});

describe("aggregate sum", () => {
  it("sums numeric inputs", () => {
    const config: AggregateConfig = { strategy: "sum", onMissingInput: "error" };
    expect(applyAggregate(config, [present(2), present(3), present(5)])).toBe(10);
  });

  it("treats a missing/null input as zero under onMissingInput=zero", () => {
    const config: AggregateConfig = { strategy: "sum", onMissingInput: "zero" };
    expect(applyAggregate(config, [present(2), ABSENT, present(5)])).toBe(7);
    expect(applyAggregate(config, [present(2), NULL_VALUE])).toBe(2);
  });

  it("errors on a missing input under onMissingInput=error", () => {
    const config: AggregateConfig = { strategy: "sum", onMissingInput: "error" };
    expectAggregateError(config, [present(2), ABSENT]);
  });

  it("errors on a non-number input", () => {
    const config: AggregateConfig = { strategy: "sum", onMissingInput: "error" };
    expectAggregateError(config, [present(2), present("3")]);
  });
});

describe("aggregate determinism", () => {
  it("produces the same output for identical inputs applied twice", () => {
    const config: AggregateConfig = { strategy: "concat", separator: ", ", onMissingInput: "skip" };
    const inputs = [present("a"), present("b"), ABSENT, present("c")];
    expect(applyAggregate(config, inputs)).toBe(applyAggregate(config, inputs));
  });
});
