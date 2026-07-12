/**
 * The transform-error signal (TX-5).
 *
 * Any transform that cannot produce a valid output raises a {@link TransformError}
 * rather than returning a fabricated, partial, or silently-empty value. This one
 * distinct error kind is the concept's **`mediator-transform-error`** signal
 * (`docs/glossary.md`): Phase 4 defines and raises it for every deterministic
 * failure (missing input, impossible coercion, a sandbox rejection); Phase 5's
 * Adapter Engine reuses the *same* class for the consumer-response-schema
 * validation case, so an aggregated response that fails validation surfaces as
 * `mediator-transform-error` and is never returned as if it were valid data.
 *
 * The caller (the Outbound Call Executor / Adapter Engine) catches it and handles
 * the outcome as a failure/park; it never emits a `success` over bad data.
 *
 * **Security:** messages carry only metadata — field paths (approved-mapping
 * config), the failure kind, expected types. A `TransformError` never embeds a
 * live payload value, so it is safe to log and audit (`docs/architecture/security.md`).
 */

/** The distinct causes a transform can fail for; the sub-kind of the one signal. */
export type TransformErrorKind =
  /** The `FieldMapping.transformConfig` is missing or malformed for its `transform`. */
  | "invalid-config"
  /** A required input path (primary or additional) is absent where a value was needed. */
  | "missing-input"
  /** A `coerce` cannot produce its declared target representation from the input. */
  | "impossible-coercion"
  /** An `aggregate` cannot combine its inputs (missing input under `error`, wrong type). */
  | "aggregate-error"
  /** The `expression` text could not be parsed to an AST (assignment, stray token, empty). */
  | "expression-parse"
  /** The parsed `expression` AST exceeds the bounded node count (rejected before eval). */
  | "expression-node-limit"
  /** The `expression` AST is outside the sandbox allowlist (member access, disallowed op/call, unknown name). */
  | "expression-rejected"
  /** `expression` evaluation exceeded a bound (step count, wall-clock, or intermediate memory). */
  | "expression-aborted"
  /**
   * A transform could not produce a valid JSON output value — a non-JSON result
   * (NaN/Infinity), or an operator/helper applied at eval time to an incompatible
   * value (a wrong-typed operand or a wrong-typed/arity helper argument).
   */
  | "invalid-output";

/**
 * The one carrier of the `mediator-transform-error` signal. Its {@link kind}
 * discriminates the cause; downstream code keys on the class (and, where it
 * cares, the kind), not on message text.
 */
export class TransformError extends Error {
  public readonly kind: TransformErrorKind;
  /** The `FieldMapping.id` this failure is scoped to, when the caller supplied one. */
  public readonly fieldMappingId: string | undefined;

  public constructor(
    kind: TransformErrorKind,
    message: string,
    options?: { readonly fieldMappingId?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransformError";
    this.kind = kind;
    this.fieldMappingId = options?.fieldMappingId;
  }
}

/** Narrow an unknown thrown value to a {@link TransformError}. */
export function isTransformError(value: unknown): value is TransformError {
  return value instanceof TransformError;
}
