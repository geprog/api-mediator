import {
  updateResourceBindingRequestSchema,
  updateResourceBindingResponseSchema,
  type UpdateResourceBindingResponse,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import { getPrincipal, requireOperator } from "../auth/index.js";
import { toResourceBindingDto } from "../dto-mappers.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";

/**
 * `PATCH /api/resource-bindings/:id` — confirm or correct one binding of a
 * `ResourceBinding`: either an **operational ref** (RB-2, addressed by `refKind`)
 * or a **scope path-parameter constant** (SS-3, addressed by `parameterName`),
 * distinguished by the discriminated-union request DTO. A mutation, so `operator`
 * only (OA-2/SS-3.5). The acting identity is the authenticated principal (OA-3):
 * {@link getPrincipal} yields it, and it is stamped into `confirmedBy`. Validation
 * (not-applicable ref / correction target not in IR / empty scope value / scope
 * parameter not in the resource's derived set) and 404s live in the service.
 */
export function registerResourceBindingRoutes(app: FastifyInstance, deps: OperatorApiDeps): void {
  app.patch(
    "/api/resource-bindings/:id",
    { preHandler: requireOperator },
    async (request): Promise<UpdateResourceBindingResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        updateResourceBindingRequestSchema,
        request.body,
        "resource-binding update",
      );
      const operatorIdentity = getPrincipal(request).identity;
      const result = await deps.bindingConfirmer.confirmOrCorrect(id, body, operatorIdentity);
      return updateResourceBindingResponseSchema.parse(
        toResourceBindingDto(result.binding, result.capabilities),
      );
    },
  );
}
