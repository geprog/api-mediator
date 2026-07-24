import type { ApprovedMapping } from "@mediator/domain";
import { and, desc, eq, inArray, or } from "drizzle-orm";

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
   * **SL-2.1 — every `active` `ApprovedMapping` pinned to `specId`** on either side
   * (`sourceSpecId` or `targetSpecId`). The set the additive re-pin advances when a
   * spec lineage's active version is superseded: an additive diff proves each
   * referenced element unchanged, so each of these mappings is re-pinned to the new
   * version. Only `active` rows — a `superseded`/`archived` mapping already describes
   * an old shape and is never advanced.
   */
  public async listActiveBySpecId(specId: string): Promise<ApprovedMapping[]> {
    const rows = await this.db
      .select()
      .from(approvedMapping)
      .where(
        and(
          eq(approvedMapping.status, "active"),
          or(eq(approvedMapping.sourceSpecId, specId), eq(approvedMapping.targetSpecId, specId)),
        ),
      );
    return rows.map(mapApprovedMappingRow);
  }

  /**
   * **SL-2.1/2.2 — re-pin a mapping to a new spec version.** Updates **only** the
   * pinned spec ids (`sourceSpecId`/`targetSpecId`); every other column —
   * `status`, `counterpartMappingId`, `approvedBy`/`approvedAt`, `variant`, and the
   * mapping's `FieldMapping`/`OperationMapping` children — is left byte-identical, so
   * nothing that executes changes and no re-review is required. The caller supplies
   * the re-pinned pair (one side advanced, the other carried forward). Returns the
   * updated mapping, or `undefined` when no row with `id` exists.
   */
  public async repinSpecs(
    id: string,
    sourceSpecId: string,
    targetSpecId: string,
  ): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ sourceSpecId, targetSpecId })
      .where(eq(approvedMapping.id, id))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * **SL-4.1/4.2/4.3 — mark a mapping `stale`.** Sets **only** `status = "stale"`;
   * every other column is left byte-identical — in particular the pinned
   * `sourceSpecId`/`targetSpecId` are **untouched** (a stale mapping stays pinned to
   * the version it was reviewed against, SL-4.3 — it describes the old shape), and the
   * `counterpartMappingId` and the mapping's `FieldMapping`/`OperationMapping` children
   * are unchanged. Staleness lives on the mapping **alone** (SL-4.2): its derived
   * `SyncRule`s/`AdapterBinding`s keep their own `status` and pause/fail as a derived
   * condition (the Scheduler holds a stale-mapping rule; RP-3 fails a live call
   * `mapping-stale`). The breaking-diff counterpart of the additive {@link repinSpecs}.
   * Returns the updated mapping, or `undefined` when no row with `id` exists.
   */
  public async markStale(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ status: "stale" })
      .where(eq(approvedMapping.id, id))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * **SL-10.1 — suspend an `active` mapping (the manual operator hold).** Sets **only**
   * `status = "suspended"`; every other column is left byte-identical — the pinned
   * `sourceSpecId`/`targetSpecId`, the `counterpartMappingId`, and the mapping's
   * `FieldMapping`/`OperationMapping` children are all untouched, so resuming restores
   * exactly the reviewed mapping (no re-backfill, no re-composition — SL-10.2).
   *
   * The transition is a **compare-and-set on `status = "active"`**: suspend applies only to
   * an `active` mapping (`docs/architecture/data-model.md` `ApprovedMapping.status`), so a
   * row that is concurrently `stale`/`superseded`/`archived`/already-`suspended` matches
   * nothing and returns `undefined` rather than clobbering a more-blocking status.
   * Suspension lives on the mapping **alone** (data-model `SyncRule.status`): its derived
   * `SyncRule`s/`AdapterBinding`s keep their own `status` and pause/fail as a **derived**
   * condition (the Scheduler holds a suspended-mapping rule; RP-3 fails a live call
   * `mapping-suspended`). The manual counterpart of {@link markStale}.
   */
  public async markSuspended(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ status: "suspended" })
      .where(and(eq(approvedMapping.id, id), eq(approvedMapping.status, "active")))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * **SL-10.2 — resume a `suspended` mapping (the exact inverse of {@link markSuspended}).**
   * Sets **only** `status = "active"`; the pinned spec ids, counterpart, and children are
   * untouched, so the rules/bindings resume under their **stored** state.
   *
   * The transition is a **compare-and-set on `status = "suspended"`**: resume is valid only
   * from `suspended` (data-model `ApprovedMapping.status` — "the operator lifts it by
   * setting the mapping `active` again"). A mapping that went `suspended → stale` under a
   * breaking change (SL-10.5) matches nothing here and returns `undefined`: the
   * more-blocking condition wins, and only re-review/adoption returns it to `active` — never
   * resume. Same for `superseded`/`archived`/already-`active`.
   *
   * NB the caller must first ensure no **other** mapping is `active` on the same directional
   * spec pair — the partial `approved_mapping_active_direction_uq` index admits exactly one
   * (see {@link getActiveByDirectionalSpecPair}) — so that collision surfaces as a clean
   * state conflict rather than a constraint violation.
   */
  public async markActive(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ status: "active" })
      .where(and(eq(approvedMapping.id, id), eq(approvedMapping.status, "suspended")))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * **SL-10.5 — every `suspended` `ApprovedMapping` pinned to `specId`** on either side.
   * The breaking reaction classifies these alongside the `active` set
   * ({@link listActiveBySpecId}): suspension is a *manual* hold and does not stop a
   * `SpecDiff` from classifying the mapping, so a suspended mapping that references a
   * changed element still goes `stale` (`suspended → stale` — the more-blocking condition
   * wins, and only re-review returns it to `active`).
   */
  public async listSuspendedBySpecId(specId: string): Promise<ApprovedMapping[]> {
    const rows = await this.db
      .select()
      .from(approvedMapping)
      .where(
        and(
          eq(approvedMapping.status, "suspended"),
          or(eq(approvedMapping.sourceSpecId, specId), eq(approvedMapping.targetSpecId, specId)),
        ),
      );
    return rows.map(mapApprovedMappingRow);
  }

  /**
   * Every `ApprovedMapping`, most recently approved first — the SL-10 operator read
   * surface (the suspend/resume control needs each mapping's current `status`). Metadata
   * only; the mapping's reviewed children are read separately. Unbounded like the sibling
   * `SyncRule`/`AdapterEndpoint` operator lists — the row count is bounded by the number of
   * reviewed integrations in the landscape.
   */
  public async listAll(): Promise<ApprovedMapping[]> {
    const rows = await this.db
      .select()
      .from(approvedMapping)
      .orderBy(desc(approvedMapping.approvedAt));
    return rows.map(mapApprovedMappingRow);
  }

  /**
   * **AL-1.5 — every `ApprovedMapping` the app participates in**, on either side and in
   * **any** status, ordered by `id` so a cascade over them is deterministic. The
   * app-lifecycle transition reads this to find the `(app pair)`s whose `GraphEdge`s its
   * disable/enable affects — a mapping's `variant` says which edge type
   * (`peer-peer` → the sync edge, `consumer-provider` → the adapter-dependency edge) and
   * its `(sourceAppId, targetAppId)` is the edge's stable key (GR-1.4).
   *
   * Deliberately unfiltered by status: a `stale`/`suspended`/`superseded`/`archived`
   * mapping still contributes members to its edge's aggregate, so its pair must be
   * recomputed too or the edge would keep a status derived from a stale read.
   */
  public async listByAppId(appId: string): Promise<ApprovedMapping[]> {
    const rows = await this.db
      .select()
      .from(approvedMapping)
      .where(or(eq(approvedMapping.sourceAppId, appId), eq(approvedMapping.targetAppId, appId)))
      .orderBy(approvedMapping.id);
    return rows.map(mapApprovedMappingRow);
  }

  /**
   * **SL-7.1 — mark the stale predecessor `superseded` on successor adoption.** Sets
   * **only** `status = "superseded"`; every other column is left byte-identical — the
   * pinned `sourceSpecId`/`targetSpecId` (it describes the old shape), its
   * `FieldMapping`/`OperationMapping` children, and its `predecessorMappingId` chain are
   * all retained for audit. A `superseded` mapping is never executed again: its derived
   * `SyncRule`s/`AdapterBinding`s have been re-pointed to the successor
   * ({@link import("./downstream-artifacts.js").DownstreamArtifactRepository.repointSyncRulesToSuccessor}
   * / `repointAdapterBindingsToSuccessor`), so nothing is left pointing at it that would
   * poll or serve. The adoption counterpart of {@link markStale}. Returns the updated
   * mapping, or `undefined` when no row with `id` exists.
   */
  public async markSuperseded(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ status: "superseded" })
      .where(eq(approvedMapping.id, id))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * Set (or clear) a mapping's `counterpartMappingId` — used to cross-link the
   * reverse-direction mapping when both directions are approved (AS-6 criterion 2), and to
   * **transfer** the pairing to a successor on adoption (SL-7.3): the link is defined over
   * spec lineages, so a counterpart pointing at a now-`superseded` predecessor is updated
   * to the successor that took over its slot.
   */
  public async setCounterpart(id: string, counterpartMappingId: string | null): Promise<void> {
    await this.db
      .update(approvedMapping)
      .set({ counterpartMappingId })
      .where(eq(approvedMapping.id, id));
  }

  /**
   * **AL-2.4 — archive a mapping whose app is being deregistered.** Sets **only**
   * `status = 'archived'`: "`ApprovedMapping`s involving the app are archived … retained
   * for audit, never executed again" (`docs/architecture/extensibility.md` *App
   * lifecycle*). The pinned spec ids, the counterpart/predecessor links, and the approved
   * children are untouched — an archived mapping stays fully readable as history.
   *
   * Reached from **any** status (`active`/`suspended`/`stale`/`superseded`), so — unlike
   * the SL-10 transitions — there is no compare-and-set guard: the app is gone whatever
   * the mapping was doing. Leaving `active` frees the
   * `approved_mapping_active_direction_uq` slot for the directional spec pair, which is
   * correct: no live mapping remains over a deregistered app's specs. Idempotent
   * (re-archiving an archived row rewrites the same value). Returns the updated mapping,
   * or `undefined` when no row with `id` exists.
   */
  public async markArchived(id: string): Promise<ApprovedMapping | undefined> {
    const [row] = await this.db
      .update(approvedMapping)
      .set({ status: "archived" })
      .where(eq(approvedMapping.id, id))
      .returning();
    return row === undefined ? undefined : mapApprovedMappingRow(row);
  }

  /**
   * **AL-2.4 — clear every `counterpartMappingId` *pointing at* an archived mapping.**
   * The reverse-direction link is only meaningful between two live mappings, so once the
   * deregister cascade archives one side, "`counterpartMappingId` links pointing at
   * archived rows are cleared" (`docs/architecture/extensibility.md` *App lifecycle*) —
   * an archived row is cleared only when something *else* archived its counterpart —
   * which, for a bidirectional peer pair, means both rows end up cleared, since the
   * cascade archives both directions and then clears every link pointing at either.
   *
   * Keyed by the **pointed-at** ids (never by app), so a survivor on the other side of a
   * bidirectional peer pair is found whatever app it belongs to. Returns the ids of the
   * rows actually cleared; an empty input clears nothing.
   */
  public async clearCounterpartsPointingAt(mappingIds: readonly string[]): Promise<string[]> {
    if (mappingIds.length === 0) {
      return [];
    }
    const cleared = await this.db
      .update(approvedMapping)
      .set({ counterpartMappingId: null })
      .where(inArray(approvedMapping.counterpartMappingId, [...mappingIds]))
      .returning({ id: approvedMapping.id });
    return cleared.map((row) => row.id);
  }
}
