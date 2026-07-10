import type { ValidationIssue } from "@mediator/contracts";
import type { ZodType } from "zod";

import { BadRequestError } from "../app-errors.js";

/**
 * Validate untyped request input (`body`/`params`/`query`) against a contract
 * schema, returning the typed value or throwing a {@link BadRequestError} (400)
 * whose `issues` name each offending field. Zod's default issue messages are
 * value-free, so no submitted value (including credential material) reaches the
 * error surface.
 */
export function parseInput<T>(schema: ZodType<T>, data: unknown, subject: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path:
        issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "(root)",
      message: issue.message,
    }));
    throw new BadRequestError(`Invalid ${subject}`, issues);
  }
  return result.data;
}
