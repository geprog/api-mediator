import { z } from "zod";

import { approvedMappingStatusSchema } from "./approved-mapping-enums.js";
import { mappingVariantSchema } from "./mapping-enums.js";

/**
 * `ApprovedMapping` — the reviewed, human-approved mapping the Sync Engine and
 * Adapter Engine act on (`docs/architecture/data-model.md` `ApprovedMapping`,
 * requirement AM-2). A types-only shape: no behavior, no I/O.
 *
 * ## One-directional by construction
 *
 * The entity is **always** one-directional (`sourceSpecId → targetSpecId`, data
 * flowing source → target) and carries **no** `direction` field and no
 * reversible-transform notion. Bidirectional peer-peer sync is represented as two
 * paired rows cross-linked via {@link approvedMappingSchema.shape.counterpartMappingId}
 * — never as one entity with an inherently-reversible transform (a `Modeling
 * notes` invariant; AM-2 criterion 3).
 *
 * ## Variant conditionality (`counterpartMappingId`)
 *
 * `variant` is the modeling discriminant (peer-peer vs. consumer-provider,
 * `mapping-enums.ts` `MappingVariant`), derived mechanically from the pair's spec
 * roles. It is carried as a field here (unlike `FieldMapping`, whose variant is
 * observable via `phase` presence) because an approved mapping needs to route its
 * own instantiation. `counterpartMappingId` is **peer-peer only**: a
 * consumer-provider mapping has no reverse direction (the mediator never calls the
 * consumer), so a present value on a consumer-provider mapping is made
 * *unrepresentable* by the refinement below — the same latitude Phase 2 used for
 * `MappingSuggestionSet` (AM-2 criterion 2).
 */
export const approvedMappingSchema = z
  .object({
    id: z.string(),
    // `sourceSpecId`/`targetSpecId` pin the exact `ApiSpec` row on each side and
    // are the source of truth; the app ids below are query-convenience
    // denormalizations of them (AM-2 criterion 1).
    sourceSpecId: z.string(),
    targetSpecId: z.string(),
    sourceAppId: z.string(),
    targetAppId: z.string(),
    variant: mappingVariantSchema,
    approvedBy: z.string(),
    approvedAt: z.date(),
    status: approvedMappingStatusSchema,
    // Peer-peer only, optional and nullable: links the reverse-direction mapping
    // between the same two spec lineages once both are approved. The refinement
    // below makes a present value on a consumer-provider mapping unrepresentable.
    counterpartMappingId: z.string().nullable().optional(),
  })
  .superRefine((mapping, ctx) => {
    if (mapping.variant === "consumer-provider" && mapping.counterpartMappingId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "counterpartMappingId is peer-peer only — a consumer-provider mapping has no reverse direction",
        path: ["counterpartMappingId"],
      });
    }
  });
export type ApprovedMapping = z.infer<typeof approvedMappingSchema>;
