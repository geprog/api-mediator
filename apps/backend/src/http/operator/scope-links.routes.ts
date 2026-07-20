import {
  createScopeLinkRequestSchema,
  createScopeLinkResponseSchema,
  parkedContainerLinkListResponseSchema,
  scopeLinkCandidateContextResponseSchema,
  unlinkScopeLinkResponseSchema,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toParkedContainerLinkDto, toScopeLinkDto } from "./sync-dto.js";

/**
 * The scoped-resource-sync L3 HTTP API — **container** link/unlink slice (SS-11.6) +
 * the parked-container-link queue (SS-11.5). Thin handlers: authenticate/authorize
 * (OA-1/OA-2), validate the request, delegate the link lifecycle to
 * {@link SyncOperatorService} → the SS-11 scope-discovery stage. The parked queue is a
 * read (`viewer`-ok); link/unlink are `operator`-only mutations, each attributed to the
 * identity by the service (OA-3). No response carries credential material or payload
 * values (scope keys are operator config, not secrets).
 *
 * These are the thin endpoints the SS-15 container-linking UI (and an e2e) will drive;
 * no frontend ships here.
 *
 * - `GET    /api/scope-links/parked`     (viewer)   — SS-11.5 the parked container-link queue
 * - `GET    /api/scope-links/candidates` (viewer)   — SS-15.5 per-pair target linking context
 * - `POST   /api/scope-links`        (operator) — SS-11.6 manual container link
 * - `DELETE /api/scope-links/:id`    (operator) — SS-11.6 unlink a container link
 */
const parkedQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});
const candidatesQuerySchema = z.object({ resourcePairRef: z.string().min(1) });

export function registerScopeLinkRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  // ── SS-11.5: the parked container-linking queue (surfaced from discovery failures) ──
  app.get(
    "/api/scope-links/parked",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { limit } = parseInput(parkedQuerySchema, request.query, "query parameters");
      const parked = await sync.listParkedContainerLinks(limit);
      return parkedContainerLinkListResponseSchema.parse({
        parked: parked.map(toParkedContainerLinkDto),
      });
    },
  );

  // ── SS-15.5: per-pair target-container linking context (targetAppId + component) ──
  app.get(
    "/api/scope-links/candidates",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { resourcePairRef } = parseInput(
        candidatesQuerySchema,
        request.query,
        "query parameters",
      );
      const context = await sync.getScopeLinkCandidateContext(resourcePairRef);
      return scopeLinkCandidateContextResponseSchema.parse(context);
    },
  );

  // ── SS-11.6: manually link two containers → establishedBy = manual ─────────
  app.post(
    "/api/scope-links",
    { preHandler: requireOperator },
    async (request, reply): Promise<unknown> => {
      const body = parseInput(createScopeLinkRequestSchema, request.body, "scope-link request");
      const actor = getPrincipal(request).identity;
      const link = await sync.linkContainers(body, actor);
      void reply.code(201);
      return createScopeLinkResponseSchema.parse({ link: toScopeLinkDto(link) });
    },
  );

  // ── SS-11.6: unlink (sever a ScopeLink) ────────────────────────────────────
  app.delete(
    "/api/scope-links/:id",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      await sync.unlinkContainer(id, actor);
      return unlinkScopeLinkResponseSchema.parse({ id, unlinked: true });
    },
  );
}
