import {
  updateResourceBindingRequestSchema,
  updateResourceBindingResponseSchema,
  type UpdateResourceBindingResponse,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import { toResourceBindingDto } from "../dto-mappers.js";
import { resolveOperatorIdentity } from "../identity.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";

/**
 * `PATCH /api/resource-bindings/:id` — confirm or correct one `ResourceBinding`
 * ref (RB-2). The acting operator identity is resolved via the Phase-3 stub
 * ({@link resolveOperatorIdentity}) and stamped into `confirmedBy`. Validation
 * (not-applicable ref, correction target not in IR) and 404s live in the service.
 */
export function registerResourceBindingRoutes(app: FastifyInstance, deps: OperatorApiDeps): void {
  app.patch(
    "/api/resource-bindings/:id",
    async (request): Promise<UpdateResourceBindingResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        updateResourceBindingRequestSchema,
        request.body,
        "resource-binding update",
      );
      const operatorIdentity = resolveOperatorIdentity(request);
      const result = await deps.bindingConfirmer.confirmOrCorrect(id, body, operatorIdentity);
      return updateResourceBindingResponseSchema.parse(
        toResourceBindingDto(result.binding, result.capabilities),
      );
    },
  );
}
