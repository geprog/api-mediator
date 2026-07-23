import {
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  tx,
  type Database,
  type DbHandle,
} from "@mediator/db";
import { stripUndefined, type ApprovedMapping, type AuditLogEntry } from "@mediator/domain";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { ConflictError, NotFoundError } from "../app-errors.js";
import { GraphProjection } from "./graph/index.js";
import type { EndpointCacheInvalidator } from "./persistence.js";

/**
 * **SL-10 — the manual suspend / resume of an `ApprovedMapping`.**
 *
 * A deliberate operator hold, distinct from spec-driven staleness: a `suspended` mapping
 * "stops executing exactly as a `stale` one does (rules pause, bindings fail with the
 * distinct `mapping-suspended` error) but nothing awaits re-review, and the operator lifts
 * it by setting the mapping `active` again" (`docs/architecture/data-model.md`
 * `ApprovedMapping.status`).
 *
 * **`status` is a single enum, not two coexisting markers.** The transitions this service
 * owns are exactly:
 *
 * - **suspend** — `active → suspended` (SL-10.1);
 * - **resume** — `suspended → active` (SL-10.2), the *exact inverse*: only `status` moves,
 *   so the rules/bindings resume under their **stored** state with no re-backfill and no
 *   re-composition.
 *
 * Resume is valid **only** from `suspended`. A mapping the breaking flow additionally
 * marked `stale` while it was suspended (SL-10.5, driven by the Spec Registry — not here)
 * is `stale`, and reaches `active` only through re-review/adoption; resuming it is a
 * `409`. `superseded`/`archived` are equally not resumable.
 *
 * **What suspension does NOT write.** Nothing on the derived artifacts: the mapping's
 * `SyncRule`s keep their own `status` (data-model `SyncRule.status` — "a rule only executes
 * while its `ApprovedMapping` is `active`"; the Scheduler's `decidePoll` holds a
 * suspended-mapping rule) and its `AdapterBinding`s keep theirs (the RP-3 Resolution
 * Planner re-validates mapping health per request and answers `mapping-suspended`). Both
 * pauses are **derived** from the mapping status, exactly as they are for `stale`.
 *
 * **Coupled reactions on commit (SL-10.4)**, mirroring the Spec Registry's stale
 * transition — for **both** directions, since neither a cache entry nor a graph edge may
 * mask a suspended relationship, nor keep showing it paused after a resume:
 *
 * - the affected `AdapterEndpoint`s' cached entries are dropped through the shared
 *   by-endpoint `invalidateEndpoint` seam (XI-2 / CH-5.3 — the same one CO-6 uses); and
 * - the affected `(app pair)` `GraphEdge`s recompute inside the transaction via the GR-2 /
 *   GR-3 seam, so the projection commits atomically with the status flip.
 *
 * Every transition is attributed to the authenticated operator in the audit log
 * (OA-2/OA-3); the route layer rejects a `viewer` with `403` before this service runs.
 */
export class ApprovedMappingSuspensionService {
  readonly #db: Database;
  readonly #newId: () => string;
  readonly #clock: () => Date;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #cacheInvalidator: EndpointCacheInvalidator;
  readonly #graphProjection: GraphProjection | undefined;

  public constructor(deps: {
    readonly db: Database;
    readonly newId: () => string;
    readonly clock?: () => Date;
    readonly readTraceContext?: () => ActiveTraceContext | null;
    /**
     * The shared by-endpoint cache-drop seam (XI-2 / CH-5.3). Absent → invalidate nothing
     * (a service wired without the adapter runtime, e.g. a pure unit test); the real
     * composition root always injects the shared instance.
     */
    readonly cacheInvalidator?: EndpointCacheInvalidator;
    /** The GR-2/GR-3 projection. Absent → no recompute (same rationale as above). */
    readonly graphProjection?: GraphProjection;
  }) {
    this.#db = deps.db;
    this.#newId = deps.newId;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;
    this.#cacheInvalidator = deps.cacheInvalidator ?? { invalidateEndpoint: (): void => {} };
    this.#graphProjection = deps.graphProjection;
  }

  /**
   * **SL-10.1 — suspend an `active` mapping.** Throws `NotFoundError` (unknown mapping) or
   * `ConflictError` (not `active` — a `stale`/`superseded`/`archived`/already-`suspended`
   * mapping is not a hold candidate; suspending must never clobber a more-blocking status).
   */
  public suspend(mappingId: string, actor: string): Promise<ApprovedMapping> {
    return this.#transition(mappingId, actor, "suspend");
  }

  /**
   * **SL-10.2 — resume a `suspended` mapping.** Throws `NotFoundError` (unknown mapping) or
   * `ConflictError` — the mapping is not `suspended` (a suspended-then-`stale` mapping needs
   * re-review, SL-10.5), or another mapping already holds the `active` slot for the same
   * directional spec pair (`approved_mapping_active_direction_uq`).
   */
  public resume(mappingId: string, actor: string): Promise<ApprovedMapping> {
    return this.#transition(mappingId, actor, "resume");
  }

  /**
   * The one transition body, parameterized by direction — suspend and resume are exact
   * inverses, so they share the guard → compare-and-set → audit → graph shape and differ
   * only in the expected prior status and the write. In **one** transaction; the cache drop
   * follows on commit.
   */
  async #transition(
    mappingId: string,
    actor: string,
    action: "suspend" | "resume",
  ): Promise<ApprovedMapping> {
    const expectedFrom: ApprovedMapping["status"] = action === "suspend" ? "active" : "suspended";
    const targetStatus: ApprovedMapping["status"] = action === "suspend" ? "suspended" : "active";

    const { mapping, endpointIds } = await tx(this.#db, async (txn) => {
      const mappings = new ApprovedMappingRepository(txn);
      const existing = await mappings.getById(mappingId);
      if (existing === undefined) {
        throw new NotFoundError(`Approved mapping ${mappingId} not found.`);
      }
      if (existing.status !== expectedFrom) {
        throw new ConflictError(conflictMessage(mappingId, existing.status, action));
      }
      // Resume re-claims the single `active` slot of this directional spec pair (the partial
      // `approved_mapping_active_direction_uq` index). If another mapping took that slot while
      // this one was suspended, report the state conflict rather than let the write fail on the
      // constraint.
      if (action === "resume") {
        const incumbent = await mappings.getActiveByDirectionalSpecPair(
          existing.sourceSpecId,
          existing.targetSpecId,
        );
        if (incumbent !== undefined && incumbent.id !== mappingId) {
          throw new ConflictError(
            `Approved mapping ${mappingId} cannot be resumed: mapping ${incumbent.id} is already the active mapping for the same spec pair.`,
          );
        }
      }

      // Compare-and-set on the expected prior status (the repository's own guard), so a
      // concurrent transition — e.g. the breaking flow marking this mapping `stale` — wins
      // instead of being clobbered.
      const updated =
        action === "suspend"
          ? await mappings.markSuspended(mappingId)
          : await mappings.markActive(mappingId);
      if (updated === undefined) {
        throw new ConflictError(
          `Approved mapping ${mappingId} is no longer ${expectedFrom} — its status changed concurrently; nothing was ${action === "suspend" ? "suspended" : "resumed"}.`,
        );
      }

      // OA-3 — attribute the transition to the authenticated operator.
      await new AuditLogRepository(txn).insert(
        this.#attribution(actor, updated, action, targetStatus),
      );

      // SL-10.4 / GR-2/GR-3 — recompute the affected edge(s) in this same transaction, AFTER
      // the status write, so the aggregate reads the new paused/live state.
      const endpointIds = await this.#reactWithin(txn, updated);
      return { mapping: updated, endpointIds };
    });

    // SL-10.4 / XI-2 / CH-5.3 — drop on every commit (suspend AND resume): a suspended
    // relationship must not be served from cache, and a resumed one must not serve an entry
    // cached under the suspension. Coarse and correctness-safe, outside the transaction, and
    // it must never fail the transition (a missed drop only costs a spurious hit until
    // `cacheTtl`).
    for (const endpointId of endpointIds) {
      invalidateEndpointSafely(this.#cacheInvalidator, endpointId);
    }
    return mapping;
  }

  /**
   * **SL-10.4 — the coupled graph recompute, inside the transaction**, keyed by the
   * mapping's version-agnostic `(sourceApp → targetApp)` pair (consumer = source, backend =
   * target for a consumer-provider mapping). A peer-peer mapping aggregates into the `sync`
   * edge and has no adapter bindings; a consumer-provider mapping aggregates into the
   * `adapter-dependency` edge and owns the endpoints whose cache must be dropped.
   *
   * Returns the distinct `AdapterEndpoint` ids to invalidate on commit (empty for
   * peer-peer). Writes only `graph_edge` rows and no audit row (GR-3.6) — the operator
   * action is audited above.
   */
  async #reactWithin(handle: DbHandle, mapping: ApprovedMapping): Promise<readonly string[]> {
    const projection = this.#graphProjection;
    if (mapping.variant === "peer-peer") {
      if (projection !== undefined) {
        await projection.recomputeSyncEdgeWithin(handle, mapping.sourceAppId, mapping.targetAppId);
      }
      return [];
    }

    if (projection !== undefined) {
      await projection.recomputeAdapterEdgeWithin(handle, mapping.sourceAppId, mapping.targetAppId);
    }
    const bindings = await new DownstreamArtifactRepository(handle).listAdapterBindingsByMapping(
      mapping.id,
    );
    return [...new Set(bindings.map((binding) => binding.adapterEndpointId))];
  }

  /**
   * OA-3 — the audit row for one suspend/resume, attributed to the authenticated operator
   * (never `system`: suspend is always an explicit human action — there is no auto-suspend).
   * Written as a `mapping-decision` entry: the existing audit vocabulary carries no
   * dedicated suspend/resume type, and coining one is a schema migration this slice
   * deliberately avoids — the same discipline SL-2/SL-4's re-pin and stale rows follow. The
   * `decision` column stays unset (its four values are the review vocabulary
   * `accept`/`edit`/`reject`/`approve`, none of which is a hold). `details` is metadata only
   * — the action and the resulting status — never a secret.
   */
  #attribution(
    actor: string,
    mapping: ApprovedMapping,
    action: "suspend" | "resume",
    targetStatus: ApprovedMapping["status"],
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "mapping-decision" as const,
      actor,
      relatedMappingId: mapping.id,
      details:
        action === "suspend"
          ? `approved mapping suspended by operator (status=${targetStatus}); rules pause and adapter bindings fail mapping-suspended`
          : `approved mapping resumed by operator (status=${targetStatus}); rules and adapter bindings resume under their stored state`,
      timestamp: this.#clock(),
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    });
  }
}

/** The 409 message for a transition attempted from a status it does not apply to. */
function conflictMessage(
  mappingId: string,
  status: ApprovedMapping["status"],
  action: "suspend" | "resume",
): string {
  if (action === "suspend") {
    return `Approved mapping ${mappingId} is ${status}; only an active mapping can be suspended.`;
  }
  return status === "stale"
    ? `Approved mapping ${mappingId} is stale: a breaking spec change marked it while it was suspended, so it needs re-review (its successor proposal) to become active again — resume does not apply.`
    : `Approved mapping ${mappingId} is ${status}; only a suspended mapping can be resumed.`;
}

/**
 * XI-2 — the cache drop must never fail the transition it follows (the status change is
 * already committed). Mirrors the Spec Registry's identically-named guard.
 */
function invalidateEndpointSafely(
  cacheInvalidator: EndpointCacheInvalidator,
  endpointId: string,
): void {
  try {
    cacheInvalidator.invalidateEndpoint(endpointId);
  } catch {
    // A missed drop only costs a spurious cache hit until `cacheTtl`; never fail here.
  }
}
