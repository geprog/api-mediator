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
 * Why the serving core rejected a request against the **consumer's own contract**
 * before any backend was involved (RP-2). Kept protocol-neutral — the token is the
 * machine-readable contract, the REST runtime maps it to a client-error status:
 *
 * - `invalid-request` — the request violates the consumer operation's own request
 *   schema/parameters (a missing required parameter, a body that fails the schema).
 *   The fix is the caller's.
 * - `unmapped-consumer-input` — the request *supplies* a declared consumer input
 *   the composition neither mapped to a backend nor acknowledged, so honoring it is
 *   impossible; answering anyway would compute a result from an input silently
 *   dropped. The fix is finishing composition (README open question 7). These are
 *   two different fixes, so they are two distinct reasons (RP-2.6).
 * - `union-parameter-unconfigured` — a `collection-union` request uses a **filter**
 *   parameter that is neither pushed down (mapped in every contributing binding) nor
 *   covered by a `postMergeFilters` entry, or a **sort** / **pagination** parameter
 *   with no confirmed `postMergeSorts` / `postMergePagination` semantics (sort and
 *   pagination are never pushed down). Answering anyway would return a silently
 *   unfiltered, unsorted, or mispaged union, so the request is rejected before any
 *   backend is called (RP-2.2/2.3 — the CO-3↔RP-2 contract). A composition fix, but a
 *   distinct one from `unmapped-consumer-input`: the parameter *is* known/mapped, it
 *   simply has no union serving semantics. Never produced for a non-union endpoint.
 */
export type ServeRejectionReason =
  "invalid-request" | "unmapped-consumer-input" | "union-parameter-unconfigured";

/**
 * The protocol-neutral result of serving a resolved request. A discriminated
 * union so a served response, a client-contract rejection, and a serving failure
 * can never be confused:
 *
 * - `served` — a complete consumer-shape response `body`. `degraded` marks a
 *   result that omitted a failed `supplement`'s optional fields (AD-5.3); the
 *   contributing backends are named for the out-of-band provenance header the
 *   concept requires (never injected into the body), and `degradedBackendAppIds`
 *   names the **failed** backend(s) whose optional fields were dropped — the
 *   out-of-band signal AG-2.3 requires, likewise never in the body. Absent on a
 *   complete (non-degraded) response.
 * - `rejected` — the inbound request failed validation against the consumer's own
 *   contract (RP-2), a **client error** deliberately distinct from every serving
 *   cause: no backend ran and the request was never passed through. `detail` is a
 *   non-secret, payload-free note (parameter/field names only), never a value.
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
      /**
       * The failed backend app(s) whose optional fields a `fanout-merge` degraded
       * response omitted (AG-2.3). Absent on a complete response; present and
       * non-empty exactly when `degraded` is `true`, so the runtime can name the
       * failed backend out of band without ever touching the body.
       */
      readonly degradedBackendAppIds?: readonly string[];
    }
  | {
      readonly kind: "rejected";
      readonly reason: ServeRejectionReason;
      readonly detail: string;
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
