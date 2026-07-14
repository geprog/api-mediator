import { triggerPollResponseSchema } from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import type { SyncOperatorService } from "../../modules/sync/operator.js";
import { requireOperator } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toPollRunOutcomeDto } from "./sync-dto.js";

/**
 * **The TEST/DEV-ONLY deterministic poll-trigger endpoint** (the SP-5 poll-trigger
 * hook the SU-6 capstone e2e drives).
 *
 * This route is a test/dev affordance, **not** an operator feature: it is registered
 * ONLY when the `sync.testPollTrigger` config flag is set (env `SYNC_TEST_POLL_TRIGGER`,
 * default false) AND the Sync Engine runtime is wired in — see {@link registerOperatorApi}.
 * With the flag off (production/dev) the route is not registered at all, so a request
 * 404s. The concept keeps the Scheduler on wall-clock intervals; a synchronous
 * single-cycle trigger only exists so an e2e can assert "no echo / no duplicate write"
 * deterministically (`docs/requirements/phase-4-scheduler-poller.md`).
 *
 * - `POST /api/sync-rules/:id/poll` (operator) — SP-5 run one poll cycle
 *
 * Thin handler: authenticate/authorize (OA-1 + `requireOperator` → 403 for a viewer,
 * since it is a mutation-shaped action), validate the id, delegate to
 * {@link SyncOperatorService.triggerPoll} (which delegates to the engine's `pollOnce`
 * seam — never re-implements polling), and project the {@link PollRunOutcome} to its
 * DTO (a count only, never a payload value or credential material). A `completed`/
 * `aborted` cycle is 200; a `skipped` (ineligible) rule is 422; a missing rule is a 404
 * from the service.
 */
export function registerPollTriggerRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  app.post(
    "/api/sync-rules/:id/poll",
    { preHandler: requireOperator },
    async (request, reply): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const outcome = await sync.triggerPoll(id);
      void reply.code(outcome.kind === "skipped" ? 422 : 200);
      return triggerPollResponseSchema.parse({ ruleId: id, outcome: toPollRunOutcomeDto(outcome) });
    },
  );
}
