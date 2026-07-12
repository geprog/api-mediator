import type {
  Ir,
  IrOperation,
  IrResourceGroup,
  OperationAction,
  ProposalElementRef,
} from "@mediator/domain";

/**
 * Resolution of `MappingProposalItem` refs against a **target spec's IR**, plus
 * the mechanical `action` / `targetIdParamRef` derivations the approve action
 * needs (AS-3, AS-4). Pure functions over the IR — no persistence, no I/O.
 *
 * The Approval Service validates every accepted/edited item's effective
 * `targetRef` here **before** assembling an `ApprovedMapping` (AS-3): an
 * unresolvable ref rejects the whole approve atomically, so a mapping can never be
 * approved pointing at a target element that does not exist.
 */

/** The target resource group named by a ref's `resourceRef`, if the IR has it. */
export function findResourceGroup(ir: Ir, resourceRef: string): IrResourceGroup | undefined {
  return ir.find((group) => group.resourceRef === resourceRef);
}

/**
 * The operation of `resourceRef` with `operationId`, if the group has it.
 * `operationId` is not globally unique, so it is resolved **within** its resource
 * group (the ref is resource-qualified). When a group has more than one operation
 * with the same id (the specs tolerate duplicates — SI-1 crit 8), the first is
 * returned; action derivation over any of them is identical for the common case,
 * and the reviewer can correct it.
 */
export function resolveOperation(
  ir: Ir,
  resourceRef: string,
  operationId: string,
): IrOperation | undefined {
  const group = findResourceGroup(ir, resourceRef);
  return group?.operations.find((operation) => operation.operationId === operationId);
}

/** The distinct field names of a resource group — its schemas plus its operations' bodies. */
function resourceFieldNames(group: IrResourceGroup): ReadonlySet<string> {
  const names = new Set<string>();
  for (const schema of group.schemas) {
    for (const field of schema.fields) {
      names.add(field.name);
    }
  }
  for (const operation of group.operations) {
    for (const field of operation.requestSchema?.fields ?? []) {
      names.add(field.name);
    }
    for (const field of operation.responseSchema?.fields ?? []) {
      names.add(field.name);
    }
  }
  return names;
}

/**
 * Whether a ref resolves to a real element of the target IR (AS-3):
 *
 * - `field`     — its `path` names a field of the target resource group (in any of
 *   the group's schemas or operation request/response bodies).
 * - `operation` — its `operationId` names an operation of the target resource group.
 * - `parameter` — its `parameter` names a parameter of the referenced operation.
 *
 * Returns `false` when the resource group, operation, field, or parameter is
 * absent — the signal the Approval Service turns into an atomic approve rejection.
 */
export function refResolves(ir: Ir, ref: ProposalElementRef): boolean {
  const group = findResourceGroup(ir, ref.resourceRef);
  if (group === undefined) {
    return false;
  }
  switch (ref.target.kind) {
    case "field":
      return resourceFieldNames(group).has(ref.target.path);
    case "operation": {
      const targetOperationId = ref.target.operationId;
      return group.operations.some((operation) => operation.operationId === targetOperationId);
    }
    case "parameter": {
      const operationId = ref.target.operationId;
      const parameterName = ref.target.parameter;
      return group.operations.some(
        (operation) =>
          operation.operationId === operationId &&
          operation.parameters.some((parameter) => parameter.name === parameterName),
      );
    }
  }
}

/**
 * Classify an operation `action` mechanically from its IR (AS-4 criterion 1),
 * over the concept's **four-value** vocabulary — never `list` (AS-4 criterion 6):
 * a collection read and a single-record read are both `read`, which is precisely
 * why the vocabulary omits `list`.
 *
 * The classification is by HTTP method; path shape does not further split the four
 * values (a collection `GET` and an item `GET` collapse to `read`). `POST` → create,
 * `PUT`/`PATCH` → update, `DELETE` → delete, everything else → read. It is a
 * heuristic the reviewer can override to any of the four values (AS-4 criterion 2).
 */
export function deriveAction(operation: IrOperation): OperationAction {
  switch (operation.method) {
    case "post":
      return "create";
    case "put":
    case "patch":
      return "update";
    case "delete":
      return "delete";
    case "get":
    case "head":
    case "options":
    case "trace":
      return "read";
  }
}

/**
 * Derive a peer-peer `update`/`delete` operation's target-id parameter (AS-4
 * criterion 3): the operation's single path parameter, unambiguous when it has
 * exactly one. Returns `undefined` when the operation has zero or more than one
 * path parameter — the reviewer must then supply the correct one (AS-4 leaves it
 * reviewer-correctable). The name (not the serialized ref) is returned;
 * {@link serializeTargetIdParamRef} composes the stored ref.
 */
export function deriveTargetIdParamName(operation: IrOperation): string | undefined {
  const pathParameters = operation.parameters.filter((parameter) => parameter.location === "path");
  const [only] = pathParameters;
  return pathParameters.length === 1 && only !== undefined ? only.name : undefined;
}

/**
 * Whether `parameterName` is a real parameter of the operation of `resourceRef`
 * with `operationId` — the defense-in-depth check a reviewer's `targetIdParamRef`
 * correction is validated by before it is stored (AS-4 correctable, AS-3 spirit).
 */
export function operationHasParameter(
  ir: Ir,
  resourceRef: string,
  operationId: string,
  parameterName: string,
): boolean {
  const operation = resolveOperation(ir, resourceRef, operationId);
  return operation?.parameters.some((parameter) => parameter.name === parameterName) ?? false;
}
