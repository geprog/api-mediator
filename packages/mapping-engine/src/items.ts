import {
  type MappingPhase,
  type MappingProposalItem,
  type MappingSuggestionSet,
  type OperationSuggestion,
  type ParameterSuggestion,
  type ProposalElementRef,
  stripUndefined,
  type TransformKind,
  type TransformSuggestion,
} from "@mediator/domain";

/**
 * Item construction (PP-2, deliverable 6): turn one validated stage-2
 * `MappingSuggestionSet` for a directional resource pair into
 * `MappingProposalItem`s — one per operation/field/parameter correspondence.
 *
 * The three kinds map mechanically onto the single `MappingProposalItem` entity
 * (`docs/architecture/data-model.md`): `operationMappings → kind = operation`,
 * `fieldMappings → kind = field`, `parameterMappings → kind = parameter` (the
 * last exist only on consumer-provider sets). Refs are **resource-qualified**:
 * a `sourceRef` names an element of the direction's source resource, a `targetRef`
 * an element of its target resource.
 *
 * `transformSuggestion` follows the concept's three states exactly (and the
 * tightened schema): **absent** when `unmapped`; **`null`** for a mapped operation
 * (operations carry no transform); a {@link TransformSuggestion} **object** for a
 * mapped field; and for a parameter, an object when the suggestion names a
 * transform, else `null` (a pass-through parameter).
 *
 * The `identityCandidate` / `targetLookupParamRef` flags on a **peer-peer** field
 * suggestion ARE threaded onto the item as review-time detection metadata (PP-2),
 * so Phase-3 can pre-select the identity key without re-running the LLM (see
 * `docs/flows/mapping-review-and-approval.md` step 6). They are suggestions only —
 * `FieldMapping.isIdentityKey` is still set solely by explicit reviewer
 * confirmation. **Consumer-provider** field items never carry them (the domain
 * schema rejects them on a phased field item): the adapter never correlates records.
 */

/** The two resource refs a directional detail analysis produces items across. */
export interface ItemResourceRefs {
  readonly sourceResourceRef: string;
  readonly targetResourceRef: string;
}

export interface ItemBuildDeps {
  readonly proposalId: string;
  readonly newId: () => string;
}

function operationRef(resourceRef: string, operationId: string): ProposalElementRef {
  return { resourceRef, target: { kind: "operation", operationId } };
}

function fieldRef(resourceRef: string, path: string): ProposalElementRef {
  return { resourceRef, target: { kind: "field", path } };
}

function parameterRef(
  resourceRef: string,
  operationId: string,
  parameter: string,
): ProposalElementRef {
  return { resourceRef, target: { kind: "parameter", operationId, parameter } };
}

/** Build a transform suggestion object, dropping an empty `detail`. */
function toTransformSuggestion(
  transform: TransformKind,
  detail: string | undefined,
): TransformSuggestion {
  return detail !== undefined && detail !== "" ? { transform, detail } : { transform };
}

function buildOperationItem(
  suggestion: OperationSuggestion,
  refs: ItemResourceRefs,
  deps: ItemBuildDeps,
): MappingProposalItem {
  const mapped = !suggestion.unmapped && suggestion.targetOperationId !== null;
  const targetOperationId = suggestion.targetOperationId;
  return stripUndefined({
    id: deps.newId(),
    proposalId: deps.proposalId,
    kind: "operation" as const,
    sourceRef: operationRef(refs.sourceResourceRef, suggestion.sourceOperationId),
    targetRef:
      mapped && targetOperationId !== null
        ? operationRef(refs.targetResourceRef, targetOperationId)
        : undefined,
    // A mapped operation carries an explicit null (never a transform object);
    // an unmapped one carries no transformSuggestion at all.
    transformSuggestion: mapped ? null : undefined,
    confidenceScore: suggestion.confidence,
    ambiguousAlternatives: suggestion.ambiguousAlternatives.map((alt) => ({
      targetRef: operationRef(refs.targetResourceRef, alt.targetOperationId),
      confidence: alt.confidence,
    })),
    unmapped: !mapped,
    rationale: suggestion.rationale,
    reviewState: "pending" as const,
  });
}

/**
 * Peer-peer field detection metadata threaded onto the item (PP-2). Both values
 * are the stage-2 `PeerPeerFieldSuggestion`'s own fields; both are **`undefined`**
 * on a consumer-provider field item, which the domain schema forbids from carrying
 * them. Modeled with explicit `| undefined` value types (not optional keys) so the
 * call sites can pass a possibly-absent suggestion field without tripping
 * `exactOptionalPropertyTypes` — `stripUndefined` below turns an `undefined` into
 * a truly absent key.
 */
interface FieldDetectionMetadata {
  readonly identityCandidate: boolean | undefined;
  readonly targetLookupParamRef: string | undefined;
}

/** A consumer-provider field item carries no peer-peer detection metadata. */
const NO_FIELD_DETECTION: FieldDetectionMetadata = {
  identityCandidate: undefined,
  targetLookupParamRef: undefined,
};

/**
 * Build a `kind = field` item. `phase` is passed only for a consumer-provider set
 * (it is absent on peer-peer field items). A mapped field always carries a
 * transform object (a field suggestion always names a transform). `detection`
 * carries the peer-peer identity suggestion (empty on consumer-provider).
 */
function buildFieldItem(
  suggestion: {
    readonly sourceField: string;
    readonly targetField: string | null;
    readonly transform: TransformKind;
    readonly transformDetail: string;
    readonly confidence: number;
    readonly rationale: string;
    readonly ambiguousAlternatives: readonly {
      readonly targetField: string;
      readonly confidence: number;
    }[];
    readonly unmapped: boolean;
  },
  phase: MappingPhase | undefined,
  detection: FieldDetectionMetadata,
  refs: ItemResourceRefs,
  deps: ItemBuildDeps,
): MappingProposalItem {
  const mapped = !suggestion.unmapped && suggestion.targetField !== null;
  const targetField = suggestion.targetField;
  return stripUndefined({
    id: deps.newId(),
    proposalId: deps.proposalId,
    kind: "field" as const,
    sourceRef: fieldRef(refs.sourceResourceRef, suggestion.sourceField),
    targetRef:
      mapped && targetField !== null ? fieldRef(refs.targetResourceRef, targetField) : undefined,
    phase,
    transformSuggestion: mapped
      ? toTransformSuggestion(suggestion.transform, suggestion.transformDetail)
      : undefined,
    confidenceScore: suggestion.confidence,
    ambiguousAlternatives: suggestion.ambiguousAlternatives.map((alt) => ({
      targetRef: fieldRef(refs.targetResourceRef, alt.targetField),
      confidence: alt.confidence,
    })),
    unmapped: !mapped,
    rationale: suggestion.rationale,
    reviewState: "pending" as const,
    // Peer-peer identity suggestion (undefined → absent key on the item).
    identityCandidate: detection.identityCandidate,
    targetLookupParamRef: detection.targetLookupParamRef,
  });
}

function buildParameterItem(
  suggestion: ParameterSuggestion,
  refs: ItemResourceRefs,
  deps: ItemBuildDeps,
): MappingProposalItem {
  const mapped = !suggestion.unmapped && suggestion.targetParam !== null;
  const targetParam = suggestion.targetParam;
  // A pass-through parameter (mapped, no proposed transform) carries null; a
  // transforming one carries the object. Parameter suggestions carry no
  // ambiguousAlternatives (the concept's explicit shape omits them).
  const transformSuggestion = !mapped
    ? undefined
    : suggestion.transform === undefined
      ? null
      : toTransformSuggestion(suggestion.transform, suggestion.transformDetail);
  return stripUndefined({
    id: deps.newId(),
    proposalId: deps.proposalId,
    kind: "parameter" as const,
    sourceRef: parameterRef(
      refs.sourceResourceRef,
      suggestion.sourceOperationId,
      suggestion.sourceParam,
    ),
    targetRef:
      mapped && targetParam !== null
        ? parameterRef(refs.targetResourceRef, suggestion.targetOperationId, targetParam)
        : undefined,
    transformSuggestion,
    confidenceScore: suggestion.confidence,
    ambiguousAlternatives: [],
    unmapped: !mapped,
    rationale: suggestion.rationale,
    reviewState: "pending" as const,
  });
}

/**
 * Turn a validated `MappingSuggestionSet` into its `MappingProposalItem`s for one
 * directional resource pair. Order is stable: operations, then fields, then (for
 * consumer-provider) parameters, each in the suggestion's own order.
 */
export function buildItems(
  suggestionSet: MappingSuggestionSet,
  refs: ItemResourceRefs,
  deps: ItemBuildDeps,
): MappingProposalItem[] {
  const items: MappingProposalItem[] = suggestionSet.operationMappings.map((suggestion) =>
    buildOperationItem(suggestion, refs, deps),
  );

  if (suggestionSet.variant === "peer-peer") {
    for (const suggestion of suggestionSet.fieldMappings) {
      // Thread the peer-peer identity suggestion (identityCandidate + optional
      // targetLookupParamRef) onto the field item as review-time detection metadata.
      items.push(
        buildFieldItem(
          suggestion,
          undefined,
          {
            identityCandidate: suggestion.identityCandidate,
            targetLookupParamRef: suggestion.targetLookupParamRef,
          },
          refs,
          deps,
        ),
      );
    }
  } else {
    for (const suggestion of suggestionSet.fieldMappings) {
      // Consumer-provider field items never carry identity detection metadata.
      items.push(buildFieldItem(suggestion, suggestion.phase, NO_FIELD_DETECTION, refs, deps));
    }
    for (const suggestion of suggestionSet.parameterMappings) {
      items.push(buildParameterItem(suggestion, refs, deps));
    }
  }

  return items;
}
