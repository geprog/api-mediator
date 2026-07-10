import { z } from "zod";

import { apiSpecRoleSchema, apiSpecStatusSchema } from "./enums.js";
import { irSchema } from "./ir.js";

/**
 * `ApiSpec` — an OpenAPI document registered for an app in a given role, parsed
 * into an {@link Ir} (see `docs/architecture/data-model.md` `ApiSpec` and
 * requirement SI-2).
 *
 * - `rawDocument` is the original OpenAPI document as a parsed JSON object.
 *   Modeled as `Record<string, unknown>` (an OpenAPI document is a JSON object)
 *   — `@mediator/db` stores it as `jsonb`. Any non-JSON input (e.g. YAML) is
 *   parsed to this object form by the ingestion slice before it reaches here.
 * - `parsedIR` carries the normalized IR; `@mediator/db` persists it as
 *   `jsonb.$type<Ir>()`.
 * - `version` is a monotonic integer. Phase 1 only ever creates `version = 1`;
 *   the type stays a general positive integer because later phases increment it.
 * - `analysisExclusions` is the operator-set list of `resourceRef`s excluded
 *   from mapping analysis (default empty — every resource group in scope).
 */
export const apiSpecSchema = z.object({
  id: z.string(),
  appId: z.string(),
  role: apiSpecRoleSchema,
  rawDocument: z.record(z.string(), z.unknown()),
  parsedIR: irSchema,
  analysisExclusions: z.array(z.string()),
  version: z.number().int().positive(),
  contentHash: z.string(),
  status: apiSpecStatusSchema,
  createdAt: z.date(),
});
export type ApiSpec = z.infer<typeof apiSpecSchema>;
