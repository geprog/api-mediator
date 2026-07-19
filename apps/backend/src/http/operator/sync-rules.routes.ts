import {
  configureSyncRuleRequestSchema,
  configureSyncRuleResponseSchema,
  disableSyncRuleResponseSchema,
  enableSyncRuleRequestSchema,
  enableSyncRuleResponseSchema,
  syncRuleListResponseSchema,
  type ConfigureSyncRuleRequest,
  type EnableSyncRuleRequest,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import type {
  EnableRuleRequest,
  SyncOperatorService,
  SyncRuleConfig,
} from "../../modules/sync/operator.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";
import { toEnableSyncRuleResponse, toSyncRuleStatusDto } from "./sync-dto.js";

/**
 * The Phase-4 Sync HTTP API — `SyncRule` slice (SA-1 configure/enable/disable,
 * SA-2 rule list). Thin handlers: authenticate/authorize (OA-1/OA-2), validate the
 * request shape, delegate every invariant to {@link SyncOperatorService} (which
 * delegates the enablement gate + backfill to the Sync Engine). Reads are
 * `viewer`-ok; every mutation requires `operator` (OA-2); each mutation is
 * attributed to the authenticated identity by the service (OA-3). No response
 * carries credential material.
 *
 * - `GET   /api/sync-rules`               (viewer)   — SA-2.1/2.2 list + gate + lag
 * - `PATCH /api/sync-rules/:id/config`    (operator) — SA-1.1 configure a disabled rule
 * - `POST  /api/sync-rules/:id/enable`    (operator) — SA-1.2/1.3 enable through the gate
 * - `POST  /api/sync-rules/:id/disable`   (operator) — SA-1.4 disable (state retained)
 */
export function registerSyncRuleRoutes(app: FastifyInstance, sync: SyncOperatorService): void {
  // ── SA-2.1/2.2: list rules with status/backfill/lastRun/lastEvent/pair/gate/lag ──
  app.get("/api/sync-rules", { preHandler: requireViewer }, async (): Promise<unknown> => {
    const views = await sync.listRules();
    return syncRuleListResponseSchema.parse({ rules: views.map(toSyncRuleStatusDto) });
  });

  // ── SA-1.1: configure a disabled rule's execution options ──────────────────
  app.patch(
    "/api/sync-rules/:id/config",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(configureSyncRuleRequestSchema, request.body, "sync-rule config");
      const actor = getPrincipal(request).identity;
      const view = await sync.configureRule(id, toSyncRuleConfig(body), actor);
      return configureSyncRuleResponseSchema.parse(toSyncRuleStatusDto(view));
    },
  );

  // ── SA-1.2/1.3: enable — 202 accepted (backfill runs in background) / 422 blocked ──
  app.post(
    "/api/sync-rules/:id/enable",
    { preHandler: requireOperator },
    async (request, reply): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(enableSyncRuleRequestSchema, request.body, "sync-rule enable");
      const actor = getPrincipal(request).identity;
      const outcome = await sync.enableRule(id, toEnableRequest(body), actor);
      void reply.code(outcome.kind === "accepted" ? 202 : 422);
      return enableSyncRuleResponseSchema.parse(toEnableSyncRuleResponse(outcome));
    },
  );

  // ── SA-1.4: disable — polling stops, execution state retained ──────────────
  app.post(
    "/api/sync-rules/:id/disable",
    { preHandler: requireOperator },
    async (request): Promise<unknown> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      const view = await sync.disableRule(id, actor);
      return disableSyncRuleResponseSchema.parse(toSyncRuleStatusDto(view));
    },
  );
}

/**
 * Map the SA-1.1 config DTO to the service shape, **preserving key presence** for the
 * nullable `pollIntervalOverride` (present-as-`null` clears the override, absent leaves
 * it) so an omitted option is never mistaken for a clear.
 */
function toSyncRuleConfig(body: ConfigureSyncRuleRequest): SyncRuleConfig {
  return {
    // `null` clears the override, a number sets it; `undefined`/absent leaves it.
    ...(body.pollIntervalOverride !== undefined
      ? { pollIntervalOverride: body.pollIntervalOverride }
      : {}),
    ...(body.pollOperationRef !== undefined ? { pollOperationRef: body.pollOperationRef } : {}),
    ...(body.deletePropagation !== undefined ? { deletePropagation: body.deletePropagation } : {}),
    ...(body.targetDriftCheck !== undefined ? { targetDriftCheck: body.targetDriftCheck } : {}),
    // SS-13.5 — `null` clears the poll-scope-mode override to derived; a value pins it.
    ...("pollScopeMode" in body ? { pollScopeMode: body.pollScopeMode ?? null } : {}),
    ...(body.fieldConflictPolicies !== undefined
      ? { fieldConflictPolicies: body.fieldConflictPolicies }
      : {}),
  };
}

/** Map the SA-1.2 enable DTO to the service's `EnableRuleRequest`. */
function toEnableRequest(body: EnableSyncRuleRequest): EnableRuleRequest {
  return body.action === "backfill"
    ? { action: "backfill", backfillMode: body.backfillMode }
    : { action: "skip-backfill" };
}
