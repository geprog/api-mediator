import type { ResourceBinding } from "@mediator/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  applyScopePathBindingPatch,
  mapResourceBinding,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ResourceBindingRefPatch,
  type ResourceBindingRefRow,
  type ScopePathBindingPatch,
  type SourceScopeRefPatch,
} from "../mappers/resource-binding.js";
import { RESOURCE_BINDING_REF_KINDS, resourceBinding, resourceBindingRef } from "../schema.js";

/**
 * Persistence for `ResourceBinding` and its normalized `resource_binding_ref`
 * child rows. A binding round-trips losslessly: present refs become child rows,
 * absent refs produce none, and `confirmedAt` stays a real timestamp.
 */
export class ResourceBindingRepository {
  public constructor(private readonly db: DbHandle) {}

  /** Persist a spec's bindings (parents + their present refs) in one go. */
  public async createMany(bindings: ResourceBinding[]): Promise<ResourceBinding[]> {
    if (bindings.length === 0) {
      return [];
    }
    await this.db.insert(resourceBinding).values(bindings.map(toResourceBindingInsert));
    const refInserts = bindings.flatMap(toResourceBindingRefInserts);
    if (refInserts.length > 0) {
      await this.db.insert(resourceBindingRef).values(refInserts);
    }
    return this.readByIds(bindings.map((binding) => binding.id));
  }

  public async getById(id: string): Promise<ResourceBinding | undefined> {
    const [row] = await this.db.select().from(resourceBinding).where(eq(resourceBinding.id, id));
    if (row === undefined) {
      return undefined;
    }
    const refRows = await this.db
      .select()
      .from(resourceBindingRef)
      .where(eq(resourceBindingRef.resourceBindingId, id));
    return mapResourceBinding(row, refRows);
  }

  public async listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]> {
    const rows = await this.db
      .select()
      .from(resourceBinding)
      .where(eq(resourceBinding.apiSpecId, apiSpecId));
    return this.assemble(rows);
  }

  /**
   * Confirm or correct a binding's refs (per-ref: confirming one leaves the
   * others untouched). A patch entry carrying only confirmation sets
   * `confirmed_by`/`confirmed_at`; one also carrying a `value` corrects the ref.
   *
   * A **correction upserts** the ref row: it inserts when `(binding, refKind)`
   * has no row yet, and updates when it does. This is the RB-3 case where the
   * operator ratifies an applicable ref the heuristic produced no guess for
   * (no existing row) — an UPDATE-only there would silently match zero rows and
   * persist nothing. A pure confirmation (no `value`) stays an UPDATE, since a
   * ref with no value cannot be inserted (`value` is NOT NULL) — the service
   * layer already rejects confirming a not-yet-derived ref without a correction.
   *
   * Returns the updated binding, or `undefined` if no binding with `id` exists.
   */
  public async update(
    id: string,
    patch: ResourceBindingRefPatch,
  ): Promise<ResourceBinding | undefined> {
    for (const kind of RESOURCE_BINDING_REF_KINDS) {
      const refPatch = patch[kind];
      if (refPatch === undefined) {
        continue;
      }
      const set = toResourceBindingRefUpdate(refPatch);
      if (Object.keys(set).length === 0) {
        continue;
      }
      if (refPatch.value !== undefined) {
        // Correction → upsert on the (binding, kind) unique index.
        await this.db
          .insert(resourceBindingRef)
          .values({
            resourceBindingId: id,
            refKind: kind,
            value: refPatch.value,
            confirmedBy: "confirmedBy" in refPatch ? refPatch.confirmedBy : null,
            confirmedAt: "confirmedAt" in refPatch ? refPatch.confirmedAt : null,
          })
          .onConflictDoUpdate({
            target: [resourceBindingRef.resourceBindingId, resourceBindingRef.refKind],
            set,
          });
      } else {
        // Pure confirmation → update the existing row's confirmation columns.
        await this.db
          .update(resourceBindingRef)
          .set(set)
          .where(
            and(eq(resourceBindingRef.resourceBindingId, id), eq(resourceBindingRef.refKind, kind)),
          );
      }
    }
    return this.getById(id);
  }

  /**
   * Confirm/correct one **scope path-parameter** binding by `parameterName`
   * (SS-3). `scope_path_bindings` is a `jsonb` collection on the parent row, so
   * this reads the collection, rewrites **only** the matching entry's literal
   * `value` + confirmation via {@link applyScopePathBindingPatch}, and writes the
   * collection back — leaving every sibling scope entry and all operational
   * `resource_binding_ref` rows untouched (SS-3.2). When no entry matches (the
   * `parameterName` is not a derived scope entry of the resource) it writes
   * nothing and returns the binding unchanged; the service rejects that case up
   * front (SS-3.4), so the read-modify-write only runs for a real entry.
   *
   * Returns the updated binding, or `undefined` if no binding with `id` exists.
   */
  public async updateScopePathBinding(
    id: string,
    patch: ScopePathBindingPatch,
  ): Promise<ResourceBinding | undefined> {
    const [row] = await this.db.select().from(resourceBinding).where(eq(resourceBinding.id, id));
    if (row === undefined) {
      return undefined;
    }
    const { rows: nextScopeBindings, matched } = applyScopePathBindingPatch(
      row.scopePathBindings,
      patch,
    );
    if (matched) {
      await this.db
        .update(resourceBinding)
        .set({ scopePathBindings: nextScopeBindings })
        .where(eq(resourceBinding.id, id));
    }
    return this.getById(id);
  }

  /**
   * Confirm/correct the whole `sourceScopeRef` (SS-7). Unlike the six normalized
   * refs and the per-parameter scope bindings, `sourceScopeRef` is **one** ref
   * whose value is the component set, so this replaces the whole `source_scope_ref`
   * `jsonb` column (component set + its single confirmation, `confirmedAt` as
   * ISO-8601) — leaving every operational `resource_binding_ref` row and the
   * `scope_path_bindings` collection untouched. The service validates each
   * component's `fieldPath` against the response schema before calling this.
   *
   * Returns the updated binding, or `undefined` if no binding with `id` exists.
   */
  public async updateSourceScopeRef(
    id: string,
    patch: SourceScopeRefPatch,
  ): Promise<ResourceBinding | undefined> {
    const [row] = await this.db.select().from(resourceBinding).where(eq(resourceBinding.id, id));
    if (row === undefined) {
      return undefined;
    }
    await this.db
      .update(resourceBinding)
      .set({
        sourceScopeRef: {
          components: [...patch.components],
          confirmedBy: patch.confirmedBy,
          confirmedAt: patch.confirmedAt === null ? null : patch.confirmedAt.toISOString(),
        },
      })
      .where(eq(resourceBinding.id, id));
    return this.getById(id);
  }

  /** Read a specific set of bindings by id, preserving the given id order. */
  private async readByIds(ids: string[]): Promise<ResourceBinding[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(resourceBinding)
      .where(inArray(resourceBinding.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
    return this.assemble(ordered);
  }

  /** Attach each parent binding's child ref rows and map to domain. */
  private async assemble(
    rows: readonly (typeof resourceBinding.$inferSelect)[],
  ): Promise<ResourceBinding[]> {
    if (rows.length === 0) {
      return [];
    }
    const refRows = await this.db
      .select()
      .from(resourceBindingRef)
      .where(
        inArray(
          resourceBindingRef.resourceBindingId,
          rows.map((row) => row.id),
        ),
      );
    const refsByBinding = new Map<string, ResourceBindingRefRow[]>();
    for (const refRow of refRows) {
      const bucket = refsByBinding.get(refRow.resourceBindingId);
      if (bucket === undefined) {
        refsByBinding.set(refRow.resourceBindingId, [refRow]);
      } else {
        bucket.push(refRow);
      }
    }
    return rows.map((row) => mapResourceBinding(row, refsByBinding.get(row.id) ?? []));
  }
}
