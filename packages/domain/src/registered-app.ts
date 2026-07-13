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
 * Per-app **outbound load-discipline ceilings** — the operational limits the
 * shared Outbound Call Executor enforces across *all* traffic to this app
 * (polling, backfill enumeration, sync writes, and Phase-5 adapter fan-out
 * counted together — `docs/architecture/overview.md` *Outbound load discipline*;
 * requirement OC-3). These are **operational configuration on the app
 * registration**, not per-rule review decisions, and were deferred from Phase 1
 * (Phase-1 README open question 10) to be added here as an additive field.
 *
 * Modeled as a single optional object (like `capabilities`): **absent** means the
 * app declares no ceilings and the executor applies its configured defaults
 * (README OC-3 resolution: "config-level defaults where omitted"). The three
 * numbers are the concept's two ceilings made concrete:
 *
 * - `maxConcurrentRequests` — the **concurrency ceiling**: the most outbound calls
 *   the executor may have in flight to this app at once.
 * - `maxRequestsPerWindow` over `rateWindowMs` — the **request-rate ceiling**: at
 *   most this many outbound calls may *start* per rolling window of this length.
 *   A fixed window (count + length) is the deterministic representation choice; the
 *   concept fixes the ceiling *inputs*, not the limiter algorithm.
 */
export const outboundLoadLimitsSchema = z.object({
  maxConcurrentRequests: z.number().int().positive(),
  maxRequestsPerWindow: z.number().int().positive(),
  rateWindowMs: z.number().int().positive(),
});
export type OutboundLoadLimits = z.infer<typeof outboundLoadLimitsSchema>;

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
  // Phase-4 additive field (OC-3): absent → the executor's configured defaults
  // apply. Absence is meaningful and kept distinct from `undefined` exactly like
  // `baseUrl` (persistence collapses a NULL column to an absent key).
  outboundLimits: outboundLoadLimitsSchema.optional(),
  createdAt: z.date(),
});
export type RegisteredApp = z.infer<typeof registeredAppSchema>;
