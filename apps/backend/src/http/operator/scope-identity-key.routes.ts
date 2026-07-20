import {
  confirmScopeIdentityKeyRequestSchema,
  confirmScopeIdentityKeyResponseSchema,
  scopeIdentityKeyDerivationResponseSchema,
  type ScopeIdentityKeyDerivationResponse,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { toScopeCorrespondenceDto } from "./sync-dto.js";

/**
 * The scoped-resource-sync **scope-identity-key** HTTP API (SS-15.4) — the thin
 * derive-then-correct panel backend, mirroring the RA-3 identity-key confirm route
 * shape. The derive read surfaces the pair's `ScopeCorrespondence` (SS-10) — home of
 * the mediator's pre-selected candidate pairing (*source `sourceScopeRef` component ↔
 * target container field*) — and the confirm write stamps/corrects it. Thin handlers:
 * authenticate/authorize (OA-1/OA-2), validate, delegate every invariant to
 * {@link SyncOperatorService}. The **value-preserving (`rename`-only)** rule is enforced
 * by the request schema (a value-altering pairing → 400), exactly like AS-5. No response
 * carries credential material or a live payload value (scope config, not secrets).
 *
 * - `GET  /api/scope-identity-key?resourcePairRef=…` (viewer)   — SS-15.4 derive candidate
 * - `POST /api/scope-identity-key`                   (operator) — SS-15.4 confirm/correct
 */
const deriveQuerySchema = z.object({ resourcePairRef: z.string().min(1) });

export function registerScopeIdentityKeyRoutes(
  app: FastifyInstance,
  sync: SyncOperatorService,
): void {
  // ── SS-15.4: derive the candidate scope identity key (viewer-ok read) ────────
  app.get(
    "/api/scope-identity-key",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { resourcePairRef } = parseInput(deriveQuerySchema, request.query, "query parameters");
      const correspondence = await sync.getScopeCorrespondence(resourcePairRef);
      const response: ScopeIdentityKeyDerivationResponse = {
        resourcePairRef,
        correspondence:
          correspondence === undefined ? null : toScopeCorrespondenceDto(correspondence),
      };
      return scopeIdentityKeyDerivationResponseSchema.parse(response);
    },
  );

  // ── SS-15.4: confirm (or correct) the value-preserving pairing (operator) ────
  app.post(
    "/api/scope-identity-key",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const body = parseInput(
        confirmScopeIdentityKeyRequestSchema,
        request.body,
        "scope-identity-key confirmation",
      );
      const actor = getPrincipal(request).identity;
      const saved = await sync.confirmScopeIdentityKey(
        { resourcePairRef: body.resourcePairRef, scopeIdentityKey: body.scopeIdentityKey },
        actor,
      );
      return confirmScopeIdentityKeyResponseSchema.parse({
        correspondence: toScopeCorrespondenceDto(saved),
      });
    },
  );
}
