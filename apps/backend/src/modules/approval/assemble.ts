import {
  fieldResourceRef,
  fieldMappingSchema,
  operationMappingSchema,
  parameterMappingSchema,
  stripUndefined,
  type FieldMapping,
  type Ir,
  type MappingProposalItem,
  type MappingVariant,
  type OperationAction,
  type OperationMapping,
  type ParameterMapping,
  type ProposalElementRef,
} from "@mediator/domain";
import type { MappingArtifacts } from "@mediator/db";

import { BadRequestError } from "../../app-errors.js";
import { serializeRef, serializeTargetIdParamRef } from "./refs.js";
import {
  deriveAction,
  deriveTargetIdParamName,
  operationHasParameter,
  resolveOperation,
} from "./target-ir.js";

/**
 * The pure assembly core of the approve action (AS-2/AS-4/AS-5): turn the
 * currently mappable (accepted/edited, non-unmapped) `MappingProposalItem`s into
 * an `ApprovedMapping`'s `FieldMapping`/`OperationMapping`/`ParameterMapping`
 * children, applying the reviewer's `action`/`targetIdParamRef` corrections and
 * identity-key confirmations, and carrying forward the confirmations of an
 * earlier partial approval that the current one does not re-specify.
 *
 * No persistence, no I/O — the {@link ApprovalService} orchestration wraps this in
 * the approve transaction. Every assembled child is finally re-validated against
 * its `@mediator/domain` schema as a defense-in-depth assertion, so a construction
 * mistake (e.g. an identity key on a non-`rename` field, a `targetIdParamRef` on a
 * `create`, an `isIdentityKey` on a consumer-provider row) is caught here rather
 * than persisted.
 */

/** A reviewer's identity-key confirmation for one accepted/edited peer-peer field item. */
export interface IdentityKeyConfirmation {
  readonly itemId: string;
  readonly targetLookupParamRef?: string;
}

/** A reviewer's correction to a derived operation `action` / `targetIdParamRef` (AS-4). */
export interface OperationOverride {
  readonly itemId: string;
  readonly action?: OperationAction;
  /** A parameter *name* on the target operation; serialized to the stored ref. */
  readonly targetIdParamName?: string;
}

/** Canonical (directional) resource-pair key — the unit that owns one identity key. */
export function resourcePairKey(sourceResourceRef: string, targetResourceRef: string): string {
  return `${sourceResourceRef}\u0000${targetResourceRef}`;
}

/**
 * The resource-pair key component of a stored field path, for the AS-5 identity-key
 * invariants below. A well-formed stored path is resource-qualified (`issues/title`),
 * so this is its `resourceRef`; an **unqualified** path names no resource and falls
 * back to the whole path as its own component — preserving these invariants' exact
 * long-standing behavior (two identity fields collide iff they name the same pair).
 *
 * Built on the shared {@link fieldResourceRef} parse rather than a local `split("/")`,
 * so the qualified↔bare boundary has exactly one definition system-wide.
 */
function identityPairComponent(fieldPath: string): string {
  return fieldResourceRef(fieldPath) ?? fieldPath;
}

/** The validated identity-key confirmations plus the resource pairs a *new* one touched. */
export interface ResolvedIdentity {
  readonly byItemId: ReadonlyMap<string, IdentityKeyConfirmation>;
  readonly confirmedResourcePairs: ReadonlySet<string>;
}

function fieldItemRefs(item: MappingProposalItem): {
  sourceRef: ProposalElementRef;
  targetRef: ProposalElementRef;
} {
  if (item.targetRef === undefined) {
    // Unreachable: only mappable (targetRef-present) items reach identity/assembly.
    throw new BadRequestError("an identity key must be a mapped field");
  }
  return { sourceRef: item.sourceRef, targetRef: item.targetRef };
}

/**
 * Validate the reviewer's identity-key confirmations (AS-5) and return them keyed
 * by item id. Enforces, in order: **no identity-key step on consumer-provider**
 * (crit 7); the confirmed item is an accepted/edited **peer-peer field** item; a
 * **rename-only** transform (crit 3); **one identity key per mapped resource pair**
 * (crit 2); and the **shared-pairing lock** against an already-confirmed
 * counterpart-direction identity key (crit 4). It never reads
 * `MappingProposalItem.identityCandidate`: an identity key is set **only** by an
 * explicit confirmation (crit 1/6 — no auto-confirm).
 */
export function resolveIdentityKeys(input: {
  readonly confirmations: readonly IdentityKeyConfirmation[];
  readonly mappableItems: readonly MappingProposalItem[];
  readonly variant: MappingVariant;
  readonly counterpartFields: readonly FieldMapping[];
}): ResolvedIdentity {
  const { confirmations, mappableItems, variant, counterpartFields } = input;

  if (variant === "consumer-provider") {
    if (confirmations.length > 0) {
      // AS-5 criterion 7: the adapter never correlates records — no identity-key step.
      throw new BadRequestError(
        "consumer-provider proposals have no identity-key step: an identity key cannot be confirmed",
      );
    }
    return { byItemId: new Map(), confirmedResourcePairs: new Set() };
  }

  const byItemId = new Map<string, IdentityKeyConfirmation>();
  const confirmedResourcePairs = new Set<string>();
  const byId = new Map(mappableItems.map((item) => [item.id, item]));

  for (const confirmation of confirmations) {
    const item = byId.get(confirmation.itemId);
    if (item === undefined) {
      throw new BadRequestError(
        "an identity-key confirmation must reference an accepted or edited item of this proposal",
      );
    }
    if (item.kind !== "field" || item.phase !== undefined) {
      throw new BadRequestError("an identity key must be a peer-peer field correspondence");
    }
    const { sourceRef, targetRef } = fieldItemRefs(item);
    if (item.transformSuggestion == null || item.transformSuggestion.transform !== "rename") {
      // AS-5 criterion 3: only a value-preserving pairing may be an identity key.
      throw new BadRequestError(
        "an identity key may carry only a value-preserving rename transform",
      );
    }

    const sourceResourceRef = sourceRef.resourceRef;
    const targetResourceRef = targetRef.resourceRef;
    const rpKey = resourcePairKey(sourceResourceRef, targetResourceRef);
    if (confirmedResourcePairs.has(rpKey)) {
      // AS-5 criterion 2: exactly one identity key per mapped resource pair.
      throw new BadRequestError("a mapped resource pair may have only one confirmed identity key");
    }
    confirmedResourcePairs.add(rpKey);

    // AS-5 criterion 4: the shared-pairing lock. If the counterpart direction has
    // already confirmed an identity key for this resource pair, this direction must
    // confirm the SAME field pairing (value-preserving, shared) — a different one is
    // a validation error.
    const sourcePath = serializeRef(sourceRef);
    const targetPath = serializeRef(targetRef);
    const counterpartIdentity = counterpartFields.find(
      (field) =>
        field.isIdentityKey === true &&
        identityPairComponent(field.sourcePath) === targetResourceRef &&
        identityPairComponent(field.targetPath) === sourceResourceRef,
    );
    if (
      counterpartIdentity !== undefined &&
      (counterpartIdentity.sourcePath !== targetPath ||
        counterpartIdentity.targetPath !== sourcePath)
    ) {
      throw new BadRequestError(
        "shared-pairing lock: this direction's identity key must match the counterpart direction's confirmed field pairing",
      );
    }

    byItemId.set(item.id, confirmation);
  }

  return { byItemId, confirmedResourcePairs };
}

// ── Child assembly ───────────────────────────────────────────────────────────

export interface AssembleInput {
  readonly mappingId: string;
  readonly variant: MappingVariant;
  readonly targetIr: Ir;
  /** Accepted/edited, non-unmapped items only (each has a `targetRef`). */
  readonly mappableItems: readonly MappingProposalItem[];
  readonly operationOverrides: readonly OperationOverride[];
  readonly identity: ResolvedIdentity;
  /** The current `ApprovedMapping`'s existing children, for carry-forward. */
  readonly existingFields: readonly FieldMapping[];
  readonly existingOperations: readonly OperationMapping[];
  /**
   * The counterpart-direction mapping's `FieldMapping`s (empty when there is no
   * approved reverse direction). Used by the final identity re-assertion to apply
   * the shared-pairing lock to the *whole* assembled field set — new,
   * carried-forward, or otherwise (AS-5 criterion 4).
   */
  readonly counterpartFields: readonly FieldMapping[];
  readonly newId: () => string;
}

/**
 * Re-assert the AS-5 identity-key invariants over the **final assembled field
 * set** — a defense-in-depth pass so no assembly path (a new confirmation, a
 * carried-forward one, or two field items sharing one source ref) can emit a
 * second or contradictory identity key. It enforces the same three locks
 * {@link resolveIdentityKeys} applies to new confirmations: rename-only (AS-5
 * criterion 3), exactly **one** identity key per mapped resource pair (criterion
 * 2), and the shared-pairing lock against the counterpart direction's confirmed
 * identity `FieldMapping` (criterion 4). Throws the same `BadRequestError` type.
 */
export function assertIdentityInvariants(
  fieldMappings: readonly FieldMapping[],
  counterpartFields: readonly FieldMapping[],
): void {
  const seenResourcePairs = new Set<string>();
  for (const field of fieldMappings) {
    if (field.isIdentityKey !== true) {
      continue;
    }
    if (field.transform !== "rename") {
      throw new BadRequestError(
        "an identity key may carry only a value-preserving rename transform",
      );
    }
    const sourceResourceRef = identityPairComponent(field.sourcePath);
    const targetResourceRef = identityPairComponent(field.targetPath);
    const rpKey = resourcePairKey(sourceResourceRef, targetResourceRef);
    if (seenResourcePairs.has(rpKey)) {
      throw new BadRequestError("a mapped resource pair may have only one confirmed identity key");
    }
    seenResourcePairs.add(rpKey);

    const counterpartIdentity = counterpartFields.find(
      (cp) =>
        cp.isIdentityKey === true &&
        identityPairComponent(cp.sourcePath) === targetResourceRef &&
        identityPairComponent(cp.targetPath) === sourceResourceRef,
    );
    if (
      counterpartIdentity !== undefined &&
      (counterpartIdentity.sourcePath !== field.targetPath ||
        counterpartIdentity.targetPath !== field.sourcePath)
    ) {
      throw new BadRequestError(
        "shared-pairing lock: this direction's identity key must match the counterpart direction's confirmed field pairing",
      );
    }
  }
}

function requireTargetRef(item: MappingProposalItem): ProposalElementRef {
  if (item.targetRef === undefined) {
    throw new BadRequestError("a mapped item must carry a targetRef");
  }
  return item.targetRef;
}

function assembleFieldMapping(
  item: MappingProposalItem,
  input: AssembleInput,
  existingBySourcePath: ReadonlyMap<string, FieldMapping>,
): FieldMapping {
  const targetRef = requireTargetRef(item);
  const sourcePath = serializeRef(item.sourceRef);
  const targetPath = serializeRef(targetRef);
  const transform = item.transformSuggestion?.transform;
  if (transform === undefined || item.transformSuggestion === null) {
    throw new BadRequestError(`a mapped field item requires a transform: ${sourcePath}`);
  }

  const isConsumerProvider = input.variant === "consumer-provider";
  if (isConsumerProvider && item.phase === undefined) {
    throw new BadRequestError(`a consumer-provider field item is missing its phase: ${sourcePath}`);
  }
  if (!isConsumerProvider && item.phase !== undefined) {
    throw new BadRequestError(`a peer-peer field item must not carry a phase: ${sourcePath}`);
  }

  // AS-5: identity is set ONLY from an explicit confirmation, or carried forward
  // from a prior explicit confirmation the current approve does not re-specify.
  // Never from `item.identityCandidate` (no auto-confirm).
  let isIdentityKey: true | undefined;
  let targetLookupParamRef: string | undefined;
  if (!isConsumerProvider) {
    const rpKey = resourcePairKey(item.sourceRef.resourceRef, targetRef.resourceRef);
    const newConfirmation = input.identity.byItemId.get(item.id);
    if (newConfirmation !== undefined) {
      isIdentityKey = true;
      targetLookupParamRef = newConfirmation.targetLookupParamRef;
    } else if (!input.identity.confirmedResourcePairs.has(rpKey)) {
      // No new confirmation touched this resource pair: carry forward a prior
      // identity confirmation on this exact field — but ONLY when the FULL pairing
      // is unchanged (same source AND target path) and still rename. An edit to the
      // target drops the carried identity flag, forcing an explicit re-confirmation,
      // which re-runs the AS-5 one-per-pair + shared-pairing locks (an unmatched
      // carry-forward would otherwise silently re-pair the identity key — the
      // contradictory-RecordLink state the shared-pairing lock exists to prevent).
      const prior = existingBySourcePath.get(sourcePath);
      if (
        prior?.isIdentityKey === true &&
        prior.targetPath === targetPath &&
        transform === "rename"
      ) {
        isIdentityKey = true;
        targetLookupParamRef = prior.targetLookupParamRef;
      }
    }
  }

  const field = stripUndefined({
    id: input.newId(),
    mappingId: input.mappingId,
    sourcePath,
    targetPath,
    transform,
    phase: isConsumerProvider ? item.phase : undefined,
    isIdentityKey,
    targetLookupParamRef,
  });
  return fieldMappingSchema.parse(field);
}

function assembleOperationMapping(
  item: MappingProposalItem,
  input: AssembleInput,
  existingBySourceRef: ReadonlyMap<string, OperationMapping>,
): OperationMapping {
  const targetRef = requireTargetRef(item);
  if (targetRef.target.kind !== "operation") {
    throw new BadRequestError("an operation item's targetRef must name an operation");
  }
  const sourceOperationRef = serializeRef(item.sourceRef);
  const targetOperationRef = serializeRef(targetRef);
  const targetResourceRef = targetRef.resourceRef;
  const targetOperationId = targetRef.target.operationId;

  const targetOperation = resolveOperation(input.targetIr, targetResourceRef, targetOperationId);
  if (targetOperation === undefined) {
    // Unreachable: AS-3 validation already proved this operation resolves.
    throw new BadRequestError(`unresolvable target operation: ${targetOperationRef}`);
  }

  const override = input.operationOverrides.find((o) => o.itemId === item.id);
  const prior = existingBySourceRef.get(sourceOperationRef);
  // AS-4: derived, unless the reviewer overrode it now or in a prior approve.
  const action: OperationAction =
    override?.action ?? prior?.action ?? deriveAction(targetOperation);

  let targetIdParamRef: string | undefined;
  // AS-4 criteria 3/4/5: a target-id parameter is derived only for a PEER-PEER
  // update/delete; it is absent on create/read and on every consumer-provider row.
  if (input.variant === "peer-peer" && (action === "update" || action === "delete")) {
    if (override?.targetIdParamName !== undefined) {
      if (
        !operationHasParameter(
          input.targetIr,
          targetResourceRef,
          targetOperationId,
          override.targetIdParamName,
        )
      ) {
        throw new BadRequestError(
          `targetIdParamRef correction names a parameter that does not exist on ${targetOperationRef}`,
        );
      }
      targetIdParamRef = serializeTargetIdParamRef(
        targetResourceRef,
        targetOperationId,
        override.targetIdParamName,
      );
    } else if (prior?.targetIdParamRef !== undefined && prior.action === action) {
      targetIdParamRef = prior.targetIdParamRef;
    } else {
      const derivedName = deriveTargetIdParamName(targetOperation);
      if (derivedName !== undefined) {
        targetIdParamRef = serializeTargetIdParamRef(
          targetResourceRef,
          targetOperationId,
          derivedName,
        );
      }
      // else: ambiguous (0 or >1 path params) — left absent; approval still
      // completes and the reviewer corrects it before enablement (Phase 4).
    }
  }

  const operation = stripUndefined({
    id: input.newId(),
    mappingId: input.mappingId,
    sourceOperationRef,
    targetOperationRef,
    action,
    targetIdParamRef,
  });
  return operationMappingSchema.parse(operation);
}

function assembleParameterMapping(
  item: MappingProposalItem,
  operationMappingId: string,
  newId: () => string,
): ParameterMapping {
  const targetRef = requireTargetRef(item);
  const transform = item.transformSuggestion?.transform;
  const parameter = stripUndefined({
    id: newId(),
    operationMappingId,
    sourceParamRef: serializeRef(item.sourceRef),
    targetParamRef: serializeRef(targetRef),
    // A pass-through parameter (transformSuggestion null/absent) carries no transform.
    transform: transform ?? undefined,
  });
  return parameterMappingSchema.parse(parameter);
}

/**
 * Assemble the full child set for the mapping from the mappable items (AS-2).
 * `ParameterMapping`s (consumer-provider only) are attached to the
 * `OperationMapping` that pairs their operation — matched by the parameter's
 * source operation id — so a parameter whose operation was not itself approved is
 * a validation error (a parameter has no home without its operation pairing).
 */
export function assembleChildren(input: AssembleInput): MappingArtifacts {
  const existingFieldBySourcePath = new Map(
    input.existingFields.map((field) => [field.sourcePath, field]),
  );
  const existingOperationBySourceRef = new Map(
    input.existingOperations.map((operation) => [operation.sourceOperationRef, operation]),
  );

  const fieldMappings: FieldMapping[] = [];
  const operationMappings: OperationMapping[] = [];
  const parameterMappings: ParameterMapping[] = [];

  // Operation items first, so their assembled ids are available to parameters.
  // Keyed by (resourceRef, source operationId) for the parameter → operation join.
  const operationMappingByOperationKey = new Map<string, string>();
  for (const item of input.mappableItems) {
    if (item.kind !== "operation") {
      continue;
    }
    const operation = assembleOperationMapping(item, input, existingOperationBySourceRef);
    operationMappings.push(operation);
    if (item.sourceRef.target.kind === "operation") {
      operationMappingByOperationKey.set(
        `${item.sourceRef.resourceRef}\u0000${item.sourceRef.target.operationId}`,
        operation.id,
      );
    }
  }

  for (const item of input.mappableItems) {
    if (item.kind === "field") {
      fieldMappings.push(assembleFieldMapping(item, input, existingFieldBySourcePath));
    } else if (item.kind === "parameter") {
      if (input.variant === "peer-peer") {
        throw new BadRequestError("a peer-peer mapping has no parameter mappings");
      }
      if (item.sourceRef.target.kind !== "parameter") {
        throw new BadRequestError("a parameter item's sourceRef must name a parameter");
      }
      const operationKey = `${item.sourceRef.resourceRef}\u0000${item.sourceRef.target.operationId}`;
      const operationMappingId = operationMappingByOperationKey.get(operationKey);
      if (operationMappingId === undefined) {
        throw new BadRequestError(
          `parameter mapping ${serializeRef(item.sourceRef)} has no approved operation pairing to hang off`,
        );
      }
      parameterMappings.push(assembleParameterMapping(item, operationMappingId, input.newId));
    }
  }

  // Defense-in-depth: re-run the AS-5 locks over the whole assembled field set,
  // catching any second/contradictory identity key regardless of how it got there.
  assertIdentityInvariants(fieldMappings, input.counterpartFields);

  return { fieldMappings, operationMappings, parameterMappings };
}
