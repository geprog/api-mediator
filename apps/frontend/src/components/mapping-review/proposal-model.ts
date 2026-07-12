import type {
  MappingProposalItemDto,
  RecordProposalItemDecisionRequest,
} from "@mediator/contracts";
import type { IrRefTarget, ProposalElementRef, TransformKind } from "@mediator/domain";

/**
 * Pure, mount-free helpers for the review UI (RU-1..RU-4). Keeping the derivations
 * here — variant detection, ref formatting, identity-candidate selection, and the
 * edit-request builder — makes the invariant-free presentation logic unit-testable
 * without rendering a component. None of it re-implements a server-enforced rule
 * (rename-only, shared-pairing, target-IR validation stay on the server); it only
 * shapes what the operator sees and what request each control sends.
 */

/** The transform vocabulary an edit can carry (matches `TransformKind`). */
export const TRANSFORM_KINDS: readonly TransformKind[] = [
  "rename",
  "coerce",
  "aggregate",
  "expression",
];

/**
 * The proposal's modeling variant, **derived from its items** (the detail DTO
 * carries no explicit `variant`). Consumer-provider items carry a `phase` or are
 * `parameter`-kind; peer-peer field items carry neither. `indeterminate` is the
 * honest answer for an operation-only or empty (`failed`) proposal — there is no
 * identity key to confirm either way, so the panel stays hidden.
 */
export type ProposalVariant = "peer-peer" | "consumer-provider" | "indeterminate";

export function deriveProposalVariant(items: readonly MappingProposalItemDto[]): ProposalVariant {
  if (items.some((item) => item.phase !== undefined || item.kind === "parameter")) {
    return "consumer-provider";
  }
  if (items.some((item) => item.kind === "field")) {
    return "peer-peer";
  }
  return "indeterminate";
}

/** A peer-peer field item (no `phase`) — the only kind that can hold an identity key. */
export function isPeerPeerFieldItem(item: MappingProposalItemDto): boolean {
  return item.kind === "field" && item.phase === undefined;
}

/** Whether the item's suggested transform is the value-preserving `rename`. */
export function isRenameItem(item: MappingProposalItemDto): boolean {
  const suggestion = item.transformSuggestion;
  return suggestion !== null && suggestion !== undefined && suggestion.transform === "rename";
}

/**
 * The mapped peer-peer field items — the candidate pairings the identity-key panel
 * lists (an identity key is confirmed on an accepted/edited, value-preserving field
 * pairing; the server rejects a non-`rename` or non-decided choice, RA-3/AS-5).
 */
export function identityCandidateItems(
  items: readonly MappingProposalItemDto[],
): MappingProposalItemDto[] {
  return items.filter(
    (item) => isPeerPeerFieldItem(item) && !item.unmapped && item.targetRef !== undefined,
  );
}

/**
 * The item id the LLM flagged `identityCandidate` — the panel's **pre-selection**
 * (never auto-confirmed, RU-4 crit 1). `null` when the model flagged none.
 */
export function suggestedIdentityItemId(items: readonly MappingProposalItemDto[]): string | null {
  const suggested = items.find(
    (item) => isPeerPeerFieldItem(item) && item.identityCandidate === true,
  );
  return suggested?.id ?? null;
}

/** A human-readable rendering of a resource-qualified IR pointer. */
export function describeElementRef(ref: ProposalElementRef): string {
  const target = ref.target;
  const element =
    target.kind === "operation"
      ? `operation ${target.operationId}`
      : target.kind === "field"
        ? `field ${target.path}`
        : `parameter ${target.operationId}.${target.parameter}`;
  return `${ref.resourceRef} · ${element}`;
}

/** Confidence as a whole-percent string for display (e.g. `0.82` → `82%`). */
export function formatConfidence(score: number): string {
  return `${Math.round(score * 100).toString()}%`;
}

// ── Edit draft + request builder (RU-2 crit 2/3/5) ───────────────────────────

/**
 * The operator's in-progress edit, discriminated by the item's target element
 * kind (which lines up one-to-one with the item `kind`). A field edit carries a
 * transform; an operation edit does not; a parameter edit's transform is optional.
 */
export type ItemEditDraft =
  | { readonly kind: "operation"; resourceRef: string; operationId: string }
  | {
      readonly kind: "field";
      resourceRef: string;
      path: string;
      transform: TransformKind;
      transformDetail: string;
    }
  | {
      readonly kind: "parameter";
      resourceRef: string;
      operationId: string;
      parameter: string;
      transform: TransformKind;
      transformDetail: string;
    };

/**
 * The initial edit draft for an item, pre-filled from its current `targetRef` /
 * `transformSuggestion`. An `unmapped` item has no target, so it seeds empty
 * (defaulting the resource to the source's, editable) — supplying a target is what
 * turns it into an `edited` mapping (RU-2 crit 5).
 */
export function initialEditDraft(item: MappingProposalItemDto): ItemEditDraft {
  const resourceRef = item.targetRef?.resourceRef ?? item.sourceRef.resourceRef;
  const suggestion = item.transformSuggestion ?? null;
  const transform: TransformKind = suggestion?.transform ?? "rename";
  const transformDetail = suggestion?.detail ?? "";
  const target = item.targetRef?.target;

  if (item.kind === "operation") {
    return {
      kind: "operation",
      resourceRef,
      operationId: target?.kind === "operation" ? target.operationId : "",
    };
  }
  if (item.kind === "parameter") {
    return {
      kind: "parameter",
      resourceRef,
      operationId: target?.kind === "parameter" ? target.operationId : "",
      parameter: target?.kind === "parameter" ? target.parameter : "",
      transform,
      transformDetail,
    };
  }
  return {
    kind: "field",
    resourceRef,
    path: target?.kind === "field" ? target.path : "",
    transform,
    transformDetail,
  };
}

/** The IR pointer a draft addresses. */
function draftTarget(draft: ItemEditDraft): IrRefTarget {
  switch (draft.kind) {
    case "operation":
      return { kind: "operation", operationId: draft.operationId };
    case "field":
      return { kind: "field", path: draft.path };
    case "parameter":
      return { kind: "parameter", operationId: draft.operationId, parameter: draft.parameter };
  }
}

/**
 * Build the RA-2 `edit` request from a draft. The `targetRef` is always sent; a
 * `transform` accompanies a field/parameter edit (operations carry none). Target-IR
 * validation is the server's (AS-3) — this only assembles the payload.
 */
export function buildEditRequest(draft: ItemEditDraft): RecordProposalItemDecisionRequest {
  const targetRef: ProposalElementRef = {
    resourceRef: draft.resourceRef,
    target: draftTarget(draft),
  };
  if (draft.kind === "operation") {
    return { decision: "edit", targetRef };
  }
  return {
    decision: "edit",
    targetRef,
    transform: {
      transform: draft.transform,
      ...(draft.transformDetail !== "" ? { detail: draft.transformDetail } : {}),
    },
  };
}

/** Whether a draft is complete enough to submit (its target element is named). */
export function isEditDraftComplete(draft: ItemEditDraft): boolean {
  switch (draft.kind) {
    case "operation":
      return draft.resourceRef !== "" && draft.operationId !== "";
    case "field":
      return draft.resourceRef !== "" && draft.path !== "";
    case "parameter":
      return draft.resourceRef !== "" && draft.operationId !== "" && draft.parameter !== "";
  }
}
