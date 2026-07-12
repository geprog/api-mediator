/**
 * `@mediator/transform` — the Transformation Executor (Phase 4, TX-1..TX-5).
 *
 * Pure, deterministic, side-effect-free application of an `ApprovedMapping`'s
 * `FieldMapping`s to convert one app's payload shape into another's, plus the
 * sandbox that makes an LLM-suggested `expression` transform safe. It depends only
 * on `@mediator/domain` (the `FieldMapping`/`TransformKind`/`transformConfig` shapes)
 * and `jsep` (the expression parser). **No credential access, no network, no
 * persistence, and no payload value is ever sent to an LLM** — those are the
 * Outbound Call Executor / detection stages (`docs/architecture/security.md`
 * *LLM data boundary*). Shared unchanged by the Sync Engine and the Adapter Engine.
 */

// The transform-error signal (the concept's `mediator-transform-error`).
export { TransformError, isTransformError } from "./errors.js";
export type { TransformErrorKind } from "./errors.js";

// The JSON value model the executor operates over, and the path helpers.
export { readPath, setPath, pathSegments } from "./json.js";
export type { JsonValue, JsonPrimitive, JsonRecord, PathRead } from "./json.js";

// The executor: apply field mappings, and account for the fields they touch.
export { applyFieldMapping, applyFieldMappings, collectTouchedFields } from "./executor.js";
export type {
  AppliedMapping,
  TransformTrace,
  FieldParticipation,
  FieldTransformResult,
  ApplyOptions,
} from "./executor.js";

// The `expression` sandbox — reused directly by the Adapter Engine in Phase 5
// (`ParameterMapping` / `AdapterBinding.chainInputs`, same vocabulary + sandbox).
export {
  compileExpression,
  evaluateSafeExpr,
  resolveSandboxLimits,
  DEFAULT_SANDBOX_LIMITS,
  ALLOWED_UNARY_OPS,
  ALLOWED_BINARY_OPS,
  ALLOWED_LOGICAL_OPS,
} from "./expression.js";
export type { SafeExpr, SandboxLimits } from "./expression.js";
export { EXPRESSION_HELPER_NAMES } from "./expression-helpers.js";
