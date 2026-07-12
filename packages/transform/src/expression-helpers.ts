/**
 * The fixed, allowlisted helper functions available inside the `expression`
 * sandbox (TX-3 criterion 2). Every helper is **pure, deterministic, and
 * non-recursive**: no wall-clock, randomness, locale, or ambient state, and none
 * calls back into a user expression — so no self-referential recursion is
 * reachable (TX-4 criterion 2). A function name not in this registry is
 * unavailable, not merely discouraged (TX-3 criterion 2).
 *
 * Case helpers use Unicode default case mapping (`toUpperCase`/`toLowerCase`, not
 * the `toLocale*` variants), so their output does not depend on the host locale.
 */

import { TransformError } from "./errors.js";
import type { JsonValue } from "./json.js";

/** The size budget a string-producing helper must respect (bounded memory, TX-4). */
export interface HelperLimits {
  readonly maxStringLength: number;
}

/** A helper: pure function of its already-evaluated arguments. */
export type HelperFn = (args: readonly JsonValue[], limits: HelperLimits) => JsonValue;

function fail(message: string): never {
  throw new TransformError("invalid-output", message);
}

function reqString(args: readonly JsonValue[], index: number, helper: string): string {
  const value = args[index];
  if (typeof value !== "string") {
    fail(`${helper}: argument ${String(index + 1)} must be a string`);
  }
  return value;
}

function reqNumber(args: readonly JsonValue[], index: number, helper: string): number {
  const value = args[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${helper}: argument ${String(index + 1)} must be a finite number`);
  }
  return value;
}

function optInteger(
  args: readonly JsonValue[],
  index: number,
  helper: string,
  fallback: number,
): number {
  const value = args[index];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${helper}: argument ${String(index + 1)} must be an integer`);
  }
  return value;
}

function scalarToString(value: JsonValue, helper: string): string {
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return String(value);
    case "number":
      if (!Number.isFinite(value)) {
        fail(`${helper}: cannot render a non-finite number`);
      }
      return String(value);
    default:
      fail(`${helper}: argument must be a string, number, or boolean`);
  }
}

function guardLength(result: string, limits: HelperLimits, helper: string): string {
  if (result.length > limits.maxStringLength) {
    throw new TransformError(
      "expression-aborted",
      `${helper}: result exceeds the maximum string length`,
    );
  }
  return result;
}

function requireArity(args: readonly JsonValue[], arity: number, helper: string): void {
  if (args.length !== arity) {
    fail(`${helper}: expects exactly ${String(arity)} argument(s)`);
  }
}

const HELPERS = new Map<string, HelperFn>([
  // ── string ──────────────────────────────────────────────────────────────
  [
    "upper",
    (args, limits): JsonValue => {
      requireArity(args, 1, "upper");
      return guardLength(reqString(args, 0, "upper").toUpperCase(), limits, "upper");
    },
  ],
  [
    "lower",
    (args, limits): JsonValue => {
      requireArity(args, 1, "lower");
      return guardLength(reqString(args, 0, "lower").toLowerCase(), limits, "lower");
    },
  ],
  [
    "trim",
    (args): JsonValue => {
      requireArity(args, 1, "trim");
      return reqString(args, 0, "trim").trim();
    },
  ],
  [
    "len",
    (args): JsonValue => {
      requireArity(args, 1, "len");
      return reqString(args, 0, "len").length;
    },
  ],
  [
    "substr",
    (args): JsonValue => {
      const source = reqString(args, 0, "substr");
      const start = optInteger(args, 1, "substr", 0);
      const length = args[2] === undefined ? source.length : optInteger(args, 2, "substr", 0);
      if (length < 0) {
        fail("substr: length must not be negative");
      }
      const from = start < 0 ? Math.max(source.length + start, 0) : start;
      return source.slice(from, from + length);
    },
  ],
  [
    "replace",
    (args, limits): JsonValue => {
      requireArity(args, 3, "replace");
      const source = reqString(args, 0, "replace");
      const find = reqString(args, 1, "replace");
      const repl = reqString(args, 2, "replace");
      if (find.length === 0) {
        fail("replace: the search string must not be empty");
      }
      // Literal (non-regex) global replace — deterministic, no pattern semantics.
      return guardLength(source.split(find).join(repl), limits, "replace");
    },
  ],
  [
    "concat",
    (args, limits): JsonValue => {
      let result = "";
      for (let i = 0; i < args.length; i += 1) {
        result += scalarToString(args[i] ?? null, "concat");
        if (result.length > limits.maxStringLength) {
          throw new TransformError(
            "expression-aborted",
            "concat: result exceeds the maximum string length",
          );
        }
      }
      return result;
    },
  ],
  [
    "repeat",
    (args, limits): JsonValue => {
      requireArity(args, 2, "repeat");
      const source = reqString(args, 0, "repeat");
      const times = reqNumber(args, 1, "repeat");
      if (!Number.isInteger(times) || times < 0) {
        fail("repeat: count must be a non-negative integer");
      }
      // Guard the resulting size *before* allocating, so a huge count aborts
      // rather than exhausting memory (bounded memory, TX-4 criterion 4).
      if (source.length * times > limits.maxStringLength) {
        throw new TransformError(
          "expression-aborted",
          "repeat: result exceeds the maximum string length",
        );
      }
      return source.repeat(times);
    },
  ],
  [
    "padStart",
    (args, limits): JsonValue => {
      requireArity(args, 3, "padStart");
      const source = reqString(args, 0, "padStart");
      const target = reqNumber(args, 1, "padStart");
      const pad = reqString(args, 2, "padStart");
      if (!Number.isInteger(target) || target < 0 || target > limits.maxStringLength) {
        throw new TransformError("expression-aborted", "padStart: target length out of bounds");
      }
      return source.padStart(target, pad);
    },
  ],
  // ── number ──────────────────────────────────────────────────────────────
  [
    "abs",
    (args): JsonValue => {
      requireArity(args, 1, "abs");
      return Math.abs(reqNumber(args, 0, "abs"));
    },
  ],
  [
    "floor",
    (args): JsonValue => {
      requireArity(args, 1, "floor");
      return Math.floor(reqNumber(args, 0, "floor"));
    },
  ],
  [
    "ceil",
    (args): JsonValue => {
      requireArity(args, 1, "ceil");
      return Math.ceil(reqNumber(args, 0, "ceil"));
    },
  ],
  [
    "round",
    (args): JsonValue => {
      requireArity(args, 1, "round");
      return Math.round(reqNumber(args, 0, "round"));
    },
  ],
  [
    "min",
    (args): JsonValue => {
      if (args.length === 0) {
        fail("min: expects at least one argument");
      }
      return Math.min(...args.map((_, i) => reqNumber(args, i, "min")));
    },
  ],
  [
    "max",
    (args): JsonValue => {
      if (args.length === 0) {
        fail("max: expects at least one argument");
      }
      return Math.max(...args.map((_, i) => reqNumber(args, i, "max")));
    },
  ],
  [
    "toNumber",
    (args): JsonValue => {
      requireArity(args, 1, "toNumber");
      const value = args[0];
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          fail("toNumber: input is not a finite number");
        }
        return value;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        const parsed = trimmed.length === 0 ? Number.NaN : Number(trimmed);
        if (!Number.isFinite(parsed)) {
          fail("toNumber: input string is not numeric");
        }
        return parsed;
      }
      fail("toNumber: input must be a string or number");
    },
  ],
  [
    "toString",
    (args): JsonValue => {
      requireArity(args, 1, "toString");
      return scalarToString(args[0] ?? null, "toString");
    },
  ],
  // ── logic / null-handling ────────────────────────────────────────────────
  [
    "coalesce",
    (args): JsonValue => {
      for (const value of args) {
        if (value !== null) {
          return value;
        }
      }
      return null;
    },
  ],
  [
    "ifNull",
    (args): JsonValue => {
      requireArity(args, 2, "ifNull");
      const value = args[0] ?? null;
      return value === null ? (args[1] ?? null) : value;
    },
  ],
  [
    "not",
    (args): JsonValue => {
      requireArity(args, 1, "not");
      return !(args[0] ?? null);
    },
  ],
]);

/** The allowlisted helper registry, keyed by call name. */
export const EXPRESSION_HELPERS: ReadonlyMap<string, HelperFn> = HELPERS;

/** The allowlisted helper names, for documentation and the sandbox allowlist. */
export const EXPRESSION_HELPER_NAMES: readonly string[] = [...HELPERS.keys()];
