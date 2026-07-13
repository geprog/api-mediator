import { syncEventListResponseSchema, syncEventQuerySchema } from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import type { SyncEventFilter, SyncOperatorService } from "../../modules/sync/operator.js";
import { requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { toSyncEventDto } from "./sync-dto.js";

/**
 * The Phase-4 Sync HTTP API — sync audit log slice (SA-2.3). A read surface: both
 * `viewer` and `operator` may query the sync audit log filtered by rule/record/
 * status. The rows carry `status`/metadata/ids/hashes and `traceId`/`spanId` —
 * **never a payload value, never credential material** (`docs/architecture/security.md`).
 *
 * - `GET /api/sync-events?ruleId=&recordLinkId=&sourceNativeId=&status=&limit=` (viewer)
 */
export function registerSyncEventRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  app.get("/api/sync-events", { preHandler: requireViewer }, async (request): Promise<unknown> => {
    const query = parseInput(syncEventQuerySchema, request.query, "query parameters");
    const filter: SyncEventFilter = {
      ...(query.ruleId !== undefined ? { ruleId: query.ruleId } : {}),
      ...(query.recordLinkId !== undefined ? { recordLinkId: query.recordLinkId } : {}),
      ...(query.sourceNativeId !== undefined ? { sourceNativeId: query.sourceNativeId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    };
    const events = await sync.queryEvents(filter);
    return syncEventListResponseSchema.parse({ events: events.map(toSyncEventDto) });
  });
}
