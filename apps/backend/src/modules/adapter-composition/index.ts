/**
 * **Phase-5 CO-2 — the composition decision and its validation.** Resolving a
 * `composition-required` `AdapterEndpoint`: the composer chooses how its approved
 * backends combine, the mediator refuses any configuration whose serving semantics are
 * undefined (naming what is wrong), and — only on a passing result, in one transaction —
 * activates it (`docs/flows/adapter-endpoint-composition.md` steps 4-6).
 */
export {
  DbCompositionContextLoader,
  type CompositionContext,
  type CompositionContextLoader,
} from "./context.js";
export {
  AdapterCompositionService,
  type AdapterCompositionServiceDeps,
  type ComposeResult,
} from "./service.js";
export {
  ROLE_VALIDITY_BY_STRATEGY,
  formatCompositionRejection,
  validateComposition,
  type ComposableBindingFacts,
  type CompositionRejectionReason,
  type CompositionSubmission,
  type CompositionValidation,
  type SubmittedBindingComposition,
} from "./validate.js";
