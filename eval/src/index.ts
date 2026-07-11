/**
 * `@mediator/eval` — the Phase-2 detection-accuracy harness (EH-1..3). It runs the
 * real-provider detection engine directly over a scenario's vendored specs and
 * emits a **scored report** measuring the produced `MappingProposal`s against the
 * `scenarios/<name>/ground-truth.yaml` fixtures — resource-pair recall/precision (both
 * stages), operation CRUD classification, identity-candidate hit rate, transform
 * agreement, field precision/recall, consumer-provider phase/parameter correctness,
 * and negatives-avoidance — plus the two-stage design's health signal (shortlist
 * recall, the offline proxy for escape-hatch usage).
 *
 * The report is a scored artifact for humans, **never a red/green accuracy gate**:
 * a well-formed, non-empty run is the only gate-able outcome. The SCORING is a pure,
 * deterministic function (unit-tested in `pnpm verify` with a `FakeProvider`); the
 * live run over a scenario is a CLI (`pnpm --filter @mediator/eval run eval`),
 * deliberately outside `pnpm verify`.
 */

export {
  type CrudAction,
  type GroundTruth,
  GroundTruthParseError,
  type GtConsumerOperation,
  type GtConsumerProviderPair,
  type GtEndpoint,
  type GtFieldPair,
  type GtNegative,
  type GtOperationRef,
  type GtPair,
  type GtParameterPair,
  type GtPeerPair,
  type NegativeVerdict,
  parseGroundTruth,
  parseOperationRef,
} from "./ground-truth.js";

export {
  type LoadedScenario,
  type LoadedSpec,
  loadScenario,
  resolveScenarioDir,
  scenariosRoot,
} from "./scenario-loader.js";

export {
  fieldRoot,
  findSpec,
  operationRefKey,
  parameterName,
  resolveResourceRef,
} from "./align.js";

export {
  itemSourceField,
  itemTargetField,
  mappedItemsForPair,
  type ProposalWithItems,
  ScoringContext,
  type ScoringInput,
} from "./context.js";

export { type HarnessConfig, DEFAULT_HARNESS_CONFIG } from "./config.js";

export { scoreScenario } from "./scoring.js";
export { scoreStage1 } from "./score-stage1.js";
export { scoreStage2, transformAgrees, TRANSFORM_MODELING_NOTE } from "./score-stage2.js";

export {
  type ConsumerOpResult,
  type CrudResult,
  type FieldFinding,
  formatSummary,
  type HealthSignal,
  type IdentityResult,
  type NegativeResult,
  ratioMetric,
  type RatioMetric,
  type ScenarioReport,
  type Stage1PairResult,
  type Stage1Report,
  type Stage2ConsumerPairResult,
  type Stage2PairResult,
  type Stage2PeerPairResult,
  type Stage2Report,
  type TransformResult,
} from "./report.js";

export { type RunScenarioDeps, runScenario } from "./runner.js";
export { buildFakeProvider } from "./fake-script.js";
