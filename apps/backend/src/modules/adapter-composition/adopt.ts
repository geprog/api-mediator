import type { AdapterEndpointStatus } from "@mediator/domain";

import type { CompositionContext } from "./context.js";
import type {
  CompositionSubmission,
  CompositionValidation,
  SubmittedBindingComposition,
} from "./validate.js";

/**
 * **CO-7 successor adoption — the pure decisions.** Adoption re-points a stale mapping's
 * `AdapterBinding`s to its successor and then re-validates each affected endpoint's
 * composition *against the successor's content* — reusing the CO-2/CO-3 validator, not a
 * parallel one. These two helpers are the only adoption-specific logic that is a pure
 * function of loaded state, so they live here (no I/O) and are unit-testable directly; the
 * service ({@link import("./service.js").AdapterCompositionService.adoptSuccessor}) wires
 * the re-point / load / flag / cache-drop transaction around them.
 */

/**
 * Rebuild the composition submission for an endpoint from its **current persisted
 * configuration** — the endpoint's serving fields plus every binding's composed
 * role/order/chaining state — so it can be fed back through {@link
 * import("./validate.js").validateComposition}. Adoption re-points bindings in place, so
 * this reconstructs "what is currently composed" and re-validates it against the freshly
 * re-derived (successor) binding facts; it is **not** a fresh composition decision.
 *
 * The `chainInputs`, `dependsOnBindingId`, and `executionOrder` are carried over exactly
 * because they live on the binding row (AD-2.4) precisely so they survive a mapping
 * supersession (CO-7.1). A binding whose status is not `active` — a `proposed` pending
 * attach or an operator-`disabled` one — is reconstructed as `disabled` (addressed but not
 * part of the served set, CO-6.2), so re-validation reasons only over what actually serves.
 * The union post-merge config and acknowledgements are carried over unchanged; the
 * pagination convention's server-stamped confirmation is projected back to the submission's
 * `confirmPostMergePagination` flag.
 */
export function reconstructSubmissionFromContext(
  context: CompositionContext,
): CompositionSubmission {
  const endpoint = context.endpoint;
  const bindings: SubmittedBindingComposition[] = context.bindings.map((binding) => ({
    bindingId: binding.id,
    role: binding.role,
    ...(binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {}),
    ...(binding.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: binding.dependsOnBindingId }
      : {}),
    ...(binding.chainInputs !== undefined ? { chainInputs: binding.chainInputs } : {}),
    // CO-6.2 — only an `active` binding is part of the served set; a `proposed`/`disabled`
    // one is addressed-but-not-served, so re-validation evaluates the serving semantics
    // over the active set alone.
    disabled: binding.status !== "active",
  }));

  return {
    // A composed (or CO-1 auto-activated) endpoint always carries these; the defaults match
    // CO-1's single/degraded auto-activation for the degenerate uncomposed-but-bound case.
    aggregationStrategy: endpoint.aggregationStrategy ?? "single",
    strictness: endpoint.strictness ?? "degraded",
    bindings,
    ...(endpoint.cacheTtl !== undefined ? { cacheTtl: endpoint.cacheTtl } : {}),
    ...(endpoint.acknowledgedIgnoredInputs !== undefined
      ? { acknowledgedIgnoredInputs: endpoint.acknowledgedIgnoredInputs }
      : {}),
    ...(endpoint.postMergeDedup !== undefined ? { postMergeDedup: endpoint.postMergeDedup } : {}),
    ...(endpoint.postMergeFilters !== undefined
      ? { postMergeFilters: endpoint.postMergeFilters }
      : {}),
    ...(endpoint.postMergeSorts !== undefined ? { postMergeSorts: endpoint.postMergeSorts } : {}),
    ...(endpoint.postMergePagination !== undefined
      ? {
          postMergePagination: endpoint.postMergePagination.convention,
          confirmPostMergePagination: endpoint.postMergePagination.confirmedBy !== null,
        }
      : {}),
  };
}

/**
 * **CO-7.4 — must this endpoint be flagged `composition-required` after adoption?** True
 * exactly when re-validation against the successor **failed** and the endpoint is currently
 * `active`: adoption never leaves a broken configuration serving `active`, but it also never
 * *promotes* — a re-validation pass on an already-`composition-required` endpoint (a pending
 * second-binding attach) does not resolve that human decision, and a `disabled` endpoint
 * stays disabled. So the only status transition adoption performs is `active → composition-
 * required` on a failed re-validation; every other case leaves the endpoint's status
 * untouched, keeping its previous configuration serving where still valid (CO-1.3).
 */
export function adoptionFlagsCompositionRequired(
  endpointStatus: AdapterEndpointStatus,
  validation: CompositionValidation,
): boolean {
  return !validation.ok && endpointStatus === "active";
}
