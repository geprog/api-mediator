import {
  ambiguousMatchListResponseSchema,
  createRecordLinkRequestSchema,
  createRecordLinkResponseSchema,
  unlinkRecordResponseSchema,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toAmbiguousMatchDto, toRecordLinkDto } from "./sync-dto.js";

/**
 * The Phase-4 Sync HTTP API — manual link/unlink slice (SA-3). Thin handlers:
 * authenticate/authorize (OA-1/OA-2), validate the request, delegate the link
 * lifecycle to {@link SyncOperatorService} → the engine's Identity Resolution stage
 * (RL-5). The ambiguous-match queue is a read (`viewer`-ok); link/unlink are
 * `operator`-only mutations, each attributed to the identity by the service (OA-3).
 * No response carries credential material or payload values.
 *
 * - `GET    /api/record-links/ambiguous-matches` (viewer)   — SA-3.3 the ambiguous queue
 * - `POST   /api/record-links`                   (operator) — SA-3.1 manual link
 * - `DELETE /api/record-links/:id`               (operator) — SA-3.2 unlink
 */
const ambiguousQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function registerRecordLinkRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  // ── SA-3.3: the ambiguous-match queue (candidate ids from failure details) ──
  app.get(
    "/api/record-links/ambiguous-matches",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { limit } = parseInput(ambiguousQuerySchema, request.query, "query parameters");
      const matches = await sync.listAmbiguousMatches(limit);
      return ambiguousMatchListResponseSchema.parse({ matches: matches.map(toAmbiguousMatchDto) });
    },
  );

  // ── SA-3.1: manual link (source record + chosen target record) → RL-5 ──────
  app.post(
    "/api/record-links",
    { preHandler: requireOperator },
    async (request, reply): Promise<unknown> => {
      const body = parseInput(createRecordLinkRequestSchema, request.body, "record-link request");
      const actor = getPrincipal(request).identity;
      const link = await sync.linkRecords(body, actor);
      void reply.code(201);
      return createRecordLinkResponseSchema.parse({ link: toRecordLinkDto(link) });
    },
  );

  // ── SA-3.2: unlink (sever a RecordLink) → RL-5 ─────────────────────────────
  app.delete(
    "/api/record-links/:id",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      await sync.unlinkRecord(id, actor);
      return unlinkRecordResponseSchema.parse({ id, unlinked: true });
    },
  );
}
