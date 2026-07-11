import { z } from "zod";

import { operationActionSchema } from "./approved-mapping-enums.js";
import { transformConfigSchema } from "./field-mapping.js";
import { transformKindSchema } from "./mapping-enums.js";

/**
 * `OperationMapping` and `ParameterMapping` — the approved operation-level and
 * operation-input correspondences under an `ApprovedMapping`
 * (`docs/architecture/data-model.md` `OperationMapping` / `ParameterMapping`,
 * requirement AM-4). The persisted forms of accepted `kind = operation` /
 * `kind = parameter` `MappingProposalItem`s. Types only: no operation is selected
 * and no parameter is filled here.
 */

// ── OperationMapping ─────────────────────────────────────────────────────────

/**
 * Tells the executing engines *which target operation to call*: the Sync Engine
 * selects the operation whose `action` matches the change type it propagates, and
 * `AdapterBinding.backendOperationId` is chosen from these rows.
 *
 * `sourceOperationRef`/`targetOperationRef` are resource-qualified IR operation
 * refs, modeled as plain strings (this entity is operation-only).
 *
 * `targetIdParamRef` is the one conditionally-meaningful field: on
 * `action = update | delete` rows of a **peer-peer** mapping it names which target
 * parameter receives the linked record's target-side native id from the
 * `RecordLink`. It is **absent on `action = create | read`** rows — enforced here
 * — and **absent on consumer-provider** mappings (those fill inputs via
 * `ParameterMapping`s). The peer-peer-vs-consumer-provider distinction is **not**
 * schema-enforceable on this entity: the concept's `OperationMapping` (AM-4
 * criterion 1) carries no `variant` discriminant and no `phase` (operations are
 * phase-agnostic), unlike `FieldMapping` whose variant is observable via `phase`.
 * That restriction is therefore a cross-entity invariant of the parent
 * `ApprovedMapping.variant` (a consumer-provider mapping's `OperationMapping`s are
 * constructed without `targetIdParamRef`); the locally-representable half —
 * `targetIdParamRef ⇒ action ∈ {update, delete}` — is enforced by the refinement.
 */
export const operationMappingSchema = z
  .object({
    id: z.string(),
    mappingId: z.string(),
    sourceOperationRef: z.string(),
    targetOperationRef: z.string(),
    action: operationActionSchema,
    targetIdParamRef: z.string().optional(),
  })
  .superRefine((operation, ctx) => {
    if (
      operation.targetIdParamRef !== undefined &&
      operation.action !== "update" &&
      operation.action !== "delete"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "targetIdParamRef is meaningful only on action = update | delete rows",
        path: ["targetIdParamRef"],
      });
    }
  });
export type OperationMapping = z.infer<typeof operationMappingSchema>;

// ── ParameterMapping (consumer-provider only) ────────────────────────────────

/**
 * How the Adapter Engine fills a backend operation's parameters (path/query/
 * header) from the consumer's inbound request. Parameters are inherently
 * per-operation, so these rows hang off the `OperationMapping` that pairs the two
 * operations (`operationMappingId`) rather than off the resource-level
 * `FieldMapping` set.
 *
 * `ParameterMapping`s exist **only** under consumer-provider `ApprovedMapping`s;
 * peer-peer mappings have none — the sync pipeline fills target parameters from
 * the `RecordLink` via `OperationMapping.targetIdParamRef` (AM-4 criterion 4).
 * That exclusivity needs no discriminant field: a `ParameterMapping` is
 * inherently a consumer-provider artifact, so a peer-peer mapping simply has no
 * rows of this entity.
 *
 * `transform`/`transformConfig` are optional (a parameter may pass through
 * untransformed) and share `FieldMapping`'s vocabulary and config shape.
 */
export const parameterMappingSchema = z.object({
  id: z.string(),
  operationMappingId: z.string(),
  sourceParamRef: z.string(),
  targetParamRef: z.string(),
  transform: transformKindSchema.optional(),
  transformConfig: transformConfigSchema.optional(),
});
export type ParameterMapping = z.infer<typeof parameterMappingSchema>;
