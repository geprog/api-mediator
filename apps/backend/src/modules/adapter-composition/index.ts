/**
 * **Phase-5 CO-2 — the composition decision and its validation.** Resolving a
 * `composition-required` `AdapterEndpoint`: the composer chooses how its approved
 * backends combine, the mediator refuses any configuration whose serving semantics are
 * undefined (naming what is wrong), and — only on a passing result, in one transaction —
 * activates it (`docs/flows/adapter-endpoint-composition.md` steps 4-6).
 */
export { adoptionFlagsCompositionRequired, reconstructSubmissionFromContext } from "./adopt.js";
export {
  DbCompositionContextLoader,
  type CompositionContext,
  type CompositionContextLoader,
} from "./context.js";
export {
  AdapterCompositionService,
  type AdapterCompositionServiceDeps,
  type AdoptSuccessorInput,
  type AdoptSuccessorResult,
  type ComposeResult,
  type CompositionPreview,
  type EndpointCacheInvalidator,
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
export {
  analyzeSupplementLoadBearing,
  deriveConsumerInputCoverage,
  topLevelConsumerFieldName,
  type BindingInputCoverage,
  type ConsumerInputCoverage,
  type ConsumerInputUniverse,
  type SupplementAnalysisEntry,
  type SupplementLoadBearingAnalysis,
  type UnmappedConsumerInput,
} from "./analysis.js";
export {
  classifyUnionParameter,
  deriveUnionCompositionAnalysis,
  formatUnionRejection,
  paginationConventionParamRefs,
  pushdownEligibleParamNames,
  validateUnionConfiguration,
  type UnionBindingFacts,
  type UnionCompositionAnalysis,
  type UnionParameterKind,
  type UnionRejectionReason,
  type UnionSubmission,
} from "./union.js";
