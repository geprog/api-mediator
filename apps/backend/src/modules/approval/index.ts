/**
 * The Approval Service slice (AS-1..AS-6): the logic-and-persistence core that
 * turns a reviewed `MappingProposal` into an `ApprovedMapping` and emits
 * `MappingApproved`. The HTTP surface (RA slice) and the event consumer (AI slice)
 * are separate; this module exports the service, its persistence seam, and the
 * pure helpers a route/test wires or exercises.
 */

export {
  ApprovalService,
  applyDecision,
  deriveVariant,
  validateTargetRefs,
  type ApprovalServiceDeps,
  type ApproveInput,
  type ApproveResult,
  type DecideItemInput,
  type ItemEdit,
  type ItemReviewDecision,
} from "./approval-service.js";
export {
  DbApprovalUnitOfWork,
  type ApprovalTxStores,
  type ApprovalUnitOfWork,
  type ApprovedMappingTxRepo,
  type AuditTxRepo,
  type MappingArtifactsTxRepo,
  type ProposalTxRepo,
  type SpecTxReader,
} from "./persistence.js";
export {
  assembleChildren,
  assertIdentityInvariants,
  resolveIdentityKeys,
  resourcePairKey,
  type AssembleInput,
  type IdentityKeyConfirmation,
  type OperationOverride,
  type ResolvedIdentity,
} from "./assemble.js";
export { serializeRef, serializeTargetIdParamRef } from "./refs.js";
export {
  deriveAction,
  deriveTargetIdParamName,
  findResourceGroup,
  operationHasParameter,
  refResolves,
  resolveOperation,
} from "./target-ir.js";
