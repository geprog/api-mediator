import {
  appLifecycleTransitionResponseSchema,
  appListResponseSchema,
  appSpecsResponseSchema,
  registerAppRequestSchema,
  registerAppResponseSchema,
  type AppLifecycleTransitionResponse,
  type AppListResponse,
  type AppSpecsResponse,
  type RegisterAppResponse,
} from "@mediator/contracts";
import type { RegisteredApp } from "@mediator/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { NotFoundError } from "../../app-errors.js";
import { getPrincipal, requireOperator, requireViewer } from "../auth/index.js";
import { toApiSpecMetadataDto, toRegisteredAppDto } from "../dto-mappers.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";

/**
 * The AL-1 transition port the routes drive, structurally satisfied by
 * `AppLifecycleService`. Narrow by design (the routes own no persistence), so the route
 * tests can drive the whole surface with an in-memory double.
 */
export interface AppLifecycleMutator {
  disable(appId: string, actor: string): Promise<RegisteredApp>;
  enable(appId: string, actor: string): Promise<RegisteredApp>;
}

/**
 * App registration + browsing routes (AR-1, AR-2) and the AL-1 lifecycle transitions:
 * - `POST /api/apps` — register an app + its role-tagged specs (atomic); mutation,
 *   `operator` only (OA-2 crit 6).
 * - `GET /api/apps` — list all apps (unpaginated at Phase-1 scale, OQ7); `viewer`.
 * - `GET /api/apps/:id/specs` — the app's spec **metadata** (no `rawDocument`);
 *   `viewer`.
 * - `POST /api/apps/:id/disable` — AL-1.1 `active → disabled`; `operator` only.
 * - `POST /api/apps/:id/enable` — AL-1.3 `disabled → active`; `operator` only.
 *
 * The two transition handlers are **thin**: authenticate/authorize (OA-1/OA-2), validate
 * the path parameter, and delegate every invariant to {@link AppLifecycleMutator} — the
 * legal-transition guard, the operator attribution (AL-1.4/OA-3), the coupled `GraphEdge`
 * recompute (GR-2/GR-3) and the by-endpoint cache drop (XI-2). Both require an
 * `operator`; a `viewer` is rejected `403` by the pre-handler **before** the handler runs,
 * so nothing is mutated (AL-1.4). Disabling an already-`disabled` app (or enabling an
 * `active` one) surfaces as the service's `409`.
 *
 * Disable carries **no** destructive-confirmation step: it is reversible and touches no
 * rule/binding state (AL-4.3). The confirmed, destructive **deregister** is AL-2/AL-4 and
 * is deliberately not part of this surface.
 *
 * No response carries credential material (AR-1 crit 10, AR-2 crit 5).
 */
export function registerAppRoutes(app: FastifyInstance, deps: OperatorApiDeps): void {
  app.post(
    "/api/apps",
    { preHandler: requireOperator },
    async (request, reply): Promise<RegisterAppResponse> => {
      const body = parseInput(registerAppRequestSchema, request.body, "registration request");
      const result = await deps.registrar.register(body);
      const response: RegisterAppResponse = {
        app: toRegisteredAppDto(result.app),
        specs: result.specs.map(toApiSpecMetadataDto),
      };
      void reply.code(201);
      return registerAppResponseSchema.parse(response);
    },
  );

  app.get("/api/apps", { preHandler: requireViewer }, async (): Promise<AppListResponse> => {
    const apps = await deps.appReader.list();
    const response: AppListResponse = { apps: apps.map(toRegisteredAppDto) };
    return appListResponseSchema.parse(response);
  });

  app.get(
    "/api/apps/:id/specs",
    { preHandler: requireViewer },
    async (request): Promise<AppSpecsResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const owner = await deps.appReader.getById(id);
      if (owner === undefined) {
        throw new NotFoundError(`RegisteredApp ${id} not found.`);
      }
      const specs = await deps.specReader.listByAppId(id);
      const response: AppSpecsResponse = { specs: specs.map(toApiSpecMetadataDto) };
      return appSpecsResponseSchema.parse(response);
    },
  );

  // AL-1 — the reversible lifecycle transitions. Mounted only when the service is wired
  // (the real composition root always provides it); the in-memory unit harness that omits
  // it simply has no such routes, exactly like the sync/adapter surfaces.
  const lifecycle = deps.appLifecycle;
  if (lifecycle === undefined) {
    return;
  }

  // AL-1.1 — take the app out of service: its rules stop being polled and its bindings
  // fail `backend-disabled`, without a single rule/binding/cursor being written.
  app.post(
    "/api/apps/:id/disable",
    { preHandler: requireOperator },
    (request): Promise<AppLifecycleTransitionResponse> => transition(request, lifecycle, "disable"),
  );

  // AL-1.3 — lift the condition: rules resume under their stored status from their stored
  // cursors/snapshots, with no re-backfill.
  app.post(
    "/api/apps/:id/enable",
    { preHandler: requireOperator },
    (request): Promise<AppLifecycleTransitionResponse> => transition(request, lifecycle, "enable"),
  );
}

/** Shared disable/enable handler — the two differ only in which service method they call. */
async function transition(
  request: FastifyRequest,
  lifecycle: AppLifecycleMutator,
  action: "disable" | "enable",
): Promise<AppLifecycleTransitionResponse> {
  const { id } = parseInput(idParamSchema, request.params, "path parameters");
  const actor = getPrincipal(request).identity;
  const app =
    action === "disable" ? await lifecycle.disable(id, actor) : await lifecycle.enable(id, actor);
  return appLifecycleTransitionResponseSchema.parse({ app: toRegisteredAppDto(app) });
}
