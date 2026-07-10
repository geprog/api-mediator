import { errorResponseSchema } from "@mediator/contracts";
import type { ZodType } from "zod";

import { ApiError } from "./errors.js";

/**
 * Thin, typed fetch wrapper for the operator API.
 *
 * Responsibilities kept in **one** place so every route function stays a
 * one-liner:
 *
 * - build the request (JSON body + `accept`/`content-type` headers);
 * - fold a transport failure (backend unreachable) into an {@link ApiError} with
 *   a synthetic status so the UI never sees a raw `TypeError`;
 * - on a non-2xx, parse the body as the uniform {@link errorResponseSchema} and
 *   throw the resulting {@link ApiError} (falling back to a generic envelope when
 *   the error body itself is malformed);
 * - on success, **validate the response against its `@mediator/contracts` schema**
 *   (the boundary is the single place untyped JSON becomes a typed DTO) and throw
 *   an {@link ApiError} if the server's shape does not match.
 *
 * The base path is same-origin (`/api/...`), which the Vite dev server proxies to
 * the backend — so no CORS and no configured base URL.
 */

interface RequestOptions {
  readonly method: "GET" | "POST" | "PATCH";
  /** JSON request body; omit for GET. Serialized with `JSON.stringify`. */
  readonly body?: unknown;
}

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
}

async function sendRequest(path: string, options: RequestOptions): Promise<RawResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const init: RequestInit = {
    method: options.method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  };

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiError({
      statusCode: 0,
      error: "Network Error",
      message: error instanceof Error ? error.message : "The request could not be sent.",
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * Perform an operator-API request and return its response parsed by `schema`.
 * Throws {@link ApiError} on any transport, HTTP-error, or shape mismatch.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions,
  schema: ZodType<T>,
): Promise<T> {
  const { status, body } = await sendRequest(path, options);

  if (status < 200 || status >= 300) {
    const parsedError = errorResponseSchema.safeParse(body);
    if (parsedError.success) {
      throw new ApiError(parsedError.data);
    }
    throw new ApiError({
      statusCode: status,
      error: "Request Failed",
      message: `The server responded with HTTP ${String(status)}.`,
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError({
      statusCode: status,
      error: "Malformed Response",
      message: "The server returned a response that did not match the expected shape.",
    });
  }
  return parsed.data;
}
