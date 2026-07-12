/**
 * The `expression` sandbox (TX-3, TX-4).
 *
 * An expression is parsed to a jsep AST, then **transcribed** into a closed,
 * purpose-built {@link SafeExpr} union: only the allowlisted node types survive
 * transcription, everything else is rejected (TX-3 criterion 2, TX-4). The
 * evaluator walks that closed union over a flat binding environment, so there is
 * no member access, no host object, no way to reach a prototype/constructor, no
 * I/O, and no loop or recursion construct in the grammar at all (TX-4). jsep
 * itself is expression-only — it parses no assignment, statement, loop, or
 * function definition — and the transcription is a second, explicit gate.
 *
 * Two bounds make evaluation total: a **node-count cap at parse time** (rejected
 * before any evaluation) and, at eval time, a **step count, a wall-clock deadline,
 * and a maximum intermediate string length** (bounded time and memory, TX-4
 * criterion 4). The sandbox is the enforcement boundary regardless of who authored
 * the expression — "review is not the security boundary" (TX-3 criterion 5).
 *
 * Determinism (TX-3 criterion 3): no wall-clock, randomness, or locale enters a
 * result. The injectable `clock` is an *abort guard only* — it never feeds a value.
 */

import jsep from "jsep";

import { TransformError } from "./errors.js";
import { EXPRESSION_HELPERS, type HelperLimits } from "./expression-helpers.js";
import type { JsonValue } from "./json.js";

// ── allowlist ──────────────────────────────────────────────────────────────

/** Unary operators the sandbox permits. */
export const ALLOWED_UNARY_OPS: readonly string[] = ["!", "-", "+"];

/**
 * Binary operators the sandbox permits: arithmetic, comparison, and equality.
 * `==`/`!=` are **strict** here (no type coercion) — a deliberate,
 * determinism-preserving choice, documented so authors do not expect JS loose
 * equality. Bitwise/shift/exponent operators are deliberately absent.
 */
export const ALLOWED_BINARY_OPS: readonly string[] = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
];

/** Logical operators the sandbox permits (short-circuiting). */
export const ALLOWED_LOGICAL_OPS: readonly string[] = ["&&", "||"];

const UNARY = new Set(ALLOWED_UNARY_OPS);
const BINARY_ARITH = new Set(["+", "-", "*", "/", "%"]);
const BINARY_COMPARE = new Set(["<", "<=", ">", ">="]);
const BINARY_EQUALITY = new Set(["==", "!=", "===", "!=="]);
const LOGICAL = new Set(ALLOWED_LOGICAL_OPS);

// ── safe AST ─────────────────────────────────────────────────────────────

type UnaryOp = "!" | "-" | "+";
type LogicalOp = "&&" | "||";

/** The closed set of expression nodes the evaluator understands. */
export type SafeExpr =
  | { readonly node: "literal"; readonly value: string | number | boolean | null }
  | { readonly node: "identifier"; readonly name: string }
  | { readonly node: "unary"; readonly op: UnaryOp; readonly argument: SafeExpr }
  | {
      readonly node: "binary";
      readonly op: string;
      readonly left: SafeExpr;
      readonly right: SafeExpr;
    }
  | {
      readonly node: "logical";
      readonly op: LogicalOp;
      readonly left: SafeExpr;
      readonly right: SafeExpr;
    }
  | {
      readonly node: "conditional";
      readonly test: SafeExpr;
      readonly consequent: SafeExpr;
      readonly alternate: SafeExpr;
    }
  | { readonly node: "call"; readonly callee: string; readonly args: readonly SafeExpr[] };

// ── limits ───────────────────────────────────────────────────────────────

/** Every bound the sandbox enforces; `clock` is an abort guard, never a value source. */
export interface SandboxLimits {
  /** Maximum AST node count accepted at parse time (rejected before eval). */
  readonly maxNodes: number;
  /** Maximum number of nodes evaluated before eval is aborted. */
  readonly maxSteps: number;
  /** Maximum length of any intermediate/result string (bounded memory). */
  readonly maxStringLength: number;
  /** Wall-clock budget for one evaluation, in milliseconds (bounded time). */
  readonly wallClockBudgetMs: number;
  /** Monotonic-ish clock used only for the wall-clock guard; injectable for tests. */
  readonly clock: () => number;
}

/** The default sandbox bounds — conservative, ample for real field expressions. */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  maxNodes: 256,
  maxSteps: 10_000,
  maxStringLength: 100_000,
  wallClockBudgetMs: 50,
  clock: Date.now,
};

/** Merge caller overrides over {@link DEFAULT_SANDBOX_LIMITS}. */
export function resolveSandboxLimits(overrides?: Partial<SandboxLimits>): SandboxLimits {
  return { ...DEFAULT_SANDBOX_LIMITS, ...overrides };
}

// ── compile (parse-time allowlist + node bound) ─────────────────────────────

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reject(message: string): never {
  throw new TransformError("expression-rejected", message);
}

interface CompileContext {
  count: number;
  readonly maxNodes: number;
  readonly identifierNames: ReadonlySet<string>;
}

/**
 * Parse `text` and transcribe it into a {@link SafeExpr}, enforcing the allowlist
 * and the node-count bound. `identifierNames` is the set of value identifiers the
 * expression may reference (the mapping's declared input binding names); any other
 * bare identifier is rejected as unknown at parse time.
 */
export function compileExpression(
  text: string,
  options: { readonly maxNodes: number; readonly identifierNames: ReadonlySet<string> },
): SafeExpr {
  let raw: unknown;
  try {
    raw = jsep(text);
  } catch (cause) {
    throw new TransformError("expression-parse", "expression could not be parsed", { cause });
  }
  const ctx: CompileContext = {
    count: 0,
    maxNodes: options.maxNodes,
    identifierNames: options.identifierNames,
  };
  return compileNode(raw, ctx);
}

function compileNode(raw: unknown, ctx: CompileContext): SafeExpr {
  ctx.count += 1;
  if (ctx.count > ctx.maxNodes) {
    throw new TransformError("expression-node-limit", "expression exceeds the maximum node count");
  }
  if (!isObjectRecord(raw)) {
    reject("expression node is not an object");
  }
  const type = raw["type"];
  if (typeof type !== "string") {
    reject("expression node has no type");
  }
  switch (type) {
    case "Literal":
      return compileLiteral(raw);
    case "Identifier":
      return compileIdentifier(raw, ctx);
    case "UnaryExpression":
      return compileUnary(raw, ctx);
    case "BinaryExpression":
    case "LogicalExpression":
      return compileBinaryLike(raw, ctx);
    case "ConditionalExpression":
      return compileConditional(raw, ctx);
    case "CallExpression":
      return compileCall(raw, ctx);
    default:
      // MemberExpression, ThisExpression, ArrayExpression, Compound,
      // SequenceExpression — none are on the allowlist.
      return reject(`expression node type '${type}' is not allowed`);
  }
}

function compileLiteral(raw: Record<string, unknown>): SafeExpr {
  const value = raw["value"];
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return { node: "literal", value };
  }
  return reject("literal is not a string, number, boolean, or null");
}

function compileIdentifier(raw: Record<string, unknown>, ctx: CompileContext): SafeExpr {
  const name = raw["name"];
  if (typeof name !== "string") {
    reject("identifier has no name");
  }
  // Normalize the boolean/null keywords defensively (jsep emits them as literals,
  // but never rely on the parser's literal table for a security property).
  if (name === "true") {
    return { node: "literal", value: true };
  }
  if (name === "false") {
    return { node: "literal", value: false };
  }
  if (name === "null") {
    return { node: "literal", value: null };
  }
  if (!ctx.identifierNames.has(name)) {
    reject(`identifier '${name}' is not a declared input`);
  }
  return { node: "identifier", name };
}

function asUnaryOp(op: string): UnaryOp {
  switch (op) {
    case "!":
      return "!";
    case "-":
      return "-";
    case "+":
      return "+";
    default:
      return reject(`unary operator '${op}' is not allowed`);
  }
}

function asLogicalOp(op: string): LogicalOp {
  switch (op) {
    case "&&":
      return "&&";
    case "||":
      return "||";
    default:
      return reject(`logical operator '${op}' is not allowed`);
  }
}

function compileUnary(raw: Record<string, unknown>, ctx: CompileContext): SafeExpr {
  const op = raw["operator"];
  if (typeof op !== "string" || !UNARY.has(op)) {
    reject(`unary operator '${String(op)}' is not allowed`);
  }
  return { node: "unary", op: asUnaryOp(op), argument: compileNode(raw["argument"], ctx) };
}

function compileBinaryLike(raw: Record<string, unknown>, ctx: CompileContext): SafeExpr {
  const op = raw["operator"];
  if (typeof op !== "string") {
    reject("binary operator is missing");
  }
  const left = compileNode(raw["left"], ctx);
  const right = compileNode(raw["right"], ctx);
  if (LOGICAL.has(op)) {
    return { node: "logical", op: asLogicalOp(op), left, right };
  }
  if (BINARY_ARITH.has(op) || BINARY_COMPARE.has(op) || BINARY_EQUALITY.has(op)) {
    return { node: "binary", op, left, right };
  }
  return reject(`binary operator '${op}' is not allowed`);
}

function compileConditional(raw: Record<string, unknown>, ctx: CompileContext): SafeExpr {
  return {
    node: "conditional",
    test: compileNode(raw["test"], ctx),
    consequent: compileNode(raw["consequent"], ctx),
    alternate: compileNode(raw["alternate"], ctx),
  };
}

function compileCall(raw: Record<string, unknown>, ctx: CompileContext): SafeExpr {
  const callee = raw["callee"];
  if (!isObjectRecord(callee) || callee["type"] !== "Identifier") {
    // A computed/member callee (`x.f`, `x["f"]`) or any non-bare callee is rejected.
    reject("only a bare allowlisted helper may be called");
  }
  const name = callee["name"];
  if (typeof name !== "string" || !EXPRESSION_HELPERS.has(name)) {
    reject(`function '${String(name)}' is not an allowlisted helper`);
  }
  const rawArgs = raw["arguments"];
  if (!Array.isArray(rawArgs)) {
    reject("call arguments are malformed");
  }
  const args = rawArgs.map((arg: unknown) => compileNode(arg, ctx));
  return { node: "call", callee: name, args };
}

// ── evaluate (eval-time bounds + operator/helper semantics) ─────────────────

interface EvalState {
  steps: number;
  readonly deadline: number;
  readonly limits: SandboxLimits;
  readonly helperLimits: HelperLimits;
  readonly bindings: ReadonlyMap<string, JsonValue>;
}

/**
 * Evaluate a compiled {@link SafeExpr} over `bindings`, returning the output value.
 * A referenced binding resolves to its value (`null` when the input was absent —
 * the executor pre-fills that placeholder, TX-3 criterion 4). Bounds are enforced
 * throughout; a breach aborts with a transform error rather than a host exception.
 */
export function evaluateSafeExpr(
  expr: SafeExpr,
  bindings: ReadonlyMap<string, JsonValue>,
  limits: SandboxLimits,
): JsonValue {
  const state: EvalState = {
    steps: 0,
    deadline: limits.clock() + limits.wallClockBudgetMs,
    limits,
    helperLimits: { maxStringLength: limits.maxStringLength },
    bindings,
  };
  const result = evalNode(expr, state);
  return assertValidJson(result);
}

function evalNode(expr: SafeExpr, state: EvalState): JsonValue {
  state.steps += 1;
  if (state.steps > state.limits.maxSteps) {
    throw new TransformError("expression-aborted", "expression exceeded the step budget");
  }
  if (state.limits.clock() > state.deadline) {
    throw new TransformError("expression-aborted", "expression exceeded the wall-clock budget");
  }
  switch (expr.node) {
    case "literal":
      return expr.value;
    case "identifier": {
      const value = state.bindings.get(expr.name);
      return value === undefined ? null : value;
    }
    case "unary":
      return evalUnary(expr.op, evalNode(expr.argument, state));
    case "binary":
      return evalBinary(expr.op, evalNode(expr.left, state), evalNode(expr.right, state), state);
    case "logical":
      return evalLogical(expr, state);
    case "conditional":
      return truthy(evalNode(expr.test, state))
        ? evalNode(expr.consequent, state)
        : evalNode(expr.alternate, state);
    case "call":
      return evalCall(expr, state);
  }
}

function truthy(value: JsonValue): boolean {
  return Boolean(value);
}

function isScalar(value: JsonValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function evalUnary(op: UnaryOp, arg: JsonValue): JsonValue {
  if (op === "!") {
    return !truthy(arg);
  }
  if (typeof arg !== "number" || !Number.isFinite(arg)) {
    throw new TransformError("invalid-output", `unary '${op}' expects a finite number`);
  }
  return op === "-" ? -arg : arg;
}

function evalBinary(op: string, left: JsonValue, right: JsonValue, state: EvalState): JsonValue {
  if (BINARY_EQUALITY.has(op)) {
    const equal = left === right;
    return op === "==" || op === "===" ? equal : !equal;
  }
  if (op === "+") {
    return evalPlus(left, right, state);
  }
  if (BINARY_ARITH.has(op)) {
    return evalArithmetic(op, left, right);
  }
  return evalComparison(op, left, right);
}

function evalPlus(left: JsonValue, right: JsonValue, state: EvalState): JsonValue {
  if (typeof left === "number" && typeof right === "number") {
    return finiteOrThrow(left + right, "+");
  }
  if (
    isScalar(left) &&
    isScalar(right) &&
    (typeof left === "string" || typeof right === "string")
  ) {
    const result = `${String(left)}${String(right)}`;
    if (result.length > state.limits.maxStringLength) {
      throw new TransformError(
        "expression-aborted",
        "'+' result exceeds the maximum string length",
      );
    }
    return result;
  }
  throw new TransformError("invalid-output", "'+' expects two numbers or a string operand");
}

function evalArithmetic(op: string, left: JsonValue, right: JsonValue): JsonValue {
  if (typeof left !== "number" || typeof right !== "number") {
    throw new TransformError("invalid-output", `'${op}' expects two numbers`);
  }
  switch (op) {
    case "-":
      return finiteOrThrow(left - right, op);
    case "*":
      return finiteOrThrow(left * right, op);
    case "/":
      return finiteOrThrow(left / right, op);
    case "%":
      return finiteOrThrow(left % right, op);
    default:
      throw new TransformError("invalid-output", `'${op}' is not an arithmetic operator`);
  }
}

function evalComparison(op: string, left: JsonValue, right: JsonValue): JsonValue {
  if (typeof left === "number" && typeof right === "number") {
    return orderCompare(op, left, right);
  }
  if (typeof left === "string" && typeof right === "string") {
    return orderCompare(op, left, right);
  }
  throw new TransformError("invalid-output", `'${op}' expects two numbers or two strings`);
}

function orderCompare(op: string, left: number | string, right: number | string): boolean {
  // Both operands are the same primitive type (guaranteed by the caller), so the
  // relational operators are well-defined and locale-independent.
  if (typeof left === "number" && typeof right === "number") {
    switch (op) {
      case "<":
        return left < right;
      case "<=":
        return left <= right;
      case ">":
        return left > right;
      case ">=":
        return left >= right;
      default:
        throw new TransformError("invalid-output", `'${op}' is not a comparison operator`);
    }
  }
  const l = String(left);
  const r = String(right);
  switch (op) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    default:
      throw new TransformError("invalid-output", `'${op}' is not a comparison operator`);
  }
}

function finiteOrThrow(value: number, op: string): number {
  if (!Number.isFinite(value)) {
    throw new TransformError("invalid-output", `'${op}' produced a non-finite number`);
  }
  return value;
}

function evalLogical(expr: Extract<SafeExpr, { node: "logical" }>, state: EvalState): JsonValue {
  const left = evalNode(expr.left, state);
  if (expr.op === "&&") {
    return truthy(left) ? evalNode(expr.right, state) : left;
  }
  return truthy(left) ? left : evalNode(expr.right, state);
}

function evalCall(expr: Extract<SafeExpr, { node: "call" }>, state: EvalState): JsonValue {
  const helper = EXPRESSION_HELPERS.get(expr.callee);
  if (helper === undefined) {
    // Unreachable: the callee was allowlisted at compile time. Belt-and-braces.
    throw new TransformError("expression-rejected", `function '${expr.callee}' is not allowlisted`);
  }
  const args = expr.args.map((arg) => evalNode(arg, state));
  return helper(args, state.helperLimits);
}

function assertValidJson(value: JsonValue): JsonValue {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TransformError("invalid-output", "expression produced a non-finite number");
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      assertValidJson(element);
    }
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child !== undefined) {
        assertValidJson(child);
      }
    }
  }
  return value;
}
