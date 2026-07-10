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

/** The `:id` path parameter, shared by every entity-scoped route. */
export const idParamSchema = z.object({ id: z.string().min(1) });
