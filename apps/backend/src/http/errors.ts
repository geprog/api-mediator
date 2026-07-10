import type { ErrorResponse } from "@mediator/contracts";
import type { FastifyError, FastifyInstance } from "fastify";

import { HttpError } from "../app-errors.js";

/** A short reason phrase for a 4xx status code (never derived from user input). */
function clientErrorReason(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 413:
      return "Payload Too Large";
    case 415:
      return "Unsupported Media Type";
    default:
      return "Client Error";
  }
}

/**
 * Install the operator API's error + not-found handlers, so every non-2xx
 * response uses the uniform {@link ErrorResponse} envelope.
 *
 * - {@link HttpError}s (400/404) map to their own envelope + `issues`.
 * - Other Fastify 4xx (e.g. a malformed JSON body) return a **generic** message
 *   with the status-appropriate reason phrase, never echoing Fastify's raw
 *   message — a submitted body could quote credential material.
 * - Unmatched routes return an `ErrorResponse`-shaped 404 (not Fastify's default).
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
        error: clientErrorReason(statusCode),
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

  app.setNotFoundHandler((_request, reply) => {
    const response: ErrorResponse = {
      statusCode: 404,
      error: "Not Found",
      message: "Route not found.",
    };
    void reply.code(404).send(response);
  });
}
