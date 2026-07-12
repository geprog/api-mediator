import type { ApprovedMapping } from "@mediator/domain";
import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapApprovedMappingRow, toApprovedMappingInsert } from "../mappers/approved-mapping.js";
import { approvedMapping } from "../schema.js";

/**
 * Persistence for `ApprovedMapping` — the parent row of the approve outcome (its
 * `FieldMapping`/`OperationMapping`/`ParameterMapping` children hang off
 * {@link MappingArtifactsRepository}). Constructor-bound to a {@link DbHandle} so
 * the whole approve composes inside one transaction, matching the repo convention.
 */
export class ApprovedMappingRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Insert a new `ApprovedMapping` (the first approval of a directional proposal). */
  public async insert(mapping: ApprovedMapping): Promise<ApprovedMapping> {
    const [row] = await this.db
      .insert(approvedMapping)
      .values(toApprovedMappingInsert(mapping))
      .returning();
    if (row === undefined) {
      throw new Error("approved_mapping insert returned no row");
    }
    return mapApprovedMappingRow(row);
  }

  /**
   * Update the mutable fields of an existing `ApprovedMapping` in place (AS-2
   * criterion 4) — `approvedBy`/`approvedAt` (the *most recent* approval), `status`,
   * and `counterpartMappingId`. Returns the updated mapping, or `undefined` when no
   * row with the id exists.
   */
  public async update(mapping: ApprovedMapping): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({
        approvedBy: mapping.approvedBy,
        approvedAt: mapping.approvedAt,
        status: mapping.status,
        counterpartMappingId: mapping.counterpartMappingId ?? null,
      })
      .where(eq(approvedMapping.id, mapping.id))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /** The `ApprovedMapping` for `id`, if any. */
  public async getById(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db.select().from(approvedMapping).where(eq(approvedMapping.id, id));
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * The single **active** `ApprovedMapping` for a directional spec pair, if one
   * exists — the update-in-place lookup (AS-2 criterion 4) and the counterpart
   * lookup (AS-6 criterion 2, called with the spec ids swapped). The partial UNIQUE
   * index (`approved_mapping_active_direction_uq`) guarantees at most one, so this
   * never has to disambiguate.
   */
  public async getActiveByDirectionalSpecPair(
    sourceSpecId: string,
    targetSpecId: string,
  ): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .select()
      .from(approvedMapping)
      .where(
        and(
          eq(approvedMapping.sourceSpecId, sourceSpecId),
          eq(approvedMapping.targetSpecId, targetSpecId),
          eq(approvedMapping.status, "active"),
        ),
      );
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * Set (or clear) a mapping's `counterpartMappingId` — used to cross-link the
   * reverse-direction mapping when both directions are approved (AS-6 criterion 2).
   */
  public async setCounterpart(id: string, counterpartMappingId: string | null): Promise<void> {
    await this.db
      .update(approvedMapping)
      .set({ counterpartMappingId })
      .where(eq(approvedMapping.id, id));
  }
}
