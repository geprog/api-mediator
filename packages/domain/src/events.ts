import { z } from "zod";

import { apiSpecRoleSchema } from "./enums.js";

/**
 * Domain events carried by the Event Bus.
 *
 * A small base **envelope** (`id`, `type` discriminant, `occurredAt`) that every
 * event shares; concrete events extend it with their payload and narrow `type`
 * to a literal. Phase 1 defines exactly one event, `SpecIngested`; later phases
 * add more (`MappingApproved`, sync writes, …) as further `type` literals over
 * the same envelope, so a discriminated union across events is natural.
 */

/** The `type` discriminant value for the {@link SpecIngested} event. */
export const SPEC_INGESTED_EVENT_TYPE = "SpecIngested";

/**
 * The base envelope every domain event fits into. `type` is a plain string here;
 * each concrete event narrows it to its own literal.
 */
export const domainEventEnvelopeSchema = z.object({
  id: z.string(),
  type: z.string(),
  occurredAt: z.date(),
});
export type DomainEventEnvelope = z.infer<typeof domainEventEnvelopeSchema>;

/**
 * `SpecIngested` — emitted by the Spec Registry once a new `ApiSpec` version is
 * parsed and stored; it is what triggers mapping detection in Phase 2 (see
 * `docs/glossary.md` `SpecIngested`).
 *
 * The payload references the stored spec by id plus its owning app and role —
 * deliberately **no credential material and no reference that resolves to any**
 * (CR-2 criterion 3): everything here is an identifier or an enum.
 */
export const specIngestedSchema = domainEventEnvelopeSchema.extend({
  type: z.literal(SPEC_INGESTED_EVENT_TYPE),
  apiSpecId: z.string(),
  appId: z.string(),
  role: apiSpecRoleSchema,
});
export type SpecIngested = z.infer<typeof specIngestedSchema>;
