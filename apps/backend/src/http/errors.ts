import type { ErrorResponse } from "@mediator/contracts";
import type { FastifyError, FastifyInstance } from "fastify";

import { HttpError } from "../app-errors.js";

/**
 * Install the operator API's error handler, mapping the {@link HttpError}
 * taxonomy to the uniform {@link ErrorResponse} envelope.
 *
 * - {@link HttpError}s (400/404) map to their own envelope + `issues`.
 * - Other Fastify 4xx (e.g. a malformed JSON body) return a **generic** 4xx
 *   message, never echoing Fastify's raw message — a submitted body could quote
 *   credential material.
 * - Everything else is a logged, generic 500 (no internals leaked).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send(error.toResponse());
      return;
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const response: ErrorResponse = {
        statusCode,
        error: "Bad Request",
        message: "The request could not be processed.",
      };
      void reply.code(statusCode).send(response);
      return;
    }

    request.log.error({ err: error }, "unhandled operator API error");
    const response: ErrorResponse = {
      statusCode: 500,
      error: "Internal Server Error",
      message: "An unexpected error occurred.",
    };
    void reply.code(500).send(response);
  });
}
