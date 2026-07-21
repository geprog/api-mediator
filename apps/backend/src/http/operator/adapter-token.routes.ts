import {
  cutoverAdapterTokenResponseSchema,
  issueAdapterTokenResponseSchema,
  type CutoverAdapterTokenResponse,
  type IssueAdapterTokenResponse,
} from "@mediator/contracts";
import type { IssueTokenResult } from "@mediator/credentials";
import type { FastifyInstance } from "fastify";

import { BadRequestError, ConflictError, NotFoundError } from "../../app-errors.js";
import type { AdapterTokenIssuer } from "../../modules/adapter-token/index.js";
import { getPrincipal, requireOperator } from "../auth/index.js";
import { parseInput } from "../validation.js";
import { idParamSchema } from "./deps.js";

/**
 * Adapter-token operator routes (Phase-5 AT-1/AT-4) — the mediator's control plane
 * for a consumer app's inbound credential. All three are privileged mutations, so
 * each is `operator`-only (OA-2 — a `viewer` is rejected 403 by the guard before the
 * handler runs, and no token is generated):
 *
 * - `POST /api/apps/:id/adapter-token` — **issue**; the raw token is in the `201`
 *   body **exactly once** (AT-1.1). A re-issue follows the rotation path (AT-1.5).
 * - `POST /api/apps/:id/adapter-token/rotate` — **rotate**; a new token shown once,
 *   the previous one valid through the overlap window (AT-4.1).
 * - `POST /api/apps/:id/adapter-token/cutover` — **cutover**; end the overlap early
 *   (AT-4.2). Metadata only — no token in the response.
 *
 * The raw token appears in no other response, no log, and no audit row; only its
 * salted hash is stored (AT-1.2). An app with no `CONSUMER` spec is a `400`
 * (AT-1.4); a disabled app is a `409`; an unknown app is a `404`.
 */
export function registerAdapterTokenRoutes(
  app: FastifyInstance,
  service: AdapterTokenIssuer,
): void {
  app.post(
    "/api/apps/:id/adapter-token",
    { preHandler: requireOperator },
    async (request, reply): Promise<IssueAdapterTokenResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      const result = await service.issue(id, actor);
      const response = issuedResponse(result, id);
      void reply.code(201);
      return issueAdapterTokenResponseSchema.parse(response);
    },
  );

  app.post(
    "/api/apps/:id/adapter-token/rotate",
    { preHandler: requireOperator },
    async (request): Promise<IssueAdapterTokenResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      const result = await service.rotate(id, actor);
      return issueAdapterTokenResponseSchema.parse(issuedResponse(result, id));
    },
  );

  app.post(
    "/api/apps/:id/adapter-token/cutover",
    { preHandler: requireOperator },
    async (request): Promise<CutoverAdapterTokenResponse> => {
      const { id } = parseInput(idParamSchema, request.params, "path parameters");
      const actor = getPrincipal(request).identity;
      const result = await service.cutover(id, actor);
      switch (result.outcome) {
        case "cutover":
          return cutoverAdapterTokenResponseSchema.parse({
            endedCredentialIds: [...result.endedCredentialIds],
          });
        case "nothing-to-cutover":
          // Idempotent no-op: no overlap in progress, nothing to end.
          return cutoverAdapterTokenResponseSchema.parse({ endedCredentialIds: [] });
        case "app-not-found":
          throw notFound(id);
        case "app-not-consumer":
          throw notConsumer(id);
        case "app-not-active":
          throw notActive(id);
      }
    },
  );
}

/** Map a successful issue/rotate to its wire response, or throw the mapped error. */
function issuedResponse(result: IssueTokenResult, id: string): IssueAdapterTokenResponse {
  switch (result.outcome) {
    case "issued":
      return {
        credentialId: result.token.credentialId,
        // Shown exactly once — never returned again by any endpoint (AT-1.1/AT-1.2).
        token: result.token.rawToken,
        rotated: result.rotated,
        issuedAt: result.token.issuedAt.toISOString(),
      };
    case "app-not-found":
      throw notFound(id);
    case "app-not-consumer":
      throw notConsumer(id);
    case "app-not-active":
      throw notActive(id);
  }
}

function notFound(id: string): NotFoundError {
  return new NotFoundError(`RegisteredApp ${id} not found.`);
}
function notConsumer(id: string): BadRequestError {
  return new BadRequestError(
    `RegisteredApp ${id} has no CONSUMER spec; an adapter token authenticates calls to a generated adapter surface.`,
  );
}
function notActive(id: string): ConflictError {
  return new ConflictError(`RegisteredApp ${id} is disabled.`);
}
