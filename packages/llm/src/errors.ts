/**
 * Errors raised by the `@mediator/llm` providers.
 *
 * The provider contract (LP-2 crit 3, TD-3) is: perform exactly ONE model call,
 * then parse + validate the output against the stage's fixed schema. Two typed
 * failures come out of that contract, and the Mapping Engine core catches them
 * to drive its own retry loop (which lives in the engine slice, NOT here):
 *
 * - {@link LLMOutputValidationError} — the model produced output that does not
 *   parse/validate into the stage's shape. Carries the **raw output** and the
 *   structured **validation issues** so the engine can re-prompt with the error
 *   as `correctiveFeedback`. This is the retryable failure.
 * - {@link LLMTransportError} — the model could not be reached at all (network
 *   failure, non-2xx, or the request-timeout abort). Not an output problem, so a
 *   distinct type: the engine treats it differently from a malformed answer.
 *
 * Security invariant: these errors carry only spec metadata and model output —
 * never credential material or live record data (there is none in this slice).
 */

/** One normalized validation problem: a dotted path plus a human message. */
export interface ValidationIssue {
  /** Dotted path to the offending field (`""` for a whole-document problem). */
  readonly path: string;
  readonly message: string;
}

/** Base class for every error thrown by this package. */
export class LLMError extends Error {}

/**
 * The model's output did not parse/validate into the stage's fixed schema.
 * `rawOutput` is the exact model answer (a JSON string) so the engine can attach
 * it to the corrective retry; `issues` are the normalized validation problems.
 */
export class LLMOutputValidationError extends LLMError {
  public readonly rawOutput: string;
  public readonly issues: readonly ValidationIssue[];

  public constructor(
    message: string,
    rawOutput: string,
    issues: readonly ValidationIssue[],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LLMOutputValidationError";
    this.rawOutput = rawOutput;
    this.issues = issues;
  }
}

/**
 * The model could not be reached, responded non-2xx, or the request timed out.
 * `timedOut` is `true` when the failure was the provider's own request-timeout
 * abort (`MappingLlmConfig.requestTimeoutMs`), distinguishing a slow model from
 * an unreachable one.
 */
export class LLMTransportError extends LLMError {
  public readonly timedOut: boolean;

  public constructor(message: string, options?: { cause?: unknown; timedOut?: boolean }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LLMTransportError";
    this.timedOut = options?.timedOut ?? false;
  }
}
