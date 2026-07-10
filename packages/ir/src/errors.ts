/**
 * Errors raised by the `@mediator/ir` builder.
 *
 * The builder is deliberately **lenient** (SI-1 criterion 8): Swagger-2.0-origin
 * conversion artifacts, strict-schema violations, and duplicate `operationId`s
 * all produce a best-effort IR rather than an error. Only two conditions throw:
 *
 * - {@link SpecParseError} — the input cannot be recognized/parsed as any OpenAPI
 *   document at all (SI-1 criterion 9). The message identifies the parse problem.
 * - {@link UnsupportedSpecVersionError} — the input *is* a recognizable spec but
 *   not OpenAPI 3.x (e.g. Swagger/OpenAPI 2.0). Native 2.0 ingestion is out of
 *   scope for this slice — the scenarios ship pre-converted `specs/oas3/`
 *   documents.
 */

/** Base class for every error thrown by this package. */
export class IrError extends Error {}

/** The input is not a parseable/recognizable OpenAPI document (SI-1 crit 9). */
export class SpecParseError extends IrError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SpecParseError";
  }
}

/** The document is a recognizable spec but not OpenAPI 3.x (e.g. Swagger 2.0). */
export class UnsupportedSpecVersionError extends IrError {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedSpecVersionError";
  }
}
