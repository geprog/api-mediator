import { ADAPTER_ORIGIN } from "../env.js";

/** The machine-readable cause header the Adapter Server Runtime sets (RT-3.5). */
export const CAUSE_HEADER = "x-mediator-cause";
/** Out-of-band header naming the contributing backends of an aggregated response. */
export const CONTRIBUTING_BACKENDS_HEADER = "x-mediator-contributing-backends";
/** Header flagging a degraded (dropped-supplement/contributor) response. */
export const DEGRADED_HEADER = "x-mediator-degraded";
/** Header naming the failed/dropped backend(s) of a degraded response. */
export const DEGRADED_BACKENDS_HEADER = "x-mediator-degraded-backends";

/** A raw adapter-surface response the CU-5 journeys assert on. */
export interface AdapterResponse {
  readonly status: number;
  readonly cause: string | null;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

/** Options for {@link callAdapter}: the token (omit for the no-token case), body, and query. */
export interface AdapterCallOptions {
  readonly token?: string;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}

/**
 * Call the mediator's generated adapter surface (one listener; the token selects the
 * consumer app). A thin `fetch` wrapper returning the status, the machine-readable
 * cause token, the headers, and the (best-effort) parsed body — the shape the CU-5
 * assertions read. This is the **real** inbound path a consumer app uses: an
 * `Authorization: Bearer <adapter token>` request over HTTP.
 */
export async function callAdapter(
  method: string,
  path: string,
  options: AdapterCallOptions = {},
): Promise<AdapterResponse> {
  const url = new URL(`${ADAPTER_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const hasBody = options.body !== undefined;
  const response = await fetch(url, {
    method,
    headers: {
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    cause: response.headers.get(CAUSE_HEADER),
    headers: response.headers,
    text,
    json,
  };
}
