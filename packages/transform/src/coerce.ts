import type { CoerceConfig, CoerceDateFormat } from "@mediator/domain";

import { TransformError } from "./errors.js";
import type { JsonValue } from "./json.js";

/**
 * `coerce` — the deterministic type/representation conversion of a single input
 * value into its declared target representation (TX-1 criterion 3). Pure: identical
 * inputs yield byte-identical output, and the conversion runs **only** in its
 * declared direction (`from → to`) — it is never inverted (TX-1 criterion 5).
 *
 * `coerce` never enters the expression sandbox (TX-4 criterion 6): it is a fixed,
 * auditable operation. A value it cannot convert raises an `impossible-coercion`
 * transform error rather than a fabricated value (TX-5) — never a best-effort guess.
 *
 * The caller passes a **present, non-null** primary input; a null/absent input is
 * a `missing-input` error resolved before `coerce` is reached.
 */
export function applyCoerce(config: CoerceConfig, input: JsonValue): JsonValue {
  switch (config.to) {
    case "number":
      return stringToNumber(input);
    case "string":
      return numberToString(input);
    case "boolean":
      return enumToBoolean(input, config.truthy, config.falsy);
    case "date":
      return reformatDate(input, config.sourceFormat, config.targetFormat);
  }
}

function stringToNumber(input: JsonValue): number {
  if (typeof input !== "string") {
    throw new TransformError("impossible-coercion", "coerce string→number expects a string input");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new TransformError(
      "impossible-coercion",
      "coerce string→number: empty string is not numeric",
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new TransformError(
      "impossible-coercion",
      "coerce string→number: input is not a finite number",
    );
  }
  return parsed;
}

function numberToString(input: JsonValue): string {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new TransformError(
      "impossible-coercion",
      "coerce number→string expects a finite number input",
    );
  }
  return String(input);
}

function enumToBoolean(
  input: JsonValue,
  truthy: readonly string[],
  falsy: readonly string[],
): boolean {
  if (typeof input !== "string") {
    throw new TransformError("impossible-coercion", "coerce enum→boolean expects a string input");
  }
  if (truthy.includes(input)) {
    return true;
  }
  if (falsy.includes(input)) {
    return false;
  }
  throw new TransformError(
    "impossible-coercion",
    "coerce enum→boolean: input token is in neither the truthy nor the falsy set",
  );
}

/** The maximum absolute epoch-milliseconds the ECMAScript Date range admits. */
const MAX_TIME_VALUE = 8.64e15;

const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function reformatDate(
  input: JsonValue,
  sourceFormat: CoerceDateFormat,
  targetFormat: CoerceDateFormat,
): JsonValue {
  const millis = parseDateToMillis(input, sourceFormat);
  return formatMillis(millis, targetFormat);
}

function parseDateToMillis(input: JsonValue, format: CoerceDateFormat): number {
  switch (format) {
    case "epoch-millis": {
      if (typeof input !== "number" || !Number.isInteger(input)) {
        throw new TransformError(
          "impossible-coercion",
          "coerce date: epoch-millis expects an integer",
        );
      }
      return guardTimeValue(input);
    }
    case "epoch-seconds": {
      if (typeof input !== "number" || !Number.isInteger(input)) {
        throw new TransformError(
          "impossible-coercion",
          "coerce date: epoch-seconds expects an integer",
        );
      }
      return guardTimeValue(input * 1000);
    }
    case "iso-8601": {
      if (typeof input !== "string") {
        throw new TransformError("impossible-coercion", "coerce date: iso-8601 expects a string");
      }
      const match = ISO_8601.exec(input);
      if (match === null) {
        throw new TransformError(
          "impossible-coercion",
          "coerce date: input is not canonical ISO-8601 UTC",
        );
      }
      return isoPartsToMillis(match, true);
    }
    case "date-only": {
      if (typeof input !== "string") {
        throw new TransformError("impossible-coercion", "coerce date: date-only expects a string");
      }
      const match = DATE_ONLY.exec(input);
      if (match === null) {
        throw new TransformError("impossible-coercion", "coerce date: input is not YYYY-MM-DD");
      }
      return isoPartsToMillis(match, false);
    }
  }
}

/**
 * Build epoch millis from a matched date regex, validating calendar ranges by
 * round-tripping through `Date.UTC` (which normalizes overflow) and rejecting any
 * input the normalization would have silently rolled over (e.g. month 13, day 32).
 */
function isoPartsToMillis(match: RegExpExecArray, withTime: boolean): number {
  const year = reqInt(match[1]);
  const month = reqInt(match[2]);
  const day = reqInt(match[3]);
  const hour = withTime ? reqInt(match[4]) : 0;
  const minute = withTime ? reqInt(match[5]) : 0;
  const second = withTime ? reqInt(match[6]) : 0;
  const millisPart = withTime && match[7] !== undefined ? reqInt(match[7]) : 0;
  const millis = Date.UTC(year, month - 1, day, hour, minute, second, millisPart);
  const roundTrips =
    new Date(millis).getUTCFullYear() === year &&
    new Date(millis).getUTCMonth() === month - 1 &&
    new Date(millis).getUTCDate() === day &&
    new Date(millis).getUTCHours() === hour &&
    new Date(millis).getUTCMinutes() === minute &&
    new Date(millis).getUTCSeconds() === second;
  if (!roundTrips) {
    throw new TransformError(
      "impossible-coercion",
      "coerce date: calendar components out of range",
    );
  }
  return guardTimeValue(millis);
}

function reqInt(part: string | undefined): number {
  if (part === undefined) {
    throw new TransformError("impossible-coercion", "coerce date: missing date component");
  }
  return Number(part);
}

function guardTimeValue(millis: number): number {
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_TIME_VALUE) {
    throw new TransformError(
      "impossible-coercion",
      "coerce date: value is outside the representable range",
    );
  }
  return millis;
}

function formatMillis(millis: number, format: CoerceDateFormat): JsonValue {
  switch (format) {
    case "epoch-millis":
      return millis;
    case "epoch-seconds":
      return Math.floor(millis / 1000);
    case "iso-8601":
      return new Date(millis).toISOString();
    case "date-only": {
      const date = new Date(millis);
      const year = String(date.getUTCFullYear()).padStart(4, "0");
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }
}
