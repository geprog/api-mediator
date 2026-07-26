import {
  appLifecycleTransitionResponseSchema,
  appListResponseSchema,
  appSpecsResponseSchema,
  deregisterAppRequestSchema,
  deregisterAppResponseSchema,
  registerAppRequestSchema,
  registerAppResponseSchema,
  type AppDeregistrationSummaryDto,
  type AppLifecycleTransitionResponse,
  type AppListResponse,
  type AppSpecsResponse,
  type DeregisterAppResponse,
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
 * The AL-1/AL-2 transition port the routes drive, structurally satisfied by
 * `AppLifecycleService`. Narrow by design (the routes own no persistence), so the route
 * tests can drive the whole surface with an in-memory double.
 */
export interface AppLifecycleMutator {
  disable(appId: string, actor: string): Promise<RegisteredApp>;
  enable(appId: string, actor: string): Promise<RegisteredApp>;
  /**
   * AL-2 — the destructive, confirmed deregistration. `confirmation` is the operator's
   * explicit confirmation token (the app's exact name); the **service** validates it, so
   * this route never decides whether a cascade may run.
   */
  deregister(
    appId: string,
    actor: string,
    confirmation: string,
  ): Promise<{ readonly app: RegisteredApp; readonly summary: AppDeregistrationSummaryDto }>;
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
 * - `POST /api/apps/:id/deregister` — AL-2, destructive + **confirmed**; `operator` only.
 *
 * The transition handlers are **thin**: authenticate/authorize (OA-1/OA-2), validate the
 * path parameter (and, for deregister, the confirmation body), and delegate every
 * invariant to {@link AppLifecycleMutator} — the legal-transition guard, the confirmation
 * check itself, the whole deregister cascade, the operator attribution (AL-1.4/AL-2.8 /
 * OA-3), the coupled `GraphEdge` recompute (GR-2/GR-3) and the by-endpoint cache drop
 * (XI-2). All three require an `operator`; a `viewer` is rejected `403` by the pre-handler
 * **before** the handler runs, so nothing is mutated and no cascade starts (AL-1.4 /
 * AL-2.8). Disabling an already-`disabled` app (or enabling an `active` one) surfaces as
 * the service's `409`.
 *
 * Disable carries **no** destructive-confirmation step: it is reversible and touches no
 * rule/binding state (AL-4.3). Deregister does (AL-2.1): its body must carry
 * `confirm = <the app's exact name>`, so a bare `POST` fails validation with `400` before
 * anything is touched — an app cannot be deregistered by accident. The UI over these
 * routes is AL-4.
 *
 * No response carries credential material (AR-1 crit 10, AR-2 crit 5); the deregister
 * response's cascade summary is counts only.
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

  // AL-2 — the destructive, confirmed deregistration. The body's `confirm` must repeat the
  // app's exact name; a bare POST fails `400` here, and a wrong name fails `400` in the
  // service, both before a single row is touched.
  app.post(
    "/api/apps/:id/deregister",
    { preHandler: requireOperator },
    async (request): Promise<DeregisterAppResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(deregisterAppRequestSchema, request.body, "deregistration request");
      const actor = getPrincipal(request).identity;
      const result = await lifecycle.deregister(id, actor, body.confirm);
      return deregisterAppResponseSchema.parse({
        app: toRegisteredAppDto(result.app),
        cascade: result.summary,
      });
    },
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
