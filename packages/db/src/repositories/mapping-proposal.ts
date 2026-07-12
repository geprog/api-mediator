import type {
  MappingProposal,
  MappingProposalItem,
  MappingProposalStatus,
  ReviewState,
  ShortlistResult,
} from "@mediator/domain";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapMappingProposalRow, toMappingProposalInsert } from "../mappers/mapping-proposal.js";
import {
  mapMappingProposalItemRow,
  toMappingProposalItemInsert,
} from "../mappers/mapping-proposal-item.js";
import { mappingProposal, mappingProposalItem } from "../schema.js";

/**
 * Persistence for `MappingProposal` and its wholly-owned `MappingProposalItem`
 * rows. Accepts/returns `@mediator/domain` types through the mappers; Drizzle's
 * inferred optionality never leaks out. Constructor-bound to a {@link DbHandle}
 * (the pooled db or a `tx()` transaction) so `create` composes inside the
 * caller's transaction, matching the Phase-1 repository convention.
 *
 * These rows are **reviewable proposals, never executable mappings** (PP-1): no
 * `ApprovedMapping`, `SyncRule`, or `AdapterBinding` is created here.
 */
export class MappingProposalRepository {
  public constructor(private readonly db: DbHandle) {}

  /**
   * Persist a proposal together with all its items in one call (two inserts),
   * inside the caller's transaction. A `failed` proposal supplies an empty
   * `items` array (PP-1 criterion 4) — the item insert is then skipped. Ids are
   * caller-supplied on the domain objects (as in Phase 1); the caller commits.
   */
  public async create(proposal: MappingProposal, items: MappingProposalItem[]): Promise<void> {
    await this.db.insert(mappingProposal).values(toMappingProposalInsert(proposal));
    if (items.length > 0) {
      await this.db.insert(mappingProposalItem).values(items.map(toMappingProposalItemInsert));
    }
  }

  /** The proposal row for `id` (its items are read via {@link listItems}). */
  public async getById(id: string): Promise<MappingProposal | undefined> {
    const [row] = await this.db.select().from(mappingProposal).where(eq(mappingProposal.id, id));
    return row === undefined ? undefined : mapMappingProposalRow(row);
  }

  /**
   * A proposal's items. The order is **unspecified** — there is no `ORDER BY`,
   * and the ids are random UUIDs, so callers must not rely on ordering; they key
   * by item id (as the tests and the Phase-3 review flow do). If the Phase-3
   * review UI ever needs a stable display order, add an explicit ordinal column
   * then rather than relying on incidental row order here.
   */
  public async listItems(proposalId: string): Promise<MappingProposalItem[]> {
    const rows = await this.db
      .select()
      .from(mappingProposalItem)
      .where(eq(mappingProposalItem.proposalId, proposalId));
    return rows.map(mapMappingProposalItemRow);
  }

  /** A single proposal item by id — the target of a per-item review decision (AS-1). */
  public async getItemById(itemId: string): Promise<MappingProposalItem | undefined> {
    const [row] = await this.db
      .select()
      .from(mappingProposalItem)
      .where(eq(mappingProposalItem.id, itemId));
    return row === undefined ? undefined : mapMappingProposalItemRow(row);
  }

  /**
   * The proposals produced *for* this spec (as the source of a directional
   * analysis), served by the `source_spec_id` index.
   */
  public async listBySourceSpecId(specId: string): Promise<MappingProposal[]> {
    const rows = await this.db
      .select()
      .from(mappingProposal)
      .where(eq(mappingProposal.sourceSpecId, specId));
    return rows.map(mapMappingProposalRow);
  }

  /**
   * Transition a proposal's `status` (e.g. the Phase-3 review outcomes). Returns
   * the updated proposal, or `undefined` when no proposal with `id` exists.
   */
  public async updateStatus(
    id: string,
    status: MappingProposalStatus,
  ): Promise<MappingProposal | undefined> {
    const [row] = await this.db
      .update(mappingProposal)
      .set({ status })
      .where(eq(mappingProposal.id, id))
      .returning();
    return row === undefined ? undefined : mapMappingProposalRow(row);
  }

  /**
   * Replace a proposal's whole `shortlist_result` jsonb. The engine enriches the
   * `shortlistResult` during a run — computing the no-counterpart set and marking
   * a candidate pair `analysisFailed` after a stage-2 detail failure (PP-3) — and
   * writes the updated value back verbatim (updating the whole jsonb is the agreed
   * mechanism; there is no partial-jsonb update path). Returns the updated
   * proposal, or `undefined` when no proposal with `id` exists.
   */
  public async setShortlistResult(
    id: string,
    shortlistResult: ShortlistResult,
  ): Promise<MappingProposal | undefined> {
    const [row] = await this.db
      .update(mappingProposal)
      .set({ shortlistResult })
      .where(eq(mappingProposal.id, id))
      .returning();
    return row === undefined ? undefined : mapMappingProposalRow(row);
  }

  /**
   * Mutate a single item's `reviewState`. Item review is a Phase-3 concern; this
   * minimal setter is provided for completeness. Returns the updated item, or
   * `undefined` when no item with `itemId` exists.
   */
  public async updateItemReviewState(
    itemId: string,
    reviewState: ReviewState,
  ): Promise<MappingProposalItem | undefined> {
    const [row] = await this.db
      .update(mappingProposalItem)
      .set({ reviewState })
      .where(eq(mappingProposalItem.id, itemId))
      .returning();
    return row === undefined ? undefined : mapMappingProposalItemRow(row);
  }

  /**
   * Apply a per-item review decision (AS-1): persist the item's mutable review
   * columns — `review_state` plus the possibly-edited `target_ref`,
   * `transform_suggestion`, and `unmapped` — from the domain item the Approval
   * Service computed. The immutable detection columns (`kind`, `source_ref`,
   * `phase`, `confidence_score`, `ambiguous_alternatives`, `rationale`, and the
   * peer-peer `identity_candidate`/`target_lookup_param_ref` metadata) are left
   * untouched. `target_ref`/`transform_suggestion` collapse an absent domain key to
   * a NULL column exactly as {@link toMappingProposalItemInsert} does, so the
   * null-vs-absent `transformSuggestion` distinction still round-trips via
   * `unmapped`. Returns the updated item, or `undefined` when no item with the id
   * exists.
   */
  public async updateItemReview(
    item: MappingProposalItem,
  ): Promise<MappingProposalItem | undefined> {
    const [row] = await this.db
      .update(mappingProposalItem)
      .set({
        targetRef: item.targetRef ?? null,
        transformSuggestion: item.transformSuggestion ?? null,
        unmapped: item.unmapped,
        reviewState: item.reviewState,
      })
      .where(eq(mappingProposalItem.id, item.id))
      .returning();
    return row === undefined ? undefined : mapMappingProposalItemRow(row);
  }
}
