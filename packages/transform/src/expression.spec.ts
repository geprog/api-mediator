import { describe, expect, it } from "vitest";

import { isTransformError, type TransformErrorKind } from "./errors.js";
import {
  compileExpression,
  DEFAULT_SANDBOX_LIMITS,
  evaluateSafeExpr,
  resolveSandboxLimits,
  type SandboxLimits,
} from "./expression.js";
import type { JsonValue } from "./json.js";

/** Compile + evaluate `text` over `bindings`, with optional limit overrides. */
function run(
  text: string,
  bindings: Record<string, JsonValue> = {},
  overrides?: Partial<SandboxLimits>,
): JsonValue {
  const limits = resolveSandboxLimits(overrides);
  const names = new Set(Object.keys(bindings));
  const compiled = compileExpression(text, { maxNodes: limits.maxNodes, identifierNames: names });
  return evaluateSafeExpr(compiled, new Map(Object.entries(bindings)), limits);
}

function expectKind(fn: () => unknown, kind: TransformErrorKind): void {
  try {
    fn();
    throw new Error(`expected a '${kind}' transform error`);
  } catch (error) {
    expect(isTransformError(error)).toBe(true);
    if (isTransformError(error)) {
      expect(error.kind).toBe(kind);
    }
  }
}

describe("expression — allowlisted happy path", () => {
  it("evaluates arithmetic and precedence", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 % 3")).toBe(1);
  });

  it("evaluates string concatenation over inputs", () => {
    expect(run('firstName + " " + lastName', { firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace",
    );
  });

  it("evaluates comparisons, logicals, and the ternary", () => {
    expect(run("n >= 10 && n < 100", { n: 42 })).toBe(true);
    expect(run('status == "open" ? "yes" : "no"', { status: "open" })).toBe("yes");
    expect(run("a || b", { a: null, b: "fallback" })).toBe("fallback");
    expect(run("!done", { done: false })).toBe(true);
  });

  it("evaluates the allowlisted helper set", () => {
    expect(run("upper(s)", { s: "abc" })).toBe("ABC");
    expect(run("lower(s)", { s: "ABC" })).toBe("abc");
    expect(run("trim(s)", { s: "  x  " })).toBe("x");
    expect(run("len(s)", { s: "abcd" })).toBe(4);
    expect(run("substr(s, 1, 2)", { s: "abcd" })).toBe("bc");
    expect(run('replace(s, "-", "/")', { s: "a-b-c" })).toBe("a/b/c");
    expect(run('concat(a, "-", b)', { a: "x", b: 2 })).toBe("x-2");
    expect(run("abs(n)", { n: -5 })).toBe(5);
    expect(run("round(n)", { n: 2.6 })).toBe(3);
    expect(run("min(a, b, 3)", { a: 5, b: 1 })).toBe(1);
    expect(run("max(a, b, 3)", { a: 5, b: 1 })).toBe(5);
    expect(run("toNumber(s)", { s: "42" })).toBe(42);
    expect(run("coalesce(a, b, c)", { a: null, b: null, c: "third" })).toBe("third");
    expect(run("ifNull(a, b)", { a: null, b: "fb" })).toBe("fb");
  });

  it("resolves booleans and null literals", () => {
    expect(run("true")).toBe(true);
    expect(run("false")).toBe(false);
    expect(run("null")).toBe(null);
  });
});

describe("expression — determinism (TX-3 criterion 3)", () => {
  it("produces byte-identical output for the same expression and inputs applied twice", () => {
    const text = 'concat(upper(firstName), " ", lastName) + " (" + toString(n) + ")"';
    const bindings = { firstName: "ada", lastName: "Lovelace", n: 7 };
    const first = run(text, bindings);
    const second = run(text, bindings);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toBe("ADA Lovelace (7)");
  });
});

describe("expression — missing input resolves to the null placeholder (TX-3 criterion 4)", () => {
  it("treats an absent declared input as null rather than throwing a host exception", () => {
    // `middle` is a declared identifier bound to null (absent in the record).
    expect(run('coalesce(middle, "n/a")', { middle: null })).toBe("n/a");
    expect(run("middle == null", { middle: null })).toBe(true);
  });
});

describe("expression — parse-time node bound (TX-4 criterion 4)", () => {
  it("rejects an expression exceeding the node count before evaluation", () => {
    expectKind(() => run("1 + 2 + 3 + 4", {}, { maxNodes: 3 }), "expression-node-limit");
  });

  it("accepts an expression within the node count", () => {
    expect(run("1 + 2", {}, { maxNodes: 3 })).toBe(3);
  });
});

describe("expression — eval-time bounds (TX-4 criterion 4)", () => {
  it("aborts when the step budget is exceeded", () => {
    expectKind(() => run("1 + 2 + 3 + 4 + 5", {}, { maxSteps: 2 }), "expression-aborted");
  });

  it("aborts when the wall-clock budget is exceeded (injected clock)", () => {
    let ticks = 0;
    const clock = (): number => {
      ticks += 1;
      // First call (deadline computation) returns 0; the next check jumps past it.
      return ticks === 1 ? 0 : 10_000;
    };
    expectKind(() => run("1 + 1", {}, { clock, wallClockBudgetMs: 50 }), "expression-aborted");
  });

  it("aborts when an intermediate string exceeds the memory bound", () => {
    expectKind(() => run('repeat("x", 1000)', {}, { maxStringLength: 10 }), "expression-aborted");
  });
});

describe("expression — invalid output surfaces (TX-5)", () => {
  it("rejects division that produces a non-finite number", () => {
    expectKind(() => run("1 / 0"), "invalid-output");
  });

  it("rejects an operator applied to an incompatible operand", () => {
    expectKind(() => run("a - b", { a: "x", b: 1 }), "invalid-output");
    expectKind(() => run("a < b", { a: 1, b: "x" }), "invalid-output");
  });

  it("rejects a helper called with the wrong argument type", () => {
    expectKind(() => run("upper(n)", { n: 5 }), "invalid-output");
  });
});

describe("expression — default limits are conservative", () => {
  it("exposes sane defaults", () => {
    expect(DEFAULT_SANDBOX_LIMITS.maxNodes).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.wallClockBudgetMs).toBeGreaterThan(0);
    expect(DEFAULT_SANDBOX_LIMITS.maxStringLength).toBeGreaterThan(0);
  });
});
