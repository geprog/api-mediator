import {
  appListResponseSchema,
  appSpecsResponseSchema,
  registerAppRequestSchema,
  registerAppResponseSchema,
  type AppListResponse,
  type AppSpecsResponse,
  type RegisterAppResponse,
} from "@mediator/contracts";
import type { FastifyInstance } from "fastify";

import { NotFoundError } from "../../app-errors.js";
import { requireOperator, requireViewer } from "../auth/index.js";
import { toApiSpecMetadataDto, toRegisteredAppDto } from "../dto-mappers.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";

/**
 * App registration + browsing routes (AR-1, AR-2):
 * - `POST /api/apps` — register an app + its role-tagged specs (atomic); mutation,
 *   `operator` only (OA-2 crit 6).
 * - `GET /api/apps` — list all apps (unpaginated at Phase-1 scale, OQ7); `viewer`.
 * - `GET /api/apps/:id/specs` — the app's spec **metadata** (no `rawDocument`);
 *   `viewer`.
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
}
