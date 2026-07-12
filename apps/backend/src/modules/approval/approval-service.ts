import { randomUUID } from "node:crypto";

import { createMappingApproved } from "@mediator/event-bus";
import {
  stripUndefined,
  type ApiSpecRole,
  type ApprovedMapping,
  type AuditLogEntry,
  type Ir,
  type MappingApproved,
  type MappingDecision,
  type MappingProposalItem,
  type MappingVariant,
  type ProposalElementRef,
  type TransformSuggestion,
} from "@mediator/domain";

import { BadRequestError, NotFoundError } from "../../app-errors.js";
import {
  assembleChildren,
  resolveIdentityKeys,
  type IdentityKeyConfirmation,
  type OperationOverride,
} from "./assemble.js";
import type { ApprovalTxStores, ApprovalUnitOfWork } from "./persistence.js";
import { serializeRef } from "./refs.js";
import { refResolves } from "./target-ir.js";

/**
 * The **Approval Service** (`docs/architecture/mapping-engine.md` /
 * `docs/flows/mapping-review-and-approval.md`; requirements AS-1..AS-6) — the
 * logic-and-persistence core of Phase 3 that turns a reviewed `MappingProposal`
 * into an `ApprovedMapping` and emits `MappingApproved`. It is the service layer
 * only: the HTTP surface (the RA slice) resolves the authenticated operator
 * `Principal` and passes its `identity` in as the `actor` parameter; this service
 * records `approvedBy`/audit attribution but does no HTTP gating.
 *
 * **Core safety promise:** nothing executes without approval, and the identity key
 * is never auto-confirmed. This service creates **no** `SyncRule`/`AdapterBinding`
 * and makes **no** outbound call — those are the AI-* consumer's disabled
 * artifacts, reacting asynchronously to the emitted `MappingApproved` (AS-6). The
 * whole approve is one transaction, so a committed approval always emits exactly
 * one deliverable event (AS-6 criterion 5), and an edit-path validation failure
 * (AS-3) rolls everything back.
 */

// ── Per-item decision (AS-1) ─────────────────────────────────────────────────

/** An edit to a single item: a new `targetRef` and/or a new `transform` (AS-1). */
export interface ItemEdit {
  readonly targetRef?: ProposalElementRef;
  readonly transform?: TransformSuggestion;
}

/**
 * A per-item review decision (AS-1). `accept` takes the item as-is; `reject` is
 * **permanent**; `edit` changes the `targetRef` and/or `transform` (picking a
 * different `ambiguousAlternatives` option is an `edit` whose `targetRef` is that
 * alternative's), and an `edit` that gives an `unmapped` item a `targetRef` maps it.
 */
export type ItemReviewDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "reject" }
  | { readonly kind: "edit"; readonly edit: ItemEdit };

export interface DecideItemInput {
  readonly itemId: string;
  readonly decision: ItemReviewDecision;
}

// ── Approve (AS-2..AS-6) ─────────────────────────────────────────────────────

/**
 * The approve action's input (AS-2). It approves the proposal's current selection
 * — every `accepted`/`edited` item — leaving `pending` items pending. The reviewer
 * corrections that configure the assembled artifacts ride along:
 * `operationOverrides` correct a derived `action`/`targetIdParamRef` (AS-4), and
 * `identityKeys` confirm the peer-peer identity key(s) (AS-5). Both are keyed by
 * item id and are re-applied on every (incremental) approve; a prior approval's
 * confirmations the current call does not re-specify are carried forward
 * unchanged.
 */
export interface ApproveInput {
  readonly proposalId: string;
  readonly operationOverrides?: readonly OperationOverride[];
  readonly identityKeys?: readonly IdentityKeyConfirmation[];
}

/**
 * The approve outcome. `approved`/`partially_approved` produced (or updated) an
 * `ApprovedMapping` and emitted exactly one `MappingApproved`; `rejected` produced
 * none (every item was rejected — AS-2 criterion 3).
 */
export type ApproveResult =
  | {
      readonly outcome: "approved" | "partially_approved";
      readonly mapping: ApprovedMapping;
      readonly event: MappingApproved;
    }
  | { readonly outcome: "rejected" };

export interface ApprovalServiceDeps {
  readonly unitOfWork: ApprovalUnitOfWork;
  /** Id factory for the mapping/child/audit rows; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Clock for `approvedAt`/audit timestamps; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class ApprovalService {
  readonly #uow: ApprovalUnitOfWork;
  readonly #newId: () => string;
  readonly #now: () => Date;

  public constructor(deps: ApprovalServiceDeps) {
    this.#uow = deps.unitOfWork;
    this.#newId = deps.newId ?? ((): string => randomUUID());
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /**
   * Record a per-item review decision (AS-1): move the item to
   * `accepted`/`edited`/`rejected`, capture any edit against it, and write a
   * `mapping-decision` audit entry attributed to `actor`. Rejection is permanent —
   * a further decision on a `rejected` item is refused (AS-1 criterion 3).
   */
  public async decideItem(input: DecideItemInput, actor: string): Promise<MappingProposalItem> {
    return this.#uow.run(async (stores) => {
      const item = await stores.proposals.getItemById(input.itemId);
      if (item === undefined) {
        throw new NotFoundError(`Mapping proposal item ${input.itemId} does not exist.`);
      }
      if (item.reviewState === "rejected") {
        throw new BadRequestError(
          "This item is rejected; rejection is permanent and cannot be re-decided.",
        );
      }

      const { updated, decision } = applyDecision(item, input.decision);
      const persisted = await stores.proposals.updateItemReview(updated);
      if (persisted === undefined) {
        throw new NotFoundError(`Mapping proposal item ${input.itemId} does not exist.`);
      }
      await stores.audit.insert(
        this.#auditEntry({
          actor,
          decision,
          relatedProposalId: item.proposalId,
          relatedItemId: item.id,
        }),
      );
      return persisted;
    });
  }

  /**
   * Assemble the proposal's accepted/edited items into a single `ApprovedMapping`
   * and emit `MappingApproved` (AS-2..AS-6). The whole action is one transaction:
   * edit-path validation (AS-3) runs before assembly, so an unresolvable target ref
   * rolls everything back and commits nothing.
   */
  public async approve(input: ApproveInput, actor: string): Promise<ApproveResult> {
    return this.#uow.run((stores) => this.#approveInTx(stores, input, actor));
  }

  async #approveInTx(
    stores: ApprovalTxStores,
    input: ApproveInput,
    actor: string,
  ): Promise<ApproveResult> {
    const proposal = await stores.proposals.getById(input.proposalId);
    if (proposal === undefined) {
      throw new NotFoundError(`Mapping proposal ${input.proposalId} does not exist.`);
    }
    if (proposal.status === "failed") {
      throw new BadRequestError("A failed proposal has no reviewable items to approve.");
    }

    const items = await stores.proposals.listItems(input.proposalId);
    const assembled = items.filter(
      (item) => item.reviewState === "accepted" || item.reviewState === "edited",
    );
    const mappable = assembled.filter((item) => !item.unmapped && item.targetRef !== undefined);
    const pendingCount = items.filter((item) => item.reviewState === "pending").length;

    // AS-2 criterion 3 + edge cases: nothing mappable → no ApprovedMapping.
    if (mappable.length === 0) {
      const allRejected =
        items.length > 0 && items.every((item) => item.reviewState === "rejected");
      if (allRejected) {
        await stores.proposals.updateStatus(proposal.id, "rejected");
        await stores.audit.insert(
          this.#auditEntry({
            actor,
            decision: "approve",
            relatedProposalId: proposal.id,
            details: "rejected",
          }),
        );
        return { outcome: "rejected" };
      }
      throw new BadRequestError(
        "No mapped items to approve: accept or edit at least one correspondence, or reject the rest.",
      );
    }

    const sourceSpec = await stores.specs.getById(proposal.sourceSpecId);
    const targetSpec = await stores.specs.getById(proposal.targetSpecId);
    if (sourceSpec === undefined || targetSpec === undefined) {
      throw new BadRequestError("The proposal references a spec that no longer exists.");
    }
    const variant = deriveVariant(sourceSpec.role, targetSpec.role);
    const targetIr = targetSpec.parsedIR;

    // AS-3: validate every mappable item's effective targetRef against the target
    // IR BEFORE any write. A failure throws, rolling back the whole transaction.
    validateTargetRefs(mappable, targetIr);

    // Update-in-place: the single active mapping for this directional spec pair.
    const existing = await stores.approvedMappings.getActiveByDirectionalSpecPair(
      proposal.sourceSpecId,
      proposal.targetSpecId,
    );
    const mappingId = existing?.id ?? this.#newId();
    const existingFields =
      existing === undefined ? [] : await stores.artifacts.listFieldMappings(mappingId);
    const existingOperations =
      existing === undefined ? [] : await stores.artifacts.listOperationMappings(mappingId);

    // AS-6 criterion 2 + AS-5 criterion 4: the reverse-direction active mapping and
    // its identity field(s), for counterpart linking and the shared-pairing lock.
    const counterpart =
      variant === "peer-peer"
        ? await stores.approvedMappings.getActiveByDirectionalSpecPair(
            proposal.targetSpecId,
            proposal.sourceSpecId,
          )
        : undefined;
    const counterpartFields =
      counterpart === undefined ? [] : await stores.artifacts.listFieldMappings(counterpart.id);

    // AS-5: validate identity-key confirmations (rename-only, one-per-pair,
    // shared-pairing lock, CP-has-none, no auto-confirm).
    const identity = resolveIdentityKeys({
      confirmations: input.identityKeys ?? [],
      mappableItems: mappable,
      variant,
      counterpartFields,
    });

    const artifacts = assembleChildren({
      mappingId,
      variant,
      targetIr,
      mappableItems: mappable,
      operationOverrides: input.operationOverrides ?? [],
      identity,
      existingFields,
      existingOperations,
      newId: this.#newId,
    });

    const now = this.#now();
    let mapping: ApprovedMapping;
    if (existing === undefined) {
      mapping = await stores.approvedMappings.insert(
        stripUndefined({
          id: mappingId,
          sourceSpecId: proposal.sourceSpecId,
          targetSpecId: proposal.targetSpecId,
          sourceAppId: sourceSpec.appId,
          targetAppId: targetSpec.appId,
          variant,
          approvedBy: actor,
          approvedAt: now,
          status: "active" as const,
        }),
      );
    } else {
      const patched: ApprovedMapping = { ...existing, approvedBy: actor, approvedAt: now };
      const updated = await stores.approvedMappings.update(patched);
      if (updated === undefined) {
        throw new NotFoundError(`Approved mapping ${mappingId} vanished during approval.`);
      }
      mapping = updated;
    }

    await stores.artifacts.replaceChildren(mappingId, artifacts);

    // AS-6 criterion 2: opportunistically cross-link the reverse direction.
    if (variant === "peer-peer" && counterpart !== undefined) {
      if (mapping.counterpartMappingId !== counterpart.id) {
        await stores.approvedMappings.setCounterpart(mapping.id, counterpart.id);
        mapping = { ...mapping, counterpartMappingId: counterpart.id };
      }
      if (counterpart.counterpartMappingId !== mapping.id) {
        await stores.approvedMappings.setCounterpart(counterpart.id, mapping.id);
      }
    }

    const outcome: "approved" | "partially_approved" =
      pendingCount === 0 ? "approved" : "partially_approved";
    await stores.proposals.updateStatus(proposal.id, outcome);
    await stores.audit.insert(
      this.#auditEntry({
        actor,
        decision: "approve",
        relatedProposalId: proposal.id,
        relatedMappingId: mapping.id,
        details: outcome,
      }),
    );

    // AS-6 criterion 1/5: emit exactly one MappingApproved on the transactional
    // outbox, inside this same transaction.
    const event = createMappingApproved({ approvedMappingId: mapping.id, variant });
    await stores.emit(event);

    return { outcome, mapping, event };
  }

  #auditEntry(fields: {
    readonly actor: string;
    readonly decision: MappingDecision;
    readonly relatedProposalId: string;
    readonly relatedItemId?: string;
    readonly relatedMappingId?: string;
    readonly details?: string;
  }): AuditLogEntry {
    return stripUndefined({
      id: this.#newId(),
      type: "mapping-decision" as const,
      actor: fields.actor,
      decision: fields.decision,
      relatedProposalId: fields.relatedProposalId,
      relatedItemId: fields.relatedItemId,
      relatedMappingId: fields.relatedMappingId,
      details: fields.details,
      timestamp: this.#now(),
    });
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Derive the mapping `variant` from the pair's spec roles: both `PROVIDER` →
 * peer-peer; consumer (`CONSUMER`) as source, provider (`PROVIDER`) as target →
 * consumer-provider (`docs/architecture/data-model.md` `ApprovedMapping`). Any
 * other combination is a malformed proposal.
 */
export function deriveVariant(sourceRole: ApiSpecRole, targetRole: ApiSpecRole): MappingVariant {
  if (sourceRole === "PROVIDER" && targetRole === "PROVIDER") {
    return "peer-peer";
  }
  if (sourceRole === "CONSUMER" && targetRole === "PROVIDER") {
    return "consumer-provider";
  }
  throw new BadRequestError(
    `Unsupported spec-pair roles for an approved mapping: ${sourceRole} -> ${targetRole}.`,
  );
}

/**
 * AS-3: validate every mappable item's effective `targetRef` against the target
 * IR. Throws a `BadRequestError` naming the first unresolvable ref (the approve
 * then rolls back atomically). Accepted-as-is items are validated the same way as
 * edited ones — a defense-in-depth check, not only an edit check (AS-3 crit 6).
 */
export function validateTargetRefs(items: readonly MappingProposalItem[], targetIr: Ir): void {
  for (const item of items) {
    if (item.targetRef === undefined) {
      continue;
    }
    if (!refResolves(targetIr, item.targetRef)) {
      throw new BadRequestError(
        `Approval rejected: target ref ${serializeRef(item.targetRef)} does not resolve against the target spec's IR.`,
      );
    }
  }
}

/** Apply a per-item decision (AS-1), returning the updated item + the audit decision. */
export function applyDecision(
  item: MappingProposalItem,
  decision: ItemReviewDecision,
): { updated: MappingProposalItem; decision: MappingDecision } {
  switch (decision.kind) {
    case "accept":
      return { updated: { ...item, reviewState: "accepted" }, decision: "accept" };
    case "reject":
      return { updated: { ...item, reviewState: "rejected" }, decision: "reject" };
    case "edit":
      return { updated: applyEdit(item, decision.edit), decision: "edit" };
  }
}

function applyEdit(item: MappingProposalItem, edit: ItemEdit): MappingProposalItem {
  const hasNewTarget = edit.targetRef !== undefined;
  const hasNewTransform = edit.transform !== undefined;
  if (!hasNewTarget && !hasNewTransform) {
    throw new BadRequestError("An edit must change the targetRef or the transform.");
  }
  if (edit.targetRef !== undefined && edit.targetRef.target.kind !== item.kind) {
    throw new BadRequestError(`A ${item.kind} item's targetRef must name a ${item.kind}.`);
  }

  const targetRef = edit.targetRef ?? item.targetRef;
  if (targetRef === undefined) {
    throw new BadRequestError("Editing an unmapped item requires a targetRef.");
  }

  const transformSuggestion = resolveEditedTransform(item, edit, hasNewTransform);

  return stripUndefined({
    ...item,
    targetRef,
    transformSuggestion,
    unmapped: false,
    reviewState: "edited" as const,
  });
}

/** Compute the edited item's `transformSuggestion` per its kind (see item schema states). */
function resolveEditedTransform(
  item: MappingProposalItem,
  edit: ItemEdit,
  hasNewTransform: boolean,
): TransformSuggestion | null {
  if (item.kind === "operation") {
    if (hasNewTransform) {
      throw new BadRequestError("An operation item carries no transform.");
    }
    // A mapped operation item carries an explicit null transform.
    return null;
  }
  if (item.kind === "field") {
    // `?? undefined` collapses the item's null (an operation state, not a field one)
    // to absent, so `effective` is `TransformSuggestion | undefined`.
    const existing = item.transformSuggestion ?? undefined;
    const effective = edit.transform ?? existing;
    if (effective === undefined) {
      throw new BadRequestError("A mapped field item requires a transform.");
    }
    return effective;
  }
  // parameter: a pass-through carries null, a transforming one an object.
  return edit.transform ?? item.transformSuggestion ?? null;
}
