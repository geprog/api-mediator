import { describe, expect, it } from "vitest";

import { isTransformError, type TransformErrorKind } from "./errors.js";
import { compileExpression, resolveSandboxLimits } from "./expression.js";
import { EXPRESSION_HELPER_NAMES } from "./expression-helpers.js";

/**
 * TX-4 — the sandbox's negative space, each construct tested as an *explicit*
 * rejection that surfaces as a transform error (TX-4 criterion 5), never a
 * silently-empty value. The sandbox is the enforcement boundary regardless of who
 * authored the expression — human review is not (TX-3 criterion 5), so these are
 * runtime guarantees, not review-time warnings.
 *
 * Identifiers the constructs operate on are pre-declared, so a rejection is
 * attributable to the disallowed *construct* (assignment, member access, host call),
 * not merely to an unknown name.
 */

const DECLARED = new Set(["x", "status", "a", "b", "obj"]);

function compile(text: string): void {
  const limits = resolveSandboxLimits();
  compileExpression(text, { maxNodes: limits.maxNodes, identifierNames: DECLARED });
}

function expectRejected(text: string, kinds: readonly TransformErrorKind[]): void {
  try {
    compile(text);
    throw new Error(`expected '${text}' to be rejected`);
  } catch (error) {
    expect(isTransformError(error)).toBe(true);
    if (isTransformError(error)) {
      expect(kinds).toContain(error.kind);
    }
  }
}

describe("TX-4.1 — no assignment or state mutation", () => {
  it("rejects assignment", () => {
    expectRejected("x = 1", ["expression-parse", "expression-rejected"]);
  });

  it("rejects compound assignment and increment", () => {
    expectRejected("x += 1", ["expression-parse", "expression-rejected"]);
    expectRejected("x++", ["expression-parse", "expression-rejected"]);
  });
});

describe("TX-4.2 — no loops, recursion, or function definition", () => {
  it("rejects an arrow/function definition (no way to define a callable, so no recursion)", () => {
    expectRejected("() => 1", ["expression-parse", "expression-rejected"]);
    expectRejected("function () { return 1; }", ["expression-parse", "expression-rejected"]);
  });

  it("rejects calling anything that is not an allowlisted helper (no self-referential helper)", () => {
    // `fact` is not in the fixed helper set, so a recursive helper is unreachable.
    expectRejected("fact(3)", ["expression-rejected"]);
    expect(EXPRESSION_HELPER_NAMES).not.toContain("fact");
  });

  it("rejects the array/map shape a caller might reach for to iterate", () => {
    expectRejected("x.map(y)", ["expression-rejected"]);
    expectRejected("[1, 2, 3]", ["expression-rejected"]);
  });
});

describe("TX-4.3 — no host calls, I/O, or prototype/constructor escape", () => {
  it("rejects require/import", () => {
    expectRejected("require('fs')", ["expression-rejected"]);
    expectRejected("import('fs')", ["expression-rejected", "expression-parse"]);
  });

  it("rejects process / globalThis / this", () => {
    expectRejected("process.exit()", ["expression-rejected"]);
    expectRejected("globalThis", ["expression-rejected"]);
    expectRejected("this", ["expression-rejected"]);
  });

  it("rejects any member access (dotted or computed) — the prototype/constructor escape vector", () => {
    expectRejected("obj.prop", ["expression-rejected"]);
    expectRejected("x.constructor", ["expression-rejected"]);
    expectRejected('x["constructor"]', ["expression-rejected"]);
    expectRejected("x.constructor.constructor", ["expression-rejected"]);
    expectRejected("obj.__proto__", ["expression-rejected"]);
  });

  it("rejects a member-access callee (only a bare helper name may be called)", () => {
    expectRejected("obj.toString()", ["expression-rejected"]);
  });
});

describe("TX-4 — unknown identifiers and stray sequences", () => {
  it("rejects an identifier that is not a declared input or a helper", () => {
    expectRejected("unknownName", ["expression-rejected"]);
  });

  it("rejects a comma/semicolon sequence (statement-execution)", () => {
    expectRejected("a, b", ["expression-rejected"]);
    expectRejected("1; 2", ["expression-rejected", "expression-parse"]);
  });
});

describe("TX-4.4 — bounded node count at parse time", () => {
  it("rejects an expression exceeding the node bound before evaluation", () => {
    const limits = resolveSandboxLimits();
    expect(() =>
      compileExpression("1 + 2 + 3 + 4 + 5", { maxNodes: 3, identifierNames: DECLARED }),
    ).toThrow();
    // sanity: within the default bound the same shape compiles.
    expect(() =>
      compileExpression("1 + 2", { maxNodes: limits.maxNodes, identifierNames: DECLARED }),
    ).not.toThrow();
  });
});

describe("the helper allowlist is a fixed, closed set", () => {
  it("contains only the documented helpers and excludes dangerous names", () => {
    for (const name of ["eval", "require", "constructor", "Function", "process", "fetch"]) {
      expect(EXPRESSION_HELPER_NAMES).not.toContain(name);
    }
    expect(EXPRESSION_HELPER_NAMES.length).toBeGreaterThan(0);
  });
});
