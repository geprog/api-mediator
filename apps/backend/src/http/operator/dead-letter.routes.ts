import {
  deadLetterQueueResponseSchema,
  replayParkedWriteResponseSchema,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toDeadLetterWriteDto } from "./sync-dto.js";

/**
 * The Phase-4 Sync HTTP API — replay-a-parked-write slice (SA-5). Thin handlers:
 * authenticate/authorize (OA-1/OA-2), validate the request, delegate every invariant to
 * {@link SyncOperatorService} — which **reactivates** the parked entry so the running
 * dispatcher re-runs the standard pipeline against current state (SA-5.2), never a blind
 * re-issue. The dead-letter read is `viewer`-ok; replay is `operator`-only (OA-2),
 * attributed to the identity by the service (OA-3). No response carries a raw payload
 * value (never the `observedRecord`) or credential material (data boundary).
 *
 * - `GET  /api/dead-letter-writes`             (viewer)   — SA-5.1 the parked-write queue
 * - `POST /api/dead-letter-writes/:id/replay`  (operator) — SA-5.2/5.3 replay one write
 */
const deadLetterQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export function registerDeadLetterRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  // ── SA-5.1: the dead-letter queue (parked writes + superseded flag) ─────────
  app.get(
    "/api/dead-letter-writes",
    { preHandler: requireViewer },
    async (request): Promise<unknown> => {
      const { limit } = parseInput(deadLetterQuerySchema, request.query, "query parameters");
      const writes = await sync.listDeadLetterWrites(limit);
      return deadLetterQueueResponseSchema.parse({ writes: writes.map(toDeadLetterWriteDto) });
    },
  );

  // ── SA-5.2/5.3: replay a parked write (re-run through the pipeline) ──────────
  app.post(
    "/api/dead-letter-writes/:id/replay",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      const outcome = await sync.replayParkedWrite(id, actor);
      switch (outcome.kind) {
        case "reactivated":
          return replayParkedWriteResponseSchema.parse({ id, outcome: "reactivated" });
        case "not-found":
          throw new NotFoundError(`Parked write ${id} not found.`);
        case "not-parked":
          throw new BadRequestError(
            `Ordering-queue entry ${id} is not a parked write; there is nothing to replay.`,
          );
        case "superseded":
          throw new BadRequestError(
            `Parked write ${id} was already superseded by a later successful sync — no replay is needed (SA-5.3).`,
          );
        case "blocked-key-busy":
          throw new BadRequestError(
            `Parked write ${id} cannot be replayed while another change for the same record is still queued; retry once it drains.`,
          );
      }
    },
  );
}
