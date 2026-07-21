import type { AdapterBinding, AdapterEndpoint, AdapterRequestCause } from "@mediator/domain";

import type { AdapterRequest } from "./request.js";

/**
 * The input a {@link ServeHandler} receives once a request has resolved to
 * `serve` (RT-3.3): the protocol-neutral request plus the endpoint's active
 * serving configuration. This is the whole payload the planner → executor →
 * aggregator pipeline (RP/TE/AG) needs; it is deliberately free of HTTP so the
 * serving core stays behind the Protocol Server seam.
 */
export interface ServeInput {
  readonly request: AdapterRequest;
  readonly endpoint: AdapterEndpoint;
  readonly activeBindings: readonly AdapterBinding[];
}

/**
 * The protocol-neutral result of serving a resolved request. A discriminated
 * union so a served response and a failure can never be confused:
 *
 * - `served` — a complete consumer-shape response `body`. `degraded` marks a
 *   result that omitted a failed `supplement`'s optional fields (AD-5.3); the
 *   contributing backends are named for the out-of-band provenance header the
 *   concept requires (never injected into the body).
 * - `failed` — one of the backend-execution causes (`mapping-stale`,
 *   `mapping-suspended`, `backend-disabled`, `mediator-transform-error`, or a
 *   generic `upstream-error`). These are RP/TE/AG's to produce, not RT's; the
 *   union names them so the seam is closed over the full cause taxonomy.
 *
 * Note the absence of any HTTP status code — status codes are a REST specific
 * mapped on the runtime's side of the seam (README open question 2).
 */
export type ServeOutcome =
  | {
      readonly kind: "served";
      readonly body: unknown;
      readonly degraded: boolean;
      readonly contributingBackendAppIds: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly cause: AdapterRequestCause;
    };

/**
 * **The serving seam RP/TE/AG build behind.** The REST runtime, having resolved a
 * request to `serve`, hands it to a `ServeHandler` and renders the neutral
 * {@link ServeOutcome} back to HTTP. This RT slice wires **no** handler — the
 * planner/executor/aggregator do not exist yet — so a `serve` resolution renders a
 * distinct "serving not implemented" placeholder instead (never `not-yet-mapped`).
 * A later slice provides the concrete `ServeHandler` and the runtime delegates to
 * it; nothing else about the runtime changes. That substitutability is the point
 * of the seam.
 */
export interface ServeHandler {
  serve(input: ServeInput): Promise<ServeOutcome>;
}
