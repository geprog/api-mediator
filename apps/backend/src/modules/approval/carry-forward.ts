import type { MappingArtifacts } from "@mediator/db";
import type { FieldMapping, OperationMapping, ParameterMapping } from "@mediator/domain";

/**
 * **SL-7.6 — carry the stale predecessor's UNAFFECTED correspondences into its successor.**
 *
 * A breaking-change re-review (SL-6) is **scoped**: the successor proposal covers only the
 * resource pairs the break actually touched, so the successor's approved
 * `FieldMapping`/`OperationMapping` content covers **only** those pairs. The stale mapping,
 * by contrast, covered every pair it was reviewed for. Adopting the successor in place must
 * therefore NOT let the successor's narrow content silently drop the pairs the break never
 * touched — the reviewer would then lose established correspondences (and their derived
 * `SyncRule`s/`AdapterBinding`s, which re-point wholesale) on a spec bump.
 *
 * **The concrete mechanism:** the successor's persisted child set becomes the **union** of
 * (a) its own re-reviewed content and (b) the predecessor's children for every resource pair
 * the successor does **not** cover — re-parented onto the successor with fresh ids. Realized
 * at **approval time** (folded into the child set `replaceChildren` persists), so the
 * successor is committed *complete* before its `MappingApproved` fires: adoption's adapter
 * half (CO-7 `adoptSuccessor`, which re-validates composition against the successor's content
 * in its own transaction) then sees the carried-forward operations/parameters for unaffected
 * bindings and does not spuriously flag them `composition-required`.
 *
 * **Coverage is keyed at resource-pair granularity** — matching SL-6's scoping unit — so a
 * field the re-review *dropped* from a **touched** pair is genuinely gone (its pair is
 * covered, so the predecessor's copy is not carried), while an **untouched** pair carries
 * forward whole. Response-phase (consumer-provider) fields invert source/target so they group
 * with their operation's `(consumerResource → backendResource)` pair, exactly as the
 * re-review affected-pair computation does. The pair key is a JSON tuple — collision-free and
 * printable, never a NUL-byte join.
 *
 * **Coverage comes from SL-6's affected-pairs list, not merely from the successor's content.**
 * A pair the re-review *touched* but for which the reviewer approved **zero** items — or a
 * removed-resource-group pair that came back `analysisFailed` and was approved anyway — has no
 * successor content, yet it is a pair the break genuinely dropped, not an unaffected one. If
 * coverage were derived from content alone, such a touched-but-empty pair would be misclassified
 * *uncovered* and the predecessor's fields for it wrongly resurrected (over-retention). So the
 * covered set is the **union** of (a) the re-review's affected pairs (`affectedPairs`, the
 * persisted re-review `shortlistResult.candidatePairs` — SL-6.1's forced detail pairs, the same
 * pairs the re-review `DetectionJobScope` records) and (b) the successor's own re-reviewed content
 * pairs (a superset guard: content never falls outside the affected set, but keeping it makes the
 * union robust to any drift). A touched-but-empty pair is thus **covered** (genuinely dropped, not
 * carried), while an **untouched** pair — absent from both — still carries forward whole.
 */
export interface CarryForwardInput {
  /** The successor `ApprovedMapping.id` the carried-forward children are re-parented onto. */
  readonly successorMappingId: string;
  /** The successor's own re-reviewed children (the assembled accepted/edited items). */
  readonly reReviewed: MappingArtifacts;
  /** The stale predecessor's `FieldMapping`s (read via `predecessorMappingId`/`reReviewOf`). */
  readonly predecessorFields: readonly FieldMapping[];
  /** The stale predecessor's `OperationMapping`s. */
  readonly predecessorOperations: readonly OperationMapping[];
  /** The stale predecessor's `ParameterMapping`s (re-parented onto carried-forward operations). */
  readonly predecessorParameters: readonly ParameterMapping[];
  /**
   * SL-6's affected resource pairs — the pairs the breaking-change re-review **touched** (the
   * proposal's persisted `shortlistResult.candidatePairs`, in the proposal's directional
   * `source → target` orientation). Every such pair is treated **covered** even when it produced
   * no successor content, so a touched-but-empty / `analysisFailed`-approved pair is genuinely
   * dropped rather than resurrected from the predecessor. Optional (defaults to `[]`): an
   * ordinary (non-re-review) assembly passes none and coverage is content-only, unchanged.
   */
  readonly affectedPairs?: readonly {
    readonly sourceResource: string;
    readonly targetResource: string;
  }[];
  /** Id factory for the re-parented carried-forward rows. */
  readonly newId: () => string;
}

/** The resource-group portion of a serialized ref (`issues/title` → `issues`). */
function resourceOfRef(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(0, slash);
}

/**
 * The directional resource-pair key of a `FieldMapping`. A `response`-phase
 * (consumer-provider) field inverts source/target so it groups with its operation's
 * `(consumerResource → backendResource)` pair — matching `computeReReviewAffectedPairs`.
 */
function fieldPairKey(field: FieldMapping): string {
  const inverted = field.phase === "response";
  const source = resourceOfRef(inverted ? field.targetPath : field.sourcePath);
  const target = resourceOfRef(inverted ? field.sourcePath : field.targetPath);
  return JSON.stringify([source, target]);
}

/** The directional resource-pair key of an `OperationMapping`. */
function operationPairKey(operation: OperationMapping): string {
  return JSON.stringify([
    resourceOfRef(operation.sourceOperationRef),
    resourceOfRef(operation.targetOperationRef),
  ]);
}

/** The directional resource-pair key of an SL-6 affected pair (same JSON-tuple shape). */
function affectedPairKey(pair: {
  readonly sourceResource: string;
  readonly targetResource: string;
}): string {
  return JSON.stringify([pair.sourceResource, pair.targetResource]);
}

/**
 * Fold the predecessor's unaffected-pair correspondences into the successor's re-reviewed
 * child set (see the module doc). Deterministic and idempotent under the wholesale
 * `replaceChildren`: the covered set is derived from SL-6's affected-pairs list (plus the
 * re-reviewed content) each call, so a re-run (an incremental re-review approve) reproduces the
 * same union.
 */
export function carryForwardUnaffectedCorrespondences(input: CarryForwardInput): MappingArtifacts {
  const { successorMappingId, reReviewed, newId } = input;

  // The pairs the re-review COVERED (the break-touched pairs). Primarily SL-6's affected-pairs
  // list, so a pair the re-review touched but approved ZERO items for (or an `analysisFailed`
  // pair approved anyway) is still covered — genuinely dropped, never resurrected. The
  // successor's own content pairs are unioned in as a superset guard (content ⊆ affected).
  const coveredPairs = new Set<string>();
  for (const pair of input.affectedPairs ?? []) {
    coveredPairs.add(affectedPairKey(pair));
  }
  for (const field of reReviewed.fieldMappings) {
    coveredPairs.add(fieldPairKey(field));
  }
  for (const operation of reReviewed.operationMappings) {
    coveredPairs.add(operationPairKey(operation));
  }

  // Predecessor fields for uncovered pairs → carry forward, re-parented with a fresh id.
  const carriedFields: FieldMapping[] = input.predecessorFields
    .filter((field) => !coveredPairs.has(fieldPairKey(field)))
    .map((field) => ({ ...field, id: newId(), mappingId: successorMappingId }));

  // Predecessor operations for uncovered pairs → carry forward with their parameters,
  // re-pointing each carried parameter at its carried operation's new id.
  const parametersByOperationId = new Map<string, ParameterMapping[]>();
  for (const parameter of input.predecessorParameters) {
    const list = parametersByOperationId.get(parameter.operationMappingId) ?? [];
    list.push(parameter);
    parametersByOperationId.set(parameter.operationMappingId, list);
  }
  const carriedOperations: OperationMapping[] = [];
  const carriedParameters: ParameterMapping[] = [];
  for (const operation of input.predecessorOperations) {
    if (coveredPairs.has(operationPairKey(operation))) {
      continue;
    }
    const newOperationId = newId();
    carriedOperations.push({ ...operation, id: newOperationId, mappingId: successorMappingId });
    for (const parameter of parametersByOperationId.get(operation.id) ?? []) {
      carriedParameters.push({
        ...parameter,
        id: newId(),
        operationMappingId: newOperationId,
      });
    }
  }

  return {
    fieldMappings: [...reReviewed.fieldMappings, ...carriedFields],
    operationMappings: [...reReviewed.operationMappings, ...carriedOperations],
    parameterMappings: [...reReviewed.parameterMappings, ...carriedParameters],
  };
}
