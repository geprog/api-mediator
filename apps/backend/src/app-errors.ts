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
 * - `401` {@link UnauthorizedError} — the request carries no valid authenticated
 *   operator identity (OA-1).
 * - `403` {@link ForbiddenError} — an authenticated `viewer` attempted a mutation
 *   an `operator` alone may perform (OA-2).
 * - `404` {@link NotFoundError} — a referenced entity does not exist.
 * - `409` {@link ConflictError} — the target resource is not in a state where the
 *   action applies (a transient/state conflict, not a malformed request): e.g. a
 *   parked-write replay blocked because the record's queue is busy or the write was
 *   already superseded (SA-5).
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

/**
 * A 409: the target resource is not in a state where the requested action applies —
 * a transient/state conflict rather than a malformed request. Used by SA-5 replay when
 * the parked write's record queue is busy (`blocked-key-busy` — retry once it drains),
 * the write was already superseded by a later sync (`superseded` — no replay needed), or
 * the entry is no longer parked (`not-parked`). Never carries credential material.
 */
export class ConflictError extends HttpError {
  public constructor(message: string) {
    super(409, "Conflict", message);
    this.name = "ConflictError";
  }
}

/**
 * A 401: the request reached the operator API without a valid authenticated
 * identity (OA-1). Thrown by the authentication hook before any route handler
 * runs, so no side effect occurs. Never carries credential material.
 */
export class UnauthorizedError extends HttpError {
  public constructor(message = "Authentication is required.") {
    super(401, "Unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

/**
 * A 403: an authenticated principal lacks the role for the action — a `viewer`
 * attempting a mutation reserved for `operator` (OA-2). Thrown by the role guard
 * before the handler runs, so nothing is mutated.
 */
export class ForbiddenError extends HttpError {
  public constructor(message = "This action requires the operator role.") {
    super(403, "Forbidden", message);
    this.name = "ForbiddenError";
  }
}
