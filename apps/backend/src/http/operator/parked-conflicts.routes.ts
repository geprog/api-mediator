import {
  parkedConflictListResponseSchema,
  resolveParkedConflictRequestSchema,
  resolveParkedConflictResponseSchema,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toParkedConflictDto } from "./sync-dto.js";

/**
 * The Phase-4 Sync HTTP API — resolve-a-parked-conflict slice (SA-4). Thin handlers:
 * authenticate/authorize (OA-1/OA-2), validate the request, delegate every invariant to
 * {@link SyncOperatorService} — which resolves through the **normal pipeline** (a queued
 * re-run for `source-wins`/`target-wins`/`propagate`, a direct link tombstone for
 * `sever`), never a blind write. The queue read is `viewer`-ok; resolving is
 * `operator`-only (OA-2), attributed to the identity by the service (OA-3). No response
 * carries a raw contested value or credential material.
 *
 * - `GET  /api/parked-conflicts`             (viewer)   — SA-4.1 the open parked-conflict queue
 * - `POST /api/parked-conflicts/:id/resolve` (operator) — SA-4.2/4.3 resolve one conflict
 */
const parkedConflictQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function registerParkedConflictRoutes(
  app: FastifyInstance,
  sync: SyncOperatorService,
): void {
  // ── SA-4.1: the parked-conflict queue (open manual-resolve/withheld/drifted deletes) ──
  app.get(
    "/api/parked-conflicts",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { limit } = parseInput(parkedConflictQuerySchema, request.query, "query parameters");
      const conflicts = await sync.listParkedConflicts(limit);
      return parkedConflictListResponseSchema.parse({
        conflicts: conflicts.map(toParkedConflictDto),
      });
    },
  );

  // ── SA-4.2/4.3: resolve a parked conflict (through the normal pipeline) ─────
  app.post(
    "/api/parked-conflicts/:id/resolve",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        resolveParkedConflictRequestSchema,
        request.body,
        "parked-conflict resolution",
      );
      const actor = getPrincipal(request).identity;
      const outcome = await sync.resolveParkedConflict(id, body, actor);
      return resolveParkedConflictResponseSchema.parse({
        id,
        outcome: outcome.kind,
        resolution: outcome.resolution,
        conflict: toParkedConflictDto(outcome.conflict),
      });
    },
  );
}
