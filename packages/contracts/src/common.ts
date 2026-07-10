import type { ConfirmableRef, ResourceBinding } from "@mediator/domain";
import { z } from "zod";

/**
 * Cross-cutting wire shapes shared by every operator-API DTO.
 *
 * `@mediator/contracts` is the **single source of the HTTP boundary vocabulary**:
 * request/response DTO schemas (Zod) + their inferred types, imported by both the
 * backend routes and the frontend client (no codegen). DTOs are deliberately
 * distinct from `@mediator/domain` entities wherever the wire shape differs:
 *
 * - a domain `Date` becomes an **ISO-8601 string** at the boundary
 *   ({@link isoDateTimeSchema}), because JSON has no `Date`;
 * - credential material and `Credential.encryptedPayload` are **never** part of
 *   any response DTO (CR-2) — the register-app request carries write-only
 *   credential material, and no response schema has a field that could echo it;
 * - `ApiSpec.rawDocument` is never exposed by a metadata/list DTO (only the IR
 *   endpoint returns the parsed IR).
 *
 * This package depends only on `@mediator/domain` (for shared sub-shapes like the
 * IR and enums) and `zod`, so importing it into the frontend never pulls in the
 * backend's persistence/HTTP stack.
 */

/**
 * An ISO-8601 timestamp string — the wire form of a domain `Date`. Backend
 * mappers produce it with `Date.prototype.toISOString()`; the frontend re-parses
 * it with `new Date(value)`. Kept as a plain string schema (rather than a strict
 * datetime validator) so a valid `toISOString()` value always round-trips.
 */
export const isoDateTimeSchema = z.string();

/** One field-level validation problem, reported as a path + human message. */
export const validationIssueSchema = z.object({
  /** Dot-joined path to the offending field (e.g. `specs.0.role`), or `(root)`. */
  path: z.string(),
  /** Human-readable reason — never echoes a submitted value (no secret leakage). */
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * The uniform error envelope every non-2xx operator-API response uses. `error`
 * is a short reason phrase (e.g. `"Bad Request"`, `"Not Found"`); `issues` is
 * present only for request-validation failures (400) and lists each offending
 * field. No error surface ever carries credential material.
 */
export const errorResponseSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
  issues: z.array(validationIssueSchema).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * The six confirmable `ResourceBinding` ref kinds, in a stable order. Kept in
 * lock-step with the domain `ResourceBinding` shape by the `satisfies` guard: if
 * a ref key is renamed or a new confirmable ref is added in `@mediator/domain`,
 * this tuple stops satisfying {@link ResourceBindingRefKey} and the build fails
 * here — the same drift guard `@mediator/db` applies to its ref-kind enum.
 */
type ResourceBindingRefKey = keyof {
  [
    K in keyof ResourceBinding as ResourceBinding[K] extends ConfirmableRef | undefined ? K : never
  ]: true;
};

export const RESOURCE_BINDING_REF_KINDS = [
  "nativeIdRef",
  "collectionReadRef",
  "paginationRef",
  "deltaCursorRef",
  "deltaDeletionRef",
  "changeTimestampRef",
] as const satisfies readonly ResourceBindingRefKey[];

/** The Zod validator for one of the six `ResourceBinding` ref kinds. */
export const resourceBindingRefKindSchema = z.enum(RESOURCE_BINDING_REF_KINDS);
export type ResourceBindingRefKind = z.infer<typeof resourceBindingRefKindSchema>;
