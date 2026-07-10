import type { ResourceBinding } from "@mediator/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import {
  mapResourceBinding,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ResourceBindingRefPatch,
  type ResourceBindingRefRow,
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
   * Confirm or correct a binding's refs. Each named ref's row is updated in
   * place (per-ref: confirming one leaves the others untouched); a patch entry
   * carrying only confirmation sets `confirmed_by`/`confirmed_at`, one also
   * carrying a `value` corrects the ref in the same action. Returns the updated
   * binding, or `undefined` if no binding with `id` exists.
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
      await this.db
        .update(resourceBindingRef)
        .set(set)
        .where(
          and(eq(resourceBindingRef.resourceBindingId, id), eq(resourceBindingRef.refKind, kind)),
        );
    }
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
