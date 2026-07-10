import type { ErrorResponse, ValidationIssue } from "@mediator/contracts";

/**
 * A failed operator-API call, surfaced to the UI as a single typed error.
 *
 * Every non-2xx operator response uses the uniform {@link ErrorResponse}
 * envelope, and the API client folds transport/parse failures into the same
 * envelope shape (with a synthetic `statusCode`) so callers only ever catch one
 * error type. `issues` is the field-level validation list (present on 400s) that
 * the registration form renders inline (AR-3 criterion 5); it is normalized to an
 * empty array when absent so callers never branch on `undefined`.
 */
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly reason: string;
  public readonly issues: readonly ValidationIssue[];

  public constructor(response: ErrorResponse) {
    super(response.message);
    this.name = "ApiError";
    this.statusCode = response.statusCode;
    this.reason = response.error;
    this.issues = response.issues ?? [];
  }
}

/**
 * The field-level issues for a given form-field path, matched by exact path or by
 * a `path.` prefix (so `specs.0.role` issues surface under the `specs.0` group).
 * Returns an empty array for a non-{@link ApiError} so a caller can render form
 * errors uniformly regardless of the failure's origin.
 */
export function issuesForPath(error: unknown, path: string): readonly ValidationIssue[] {
  if (!(error instanceof ApiError)) {
    return [];
  }
  return error.issues.filter((issue) => issue.path === path || issue.path.startsWith(`${path}.`));
}
