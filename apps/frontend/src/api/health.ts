/**
 * Typed client for the operator API's `GET /health` endpoint.
 *
 * The backend answers 200 `{ status: "ok", db: "up" }` when the database
 * responds and 503 `{ status: "error", db: "down" }` when the DB ping fails —
 * both are *valid* health answers and are modelled as the `"ok"` result kind
 * (we reached the backend and it told us its state). The `"error"` kind is
 * reserved for transport/parse failures (backend unreachable, non-JSON body):
 * a discriminated union so callers branch exhaustively instead of juggling
 * optional fields.
 *
 * In dev the browser calls the same-origin `/health` path, which the Vite dev
 * server proxies to the backend (see `vite.config.ts`) — no CORS. A shared
 * `@mediator/contracts` package will own this shape from Phase 1; for now it is
 * a local type.
 */

/** Whether the backend's database ping succeeded. */
export type DatabaseStatus = "up" | "down";

/** Body of a successful `GET /health` response (200 or 503). */
export interface HealthResponse {
  readonly status: "ok" | "error";
  readonly db: DatabaseStatus;
}

/**
 * Outcome of a health probe: either the backend answered with a well-formed
 * body, or the request could not be completed / parsed.
 */
export type HealthResult =
  | { readonly kind: "ok"; readonly response: HealthResponse }
  | { readonly kind: "error"; readonly message: string };

function parseHealthResponse(body: unknown): HealthResponse | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record: Record<string, unknown> = body as Record<string, unknown>;
  const status = record["status"];
  const db = record["db"];
  if ((status !== "ok" && status !== "error") || (db !== "up" && db !== "down")) {
    return null;
  }
  return { status, db };
}

/**
 * Probe `GET /health`. Never throws: transport and parse failures are folded
 * into the `"error"` result kind so the caller always gets a value to render.
 */
export async function fetchHealth(): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetch("/health", { headers: { accept: "application/json" } });
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "Network request failed",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "error", message: `Unexpected response (HTTP ${String(response.status)})` };
  }

  const parsed = parseHealthResponse(body);
  if (parsed === null) {
    return { kind: "error", message: `Malformed health payload (HTTP ${String(response.status)})` };
  }
  return { kind: "ok", response: parsed };
}
