import type {
  AcknowledgedIgnoredInput,
  AdapterBinding,
  AdapterBindingRole,
  AdapterEndpoint,
  AggregationStrategy,
  ChainInput,
  EndpointStrictness,
  PostMergeDedup,
  PostMergeFilter,
  PostMergePagination,
  PostMergeSort,
} from "@mediator/domain";
import { and, eq } from "drizzle-orm";

import type { DbHandle } from "../client.js";
import { mapAdapterBindingRow } from "../mappers/adapter-binding.js";
import { mapAdapterEndpointRow, toPostMergePaginationRow } from "../mappers/adapter-endpoint.js";
import { adapterBinding, adapterEndpoint } from "../schema.js";

/**
 * Persistence for **endpoint composition** (Phase-5 CO-2). Constructor-bound to a
 * {@link DbHandle} (the pooled db or a `tx()` transaction) like every repo, so the
 * composition service can run {@link AdapterCompositionRepository.applyComposition}
 * and its OA-3 audit insert inside **one** transaction — the boundary that makes
 * activation atomic (CO-2.8): on any failure the whole tx rolls back, leaving the
 * endpoint's previous active configuration untouched and still serving.
 */

/** The endpoint-level serving configuration a composition activates (CO-2.1 / CO-3). */
export interface CompositionEndpointConfig {
  readonly aggregationStrategy: AggregationStrategy;
  readonly strictness: EndpointStrictness;
  /** `null` = no caching (the documented default); a positive number sets the TTL (ms). */
  readonly cacheTtl: number | null;
  /**
   * The composer's acknowledged-ignored consumer inputs (CO-5.4); `null` = none
   * (every unmapped input rejects at request validation — the fail-loud default). A
   * full overwrite of the column, like every other composition field.
   */
  readonly acknowledgedIgnoredInputs: readonly AcknowledgedIgnoredInput[] | null;
  /**
   * CO-3 `collection-union` post-merge configuration. `null` on every field for any
   * non-union strategy — a full overwrite (never a partial patch), so recomposing a
   * union into a non-union clears the stale union config (and vice versa). The domain
   * refinement forbids these on a non-union endpoint, so the service passes `null`
   * there; only a real union carries values.
   */
  readonly postMergeDedup: PostMergeDedup | null;
  readonly postMergeFilters: readonly PostMergeFilter[] | null;
  readonly postMergeSorts: readonly PostMergeSort[] | null;
  readonly postMergePagination: PostMergePagination | null;
}

/**
 * One binding's activated composition state. Every field is explicit — `null` writes the
 * column NULL (an unchained binding, no order override), a value sets it — so activation
 * is a full overwrite of the composition columns rather than a partial patch.
 */
export interface CompositionBindingConfig {
  readonly bindingId: string;
  readonly role: AdapterBindingRole;
  readonly executionOrder: number | null;
  readonly dependsOnBindingId: string | null;
  readonly chainInputs: readonly ChainInput[] | null;
}

/** The full activation payload for one `composition-required` endpoint. */
export interface ApplyCompositionInput {
  readonly endpointId: string;
  readonly endpoint: CompositionEndpointConfig;
  readonly bindings: readonly CompositionBindingConfig[];
}

/**
 * The result of {@link AdapterCompositionRepository.applyComposition}: `applied: true`
 * with the resulting rows, or `applied: false` when the endpoint was no longer
 * `composition-required` at write time (a concurrent transition) — in which case
 * **nothing** was written, so the caller maps it to a state conflict without any
 * rollback of live state.
 */
export type ApplyCompositionResult =
  | {
      readonly applied: true;
      readonly endpoint: AdapterEndpoint;
      readonly bindings: readonly AdapterBinding[];
    }
  | { readonly applied: false };

export class AdapterCompositionRepository {
  public constructor(private readonly db: DbHandle) {}

  /** The `AdapterEndpoint` by id, or `undefined` — the composition target load. */
  public async getEndpointById(id: string): Promise<AdapterEndpoint | undefined> {
    const [row] = await this.db.select().from(adapterEndpoint).where(eq(adapterEndpoint.id, id));
    return row === undefined ? undefined : mapAdapterEndpointRow(row);
  }

  /** Every `AdapterBinding` of an endpoint, in any status — the composable set (CO-2). */
  public async listBindings(endpointId: string): Promise<AdapterBinding[]> {
    const rows = await this.db
      .select()
      .from(adapterBinding)
      .where(eq(adapterBinding.adapterEndpointId, endpointId));
    return rows.map(mapAdapterBindingRow);
  }

  /**
   * Activate a validated composition atomically (CO-2.8). The endpoint UPDATE is guarded
   * on `status = 'composition-required'` — the only state a first composition applies to
   * — so a concurrent transition makes it a no-op (0 rows → `{ applied: false }`, no
   * writes). Each binding is then set `active` with its composed role/order/chaining,
   * scoped to this endpoint; a binding UPDATE that matches no row is an invariant
   * violation (the caller validated coverage first) and **throws**, rolling the whole
   * transaction back so activation is never half-applied.
   *
   * Bound to a transaction handle by the service, so the endpoint promotion, every
   * binding promotion, and the OA-3 audit insert commit together or not at all.
   */
  public async applyComposition(input: ApplyCompositionInput): Promise<ApplyCompositionResult> {
    const updatedEndpoints = await this.db
      .update(adapterEndpoint)
      .set({
        status: "active",
        aggregationStrategy: input.endpoint.aggregationStrategy,
        strictness: input.endpoint.strictness,
        cacheTtl: input.endpoint.cacheTtl,
        acknowledgedIgnoredInputs:
          input.endpoint.acknowledgedIgnoredInputs === null
            ? null
            : [...input.endpoint.acknowledgedIgnoredInputs],
        // CO-3 — the union post-merge config, a full overwrite. `postMergePagination`'s
        // `Date` `confirmedAt` is serialized to the ISO-8601 `jsonb` row form; the other
        // three columns are JSON-safe. `null` clears the column (non-union endpoints).
        postMergeDedup: input.endpoint.postMergeDedup,
        postMergeFilters:
          input.endpoint.postMergeFilters === null ? null : [...input.endpoint.postMergeFilters],
        postMergeSorts:
          input.endpoint.postMergeSorts === null ? null : [...input.endpoint.postMergeSorts],
        postMergePagination:
          input.endpoint.postMergePagination === null
            ? null
            : toPostMergePaginationRow(input.endpoint.postMergePagination),
      })
      .where(
        and(
          eq(adapterEndpoint.id, input.endpointId),
          eq(adapterEndpoint.status, "composition-required"),
        ),
      )
      .returning();
    const [endpointRow] = updatedEndpoints;
    if (endpointRow === undefined) {
      // Not composition-required at write time — nothing written, no live state disturbed.
      return { applied: false };
    }

    for (const binding of input.bindings) {
      const updatedBindings = await this.db
        .update(adapterBinding)
        .set({
          status: "active",
          role: binding.role,
          executionOrder: binding.executionOrder,
          dependsOnBindingId: binding.dependsOnBindingId,
          chainInputs: binding.chainInputs === null ? null : [...binding.chainInputs],
        })
        .where(
          and(
            eq(adapterBinding.id, binding.bindingId),
            eq(adapterBinding.adapterEndpointId, input.endpointId),
          ),
        )
        .returning();
      if (updatedBindings.length === 0) {
        throw new Error(
          `adapter_binding ${binding.bindingId} is not a binding of endpoint ${input.endpointId}; composition rolled back`,
        );
      }
    }

    const bindings = await this.listBindings(input.endpointId);
    return { applied: true, endpoint: mapAdapterEndpointRow(endpointRow), bindings };
  }
}
