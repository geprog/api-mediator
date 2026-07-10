import { z } from "zod";

import type { ExclusionsReplacer } from "../../modules/analysis-exclusions.js";
import type { AppReader, BindingReader, SpecReader } from "../../modules/persistence.js";
import type { Registrar } from "../../modules/registration.js";
import type { BindingConfirmer } from "../../modules/resource-bindings.js";

/**
 * Everything the operator `/api` routes depend on, injected by the composition
 * root. Reads go through the pooled reader ports; mutations through the
 * transactional services. Routes hold no persistence of their own, which is what
 * lets the unit tests drive the whole surface with in-memory fakes.
 */
export interface OperatorApiDeps {
  readonly registrar: Registrar;
  readonly appReader: AppReader;
  readonly specReader: SpecReader;
  readonly bindingReader: BindingReader;
  readonly bindingConfirmer: BindingConfirmer;
  readonly exclusionsReplacer: ExclusionsReplacer;
}

/**
 * The `:id` path parameter, shared by every entity-scoped route. Validated as a
 * UUID so a malformed id is a clean 400 at the boundary rather than reaching a
 * Drizzle `eq(<uuid column>, id)` and surfacing as a Postgres
 * `invalid input syntax for type uuid` 500. A well-formed-but-absent UUID still
 * falls through to a 404.
 */
export const idParamSchema = z.object({ id: z.uuid() });
