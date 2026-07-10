import { z } from "zod";

import { registeredAppStatusSchema } from "./enums.js";

/**
 * `RegisteredApp` and its declared `capabilities` — an application in the
 * landscape (see `docs/architecture/data-model.md` `RegisteredApp`).
 */

/**
 * What an app *can* do, declared at registration and stored at the app level.
 * The concrete fields/parameters that execute each capability are bound
 * per-resource via `ResourceBinding` (these flags only say the capability is
 * available at all).
 *
 * `defaultPollInterval` is modeled as a positive integer count of
 * **milliseconds** — the data model leaves the duration representation open, and
 * milliseconds match the rest of the config surface (e.g.
 * `MappingLlmConfig.requestTimeoutMs`) and Node's timer units. The glossary
 * field name is kept verbatim.
 */
export const appCapabilitiesSchema = z.object({
  supportsPolling: z.boolean(),
  supportsDeltaQuery: z.boolean(),
  supportsChangeTimestamps: z.boolean(),
  defaultPollInterval: z.number().int().positive(),
});
export type AppCapabilities = z.infer<typeof appCapabilitiesSchema>;

/**
 * `baseUrl` is optional and its **absence is meaningful**: a consumer-only app
 * (one that registered only a `CONSUMER` spec) has no reachable base URL because
 * the mediator itself hosts its endpoint via the Adapter Engine.
 *
 * Modeled with `.optional()`, which infers `string | undefined` — so the *type*
 * does not by itself keep "absent" distinct from an explicit `undefined`: a
 * present `baseUrl: undefined` is a valid value of this field, and Zod v4 carries
 * such a present-`undefined` key through `parse`. The guarantee is narrower and
 * runtime-only: parsing an input that **omits** `baseUrl` yields an object that
 * also omits the key (Zod does not materialize an absent optional as
 * `undefined`). Persistence relies on that omission guarantee, not on the type —
 * the `@mediator/db` row→domain mappers run a NULL `base_url` through
 * {@link stripUndefined} so it becomes a truly *absent* key rather than
 * `baseUrl: undefined`, keeping "absent" distinct under
 * `exactOptionalPropertyTypes`.
 */
export const registeredAppSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  status: registeredAppStatusSchema,
  baseUrl: z.string().min(1).optional(),
  capabilities: appCapabilitiesSchema,
  createdAt: z.date(),
});
export type RegisteredApp = z.infer<typeof registeredAppSchema>;
