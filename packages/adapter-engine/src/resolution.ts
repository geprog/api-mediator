import type { AdapterBinding, AdapterEndpoint } from "@mediator/domain";

/**
 * The persisted serving state of one mounted consumer operation, as the store
 * loads it for resolution: the `AdapterEndpoint` row (if one exists) and **all**
 * of its `AdapterBinding`s in any status. The definition of "a served binding" —
 * `status = active` — is owned here, in {@link resolveRequest}, not by the store,
 * so it stays the single source of truth.
 */
export interface EndpointState {
  /** The endpoint for this `(consumerAppId, operationKey)`, or `undefined` if none. */
  readonly endpoint: AdapterEndpoint | undefined;
  /** Every binding of that endpoint, in any status (`active`/`proposed`/`disabled`). */
  readonly bindings: readonly AdapterBinding[];
}

/**
 * The three distinct answers a *mounted* consumer operation can resolve to (RT-3).
 * A fourth answer — a plain **404** — is deliberately **not** here: "the path is in
 * no mounted spec" is a routing miss the (REST) Request Router decides *before* it
 * ever asks the core to resolve, so a 404 is never confused with `not-yet-mapped`
 * (RT-2.2 / RT-3.5). A discriminated union so every consumer must branch on `kind`.
 *
 * The four backend-execution causes (`mapping-stale`, `mapping-suspended`,
 * `backend-disabled`, `mediator-transform-error`) are **not** produced here — they
 * arise only once a `serve` outcome reaches the Resolution Planner / executor (RP,
 * TE, AG). This union stays open to them by handing `serve` off across the seam.
 */
export type ResolutionOutcome =
  | {
      /**
       * `not-yet-mapped` (RT-3.1/3.4): the operation is mounted but has no served
       * configuration — no `AdapterEndpoint`, or an endpoint with no `active`
       * binding (including a `composition-required` endpoint that was **never**
       * active). Never a 404, never an empty success body, never an empty
       * collection. `endpointId` is present when an endpoint row exists but has
       * nothing active to serve, absent when no endpoint exists at all.
       */
      readonly kind: "not-yet-mapped";
      readonly endpointId: string | undefined;
    }
  | {
      /**
       * `endpoint-disabled` (RT-3.2): the `AdapterEndpoint.status = disabled` —
       * configured but deliberately switched off, distinguishable from
       * `not-yet-mapped` and from every backend failure.
       */
      readonly kind: "endpoint-disabled";
      readonly endpointId: string;
    }
  | {
      /**
       * `serve` (RT-3.3): the endpoint has an `active` serving configuration
       * (`active`, or `composition-required` that still keeps its previously-composed
       * active binding), so the request is handed across the Protocol Server seam to
       * the serving core (RP/TE/AG). In *this* slice no serving core is wired, so the
       * runtime renders a distinct placeholder — never `not-yet-mapped`.
       */
      readonly kind: "serve";
      readonly endpoint: AdapterEndpoint;
      readonly activeBindings: readonly AdapterBinding[];
    };

/**
 * Decide the RT-3 answer for a mounted consumer operation from its persisted
 * {@link EndpointState}. Pure and protocol-neutral: it inspects only endpoint
 * status and binding statuses, and returns one of the three distinct outcomes.
 *
 * The rule that unifies RT-3.1/3.3/3.4 is: **serve iff the endpoint exists, is not
 * disabled, and has at least one `active` binding.** A `composition-required`
 * endpoint therefore keeps serving *because* it still carries an active binding
 * (its previously-composed configuration), and answers `not-yet-mapped` only when
 * every binding is non-active — an endpoint row existing is not, by itself, a
 * served endpoint (`docs/architecture/adapter-engine.md` *Binding: decided at
 * composition time*).
 */
export function resolveRequest(state: EndpointState): ResolutionOutcome {
  const { endpoint, bindings } = state;
  if (endpoint === undefined) {
    return { kind: "not-yet-mapped", endpointId: undefined };
  }
  if (endpoint.status === "disabled") {
    return { kind: "endpoint-disabled", endpointId: endpoint.id };
  }
  const activeBindings = bindings.filter((binding) => binding.status === "active");
  if (activeBindings.length === 0) {
    return { kind: "not-yet-mapped", endpointId: endpoint.id };
  }
  return { kind: "serve", endpoint, activeBindings };
}
