import type { AggregateConfig } from "@mediator/domain";

import { TransformError } from "./errors.js";
import type { JsonValue, PathRead } from "./json.js";

/**
 * `aggregate` — combine a primary input (`sourcePath`) with its additional inputs
 * (`transformConfig.additionalInputPaths`) into one target value (TX-2). Reads
 * **every** declared input; the executor accounts for all of them so each gets its
 * own `SyncFieldState` row (TX-2 criterion 2).
 *
 * A missing/null input resolves **deterministically** per `onMissingInput` — never
 * best-effort (TX-2 criterion 3): `error` raises a transform error, `skip`/`zero`
 * apply the configured placeholder. `aggregate` never enters the expression sandbox
 * (TX-4 criterion 6). Output is deterministic for identical inputs (TX-2 criterion 4).
 *
 * `inputs` is ordered: `inputs[0]` is the primary input, the rest the additional
 * inputs in their declared order.
 */
export function applyAggregate(config: AggregateConfig, inputs: readonly PathRead[]): JsonValue {
  switch (config.strategy) {
    case "concat":
      return concat(inputs, config.separator, config.onMissingInput);
    case "sum":
      return sum(inputs, config.onMissingInput);
  }
}

function concat(
  inputs: readonly PathRead[],
  separator: string,
  onMissingInput: "error" | "skip",
): string {
  const parts: string[] = [];
  for (const read of inputs) {
    if (!read.present || read.value === null) {
      if (onMissingInput === "error") {
        throw new TransformError(
          "aggregate-error",
          "aggregate concat: a required input is missing or null",
        );
      }
      continue;
    }
    parts.push(scalarToString(read.value));
  }
  return parts.join(separator);
}

function sum(inputs: readonly PathRead[], onMissingInput: "error" | "zero"): number {
  let total = 0;
  for (const read of inputs) {
    if (!read.present || read.value === null) {
      if (onMissingInput === "error") {
        throw new TransformError(
          "aggregate-error",
          "aggregate sum: a required input is missing or null",
        );
      }
      continue; // treated as zero
    }
    if (typeof read.value !== "number" || !Number.isFinite(read.value)) {
      throw new TransformError("aggregate-error", "aggregate sum: an input is not a finite number");
    }
    total += read.value;
  }
  return total;
}

function scalarToString(value: JsonValue): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TransformError(
          "aggregate-error",
          "aggregate concat: a numeric input is not finite",
        );
      }
      return String(value);
    case "boolean":
      return String(value);
    default:
      // arrays / objects / null — not a scalar the concat can render deterministically.
      throw new TransformError(
        "aggregate-error",
        "aggregate concat: an input is not a string, number, or boolean",
      );
  }
}
