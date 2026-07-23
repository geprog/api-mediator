import {
  approvedMappingListResponseSchema,
  approvedMappingTransitionResponseSchema,
  type ApprovedMappingDto,
  type ApprovedMappingListResponse,
  type ApprovedMappingTransitionResponse,
} from "@mediator/contracts";
import type { ApprovedMapping } from "@mediator/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";

/** The read port behind `GET /api/approved-mappings` (the real `ApprovedMappingRepository`). */
export interface ApprovedMappingReader {
  listAll(): Promise<ApprovedMapping[]>;
}

/**
 * The SL-10 transition port the routes drive, structurally satisfied by
 * `ApprovedMappingSuspensionService`. Narrow by design (the routes own no persistence), so
 * the route tests can drive the whole surface with an in-memory double.
 */
export interface ApprovedMappingSuspensionMutator {
  suspend(mappingId: string, actor: string): Promise<ApprovedMapping>;
  resume(mappingId: string, actor: string): Promise<ApprovedMapping>;
}

/**
 * **SL-10 — the `ApprovedMapping` lifecycle routes**: read every approved mapping's current
 * `status`, and put one on a manual hold / lift it again.
 *
 * - `GET  /api/approved-mappings`            (viewer)   — SL-10 read surface
 * - `POST /api/approved-mappings/:id/suspend` (operator) — SL-10.1 `active → suspended`
 * - `POST /api/approved-mappings/:id/resume`  (operator) — SL-10.2 `suspended → active`
 *
 * Handlers are **thin**: authenticate/authorize (OA-1/OA-2), validate the path parameter,
 * and delegate every transition invariant to {@link ApprovedMappingSuspensionMutator} — the
 * legal-transition guard, the operator attribution (OA-3), the coupled cache drop (XI-2) and
 * the `GraphEdge` recompute (GR-2/GR-3). Both mutations require an `operator`; a `viewer` is
 * rejected `403` by the pre-handler **before** the handler runs, so nothing is mutated. An
 * illegal transition (suspending a non-`active`, resuming a non-`suspended` mapping — e.g.
 * one the breaking flow marked `stale` while it was suspended, which needs re-review rather
 * than a resume) surfaces as the service's `409`.
 *
 * No response carries credential material, IR payload, or reviewed field content.
 */
export function registerApprovedMappingRoutes(
  app: FastifyInstance,
  suspension: ApprovedMappingSuspensionMutator,
  mappings: ApprovedMappingReader,
): void {
  app.get(
    "/api/approved-mappings",
    { preHandler: requireViewer },
    async (): Promise<ApprovedMappingListResponse> => {
      const rows = await mappings.listAll();
      return approvedMappingListResponseSchema.parse({ mappings: rows.map(toApprovedMappingDto) });
    },
  );

  // SL-10.1 — the manual hold: rules pause and adapter bindings fail `mapping-suspended`.
  app.post(
    "/api/approved-mappings/:id/suspend",
    { preHandler: requireOperator },
    (request): Promise<ApprovedMappingTransitionResponse> =>
      transition(request, suspension, "suspend"),
  );

  // SL-10.2 — the exact inverse: rules/bindings resume under their stored state.
  app.post(
    "/api/approved-mappings/:id/resume",
    { preHandler: requireOperator },
    (request): Promise<ApprovedMappingTransitionResponse> =>
      transition(request, suspension, "resume"),
  );
}

/** Shared suspend/resume handler — the two differ only in which service method they call. */
async function transition(
  request: FastifyRequest,
  suspension: ApprovedMappingSuspensionMutator,
  action: "suspend" | "resume",
): Promise<ApprovedMappingTransitionResponse> {
  const { id } = parseInput(idParamSchema, request.params, "path parameters");
  const actor = getPrincipal(request).identity;
  const mapping =
    action === "suspend" ? await suspension.suspend(id, actor) : await suspension.resume(id, actor);
  return approvedMappingTransitionResponseSchema.parse({ mapping: toApprovedMappingDto(mapping) });
}

/** An `ApprovedMapping` → its wire DTO (`approvedAt` `Date` → ISO string). Metadata only. */
export function toApprovedMappingDto(mapping: ApprovedMapping): ApprovedMappingDto {
  return {
    id: mapping.id,
    variant: mapping.variant,
    status: mapping.status,
    sourceAppId: mapping.sourceAppId,
    targetAppId: mapping.targetAppId,
    sourceSpecId: mapping.sourceSpecId,
    targetSpecId: mapping.targetSpecId,
    approvedBy: mapping.approvedBy,
    approvedAt: mapping.approvedAt.toISOString(),
  };
}
