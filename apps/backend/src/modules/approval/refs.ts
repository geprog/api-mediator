import type { ProposalElementRef } from "@mediator/domain";

/**
 * Serialize a `MappingProposalItem` ref (`{ resourceRef, target }`) into the
 * **resource-qualified IR path string** the approved-mapping entities store on
 * their `*Path`/`*Ref` fields.
 *
 * The string format is the one the `@mediator/domain` `FieldMapping` /
 * `OperationMapping` / `ParameterMapping` shapes document by example
 * (`docs/architecture/data-model.md`; the AM domain spec fixtures):
 *
 * - field     → `resourceRef/path`                (e.g. `issues/title`)
 * - operation → `resourceRef/operationId`         (e.g. `issues/updateIssue`)
 * - parameter → `resourceRef/operationId#parameter` (e.g. `search/searchIssues#owner`)
 *
 * A parameter's leading `resourceRef/operationId` is deliberately identical to the
 * serialization of that operation's ref, so a `ParameterMapping.targetParamRef`
 * and its owning operation's `targetOperationRef` share a stable prefix.
 */
export function serializeRef(ref: ProposalElementRef): string {
  switch (ref.target.kind) {
    case "field":
      return `${ref.resourceRef}/${ref.target.path}`;
    case "operation":
      return `${ref.resourceRef}/${ref.target.operationId}`;
    case "parameter":
      return `${ref.resourceRef}/${ref.target.operationId}#${ref.target.parameter}`;
  }
}

/**
 * Serialize a peer-peer `OperationMapping.targetIdParamRef` — a parameter ref on
 * the target operation, in the same `resourceRef/operationId#parameter` form as a
 * {@link serializeRef} parameter. Used when deriving (or a reviewer corrects) the
 * target-id parameter of an `update`/`delete` operation (AS-4).
 */
export function serializeTargetIdParamRef(
  targetResourceRef: string,
  targetOperationId: string,
  parameterName: string,
): string {
  return `${targetResourceRef}/${targetOperationId}#${parameterName}`;
}
