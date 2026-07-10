import type { ErrorResponse, ValidationIssue } from "@mediator/contracts";

/**
 * The operator API's error taxonomy — thrown by application services and routes,
 * mapped to the uniform {@link ErrorResponse} envelope by the HTTP error handler
 * (see `http/errors.ts`). A leaf module (no Fastify, no persistence) so both the
 * `modules/*` services and the `http/*` layer can throw these without a circular
 * dependency.
 *
 * - `400` {@link BadRequestError} — request validation, a violated domain rule
 *   (e.g. `baseUrl` required for a PROVIDER spec), or an unparseable spec.
 * - `404` {@link NotFoundError} — a referenced entity does not exist.
 *
 * No error surface ever carries credential material: `issues` are
 * `{ path, message }` pairs built from Zod's value-free default messages.
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly reason: string;
  public readonly issues: ValidationIssue[] | undefined;

  public constructor(
    statusCode: number,
    reason: string,
    message: string,
    issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.reason = reason;
    this.issues = issues;
  }

  public toResponse(): ErrorResponse {
    return {
      statusCode: this.statusCode,
      error: this.reason,
      message: this.message,
      ...(this.issues !== undefined ? { issues: this.issues } : {}),
    };
  }
}

/** A 400: invalid request, a violated domain rule, or an unparseable spec. */
export class BadRequestError extends HttpError {
  public constructor(message: string, issues?: ValidationIssue[]) {
    super(400, "Bad Request", message, issues);
    this.name = "BadRequestError";
  }
}

/** A 404: a referenced `RegisteredApp`/`ApiSpec`/`ResourceBinding` is unknown. */
export class NotFoundError extends HttpError {
  public constructor(message: string) {
    super(404, "Not Found", message);
    this.name = "NotFoundError";
  }
}
