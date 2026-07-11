import {
  irResponseSchema,
  previewParseRequestSchema,
  previewParseResponseSchema,
  resourceBindingsResponseSchema,
  updateAnalysisExclusionsRequestSchema,
  updateAnalysisExclusionsResponseSchema,
  type IrResponse,
  type PreviewParseResponse,
  type ResourceBindingsResponse,
  type UpdateAnalysisExclusionsResponse,
} from "@mediator/contracts";
import type { Ir } from "@mediator/domain";
import { buildIr, IrError } from "@mediator/ir";
import type { FastifyInstance } from "fastify";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import { requireOperator, requireViewer } from "../auth/index.js";
import {
  toApiSpecMetadataDto,
  toResourceBindingDto,
  toResourceGroupSummaries,
} from "../dto-mappers.js";
import { parseInput } from "../validation.js";
import { idParamSchema, type OperatorApiDeps } from "./deps.js";

/**
 * Spec-scoped routes:
 * - `GET /api/specs/:id/ir` — the parsed IR (SI-3); `viewer`.
 * - `GET /api/specs/:id/resource-bindings` — the spec's bindings, each ref's
 *   value + confirmed/unconfirmed/not-applicable state (RB-3); `viewer`.
 * - `PATCH /api/specs/:id/analysis-exclusions` — replace the exclusion list
 *   (SI-4); mutation, `operator` only (OA-2 crit 6).
 * - `POST /api/specs/preview` — **stateless** preview-parse (AR-3/SI-4): parse a
 *   document to IR + resource groups, creating no `RegisteredApp`/`ApiSpec`. It
 *   mutates no landscape state, so it is `viewer`-readable (not an OA-2 mutation).
 *
 * None of these return `rawDocument` or any credential material.
 */
export function registerSpecRoutes(app: FastifyInstance, deps: OperatorApiDeps): void {
  app.get(
    "/api/specs/:id/ir",
    { preHandler: requireViewer },
    async (request): Promise<IrResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const spec = await deps.specReader.getById(id);
      if (spec === undefined) {
        throw new NotFoundError(`ApiSpec ${id} not found.`);
      }
      const response: IrResponse = { apiSpecId: spec.id, ir: spec.parsedIR };
      return irResponseSchema.parse(response);
    },
  );

  app.get(
    "/api/specs/:id/resource-bindings",
    { preHandler: requireViewer },
    async (request): Promise<ResourceBindingsResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const spec = await deps.specReader.getById(id);
      if (spec === undefined) {
        throw new NotFoundError(`ApiSpec ${id} not found.`);
      }
      const owner = await deps.appReader.getById(spec.appId);
      if (owner === undefined) {
        throw new NotFoundError(`RegisteredApp ${spec.appId} not found.`);
      }
      const bindings = await deps.bindingReader.listByApiSpecId(id);
      const response: ResourceBindingsResponse = {
        bindings: bindings.map((binding) => toResourceBindingDto(binding, owner.capabilities)),
      };
      return resourceBindingsResponseSchema.parse(response);
    },
  );

  app.patch(
    "/api/specs/:id/analysis-exclusions",
    { preHandler: requireOperator },
    async (request): Promise<UpdateAnalysisExclusionsResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const body = parseInput(
        updateAnalysisExclusionsRequestSchema,
        request.body,
        "analysis-exclusions request",
      );
      const updated = await deps.exclusionsReplacer.replace(id, body.analysisExclusions);
      return updateAnalysisExclusionsResponseSchema.parse(toApiSpecMetadataDto(updated));
    },
  );

  app.post(
    "/api/specs/preview",
    { preHandler: requireViewer },
    async (request): Promise<PreviewParseResponse> => {
      const body = parseInput(previewParseRequestSchema, request.body, "preview request");
      let ir: Ir;
      try {
        ir = await buildIr(body.document);
      } catch (error) {
        if (error instanceof IrError) {
          throw new BadRequestError("The document could not be parsed as an OpenAPI 3.x spec.", [
            { path: "document", message: error.message },
          ]);
        }
        throw error;
      }
      const response: PreviewParseResponse = { ir, resourceGroups: toResourceGroupSummaries(ir) };
      return previewParseResponseSchema.parse(response);
    },
  );
}
