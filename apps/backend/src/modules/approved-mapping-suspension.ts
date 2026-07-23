import type { ReReviewScope } from "@mediator/db";
import {
  stripUndefined,
  type ApiSpec,
  type ApprovedMapping,
  type AuditLogEntry,
} from "@mediator/domain";
import { diffSpec } from "@mediator/ir";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { ConflictError, NotFoundError } from "../app-errors.js";
import type { EndpointCacheInvalidator, TxStores, UnitOfWork } from "./persistence.js";
import {
  classifyMappingAgainstBreaking,
  computeBreakingAffectedKeys,
  repinAuditEntry,
  staleAuditEntry,
} from "./spec-registry.js";

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
 * owns are exactly **suspend** (`active → suspended`, SL-10.1) and **resume**
 * (`suspended → active`, SL-10.2). Resume is valid only from `suspended`.
 *
 * ## A hold defers the spec-update lifecycle; it never exempts the mapping from it
 *
 * Re-pinning is defined for `active` mappings only (`docs/architecture/data-model.md`
 * `ApprovedMapping.sourceSpecId`), so a spec version that advances **during** a hold leaves
 * the suspended mapping pinned to the now-`superseded` version. Resuming it blindly would
 * produce an `active` mapping pinned to a superseded spec — violating that same field's
 * invariant ("an `active` mapping always points at the currently active `ApiSpec` version")
 * and permanently detaching it from the lifecycle, since every later advance looks its
 * mappings up by exact spec id and would never find it again. Neither engine backstops that:
 * the sync resolution loads the spec + `ResourceBinding`s by the mapping's pinned id with no
 * status check, so the rule would poll and write a shape the app no longer serves.
 *
 * So **resume catches the mapping up through the reactions it missed**, by diffing the
 * pinned IR against the currently-active IR of the same lineage ({@link diffSpec} — pinned →
 * current directly, so a hold spanning *several* advances is resolved in one comparison):
 *
 * - **nothing the mapping references broke** (every intervening change additive, or breaking
 *   but untouching its refs) → **re-pin** both sides to the current active versions and
 *   resume `active`, writing the same `system`-attributed re-pin audit row SL-2 would have
 *   written. Exactly what SL-2 would have done had the mapping been active.
 * - **something it references broke** → apply the SL-4 reaction (`markStale`, its audit row)
 *   and record the SL-6 scoped re-review job that produces the successor proposal, then
 *   **reject** the resume: the mapping is `stale` and reaches `active` only through
 *   re-review.  Exactly what SL-4/SL-6 would have done had the mapping been active.
 *
 * The per-mapping verdict is {@link classifyMappingAgainstBreaking} — the **same** function
 * the Spec Registry's breaking reaction uses, so a mapping held through an advance is
 * classified by an identical rule to one that was active for it.
 *
 * ## What suspension does NOT write
 *
 * Nothing on the derived artifacts: the mapping's `SyncRule`s keep their own `status`
 * (data-model `SyncRule.status` — "a rule only executes while its `ApprovedMapping` is
 * `active`"; the Scheduler's `decidePoll` holds a suspended-mapping rule) and its
 * `AdapterBinding`s keep theirs (the RP-3 Resolution Planner re-validates mapping health per
 * request and answers `mapping-suspended`). Both pauses are **derived**, exactly as for
 * `stale`.
 *
 * ## Coupled reactions (SL-10.4)
 *
 * Mirroring the Spec Registry's stale transition, for **both** directions — neither a cache
 * entry nor a graph edge may mask a suspended relationship, nor keep showing it paused after
 * a resume: the affected `(app pair)` `GraphEdge`s recompute **inside** the transaction (GR-2
 * / GR-3, so the projection commits atomically with the status flip), and the affected
 * `AdapterEndpoint`s' cached entries are dropped through the shared by-endpoint
 * `invalidateEndpoint` seam **after commit** (XI-2 / CH-5.3). A rejected resume that marked
 * the mapping `stale` reacts too — that transition is just as real.
 *
 * Every transition is attributed to the authenticated operator in the audit log
 * (OA-2/OA-3); the route layer rejects a `viewer` with `403` before this service runs.
 */
export class ApprovedMappingSuspensionService {
  readonly #unitOfWork: UnitOfWork;
  readonly #newId: () => string;
  readonly #clock: () => Date;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #cacheInvalidator: EndpointCacheInvalidator;

  public constructor(deps: {
    /**
     * The transactional store seam (the same one the Spec Registry runs on), so the whole
     * transition — guard, catch-up, status write, audit, graph recompute — commits or rolls
     * back as one, and the logic is unit-testable against the in-memory `FakeUnitOfWork`.
     */
    readonly unitOfWork: UnitOfWork;
    readonly newId: () => string;
    readonly clock?: () => Date;
    readonly readTraceContext?: () => ActiveTraceContext | null;
    /**
     * The shared by-endpoint cache-drop seam (XI-2 / CH-5.3), driven **after** commit.
     * Absent → invalidate nothing (a service wired without the adapter runtime); the real
     * composition root always injects the shared instance.
     */
    readonly cacheInvalidator?: EndpointCacheInvalidator;
  }) {
    this.#unitOfWork = deps.unitOfWork;
    this.#newId = deps.newId;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#readTraceContext = deps.readTraceContext ?? getActiveTraceContext;
    this.#cacheInvalidator = deps.cacheInvalidator ?? { invalidateEndpoint: (): void => {} };
  }

  /**
   * **SL-10.1 — suspend an `active` mapping.** Throws `NotFoundError` (unknown mapping) or
   * `ConflictError` (not `active` — a `stale`/`superseded`/`archived`/already-`suspended`
   * mapping is not a hold candidate; suspending must never clobber a more-blocking status).
   */
  public async suspend(mappingId: string, actor: string): Promise<ApprovedMapping> {
    const committed = await this.#unitOfWork.run(async (tx) => {
      await this.#loadForTransition(tx, mappingId, "active", "suspend");
      const updated = await tx.approvedMappings.markSuspended(mappingId);
      if (updated === undefined) {
        throw new ConflictError(concurrentMessage(mappingId, "active", "suspend"));
      }
      await tx.audit.insert(this.#attribution(actor, updated, "suspend"));
      const endpointIds = await reactWithin(tx, updated);
      return { mapping: updated, endpointIds };
    });
    this.#dropCaches(committed.endpointIds);
    return committed.mapping;
  }

  /**
   * **SL-10.2 — resume a `suspended` mapping**, catching it up through any spec advance its
   * hold spanned (see the class doc). Throws `NotFoundError` (unknown mapping) or
   * `ConflictError` — the mapping is not `suspended`; another mapping took the `active` slot
   * of its directional spec pair; or a spec it references broke during the hold, in which
   * case it is left **`stale`** (committed, with its re-review job) and re-review is required.
   */
  public async resume(mappingId: string, actor: string): Promise<ApprovedMapping> {
    // The breaking outcome must COMMIT (the mapping really is stale now) and still reject the
    // resume, so the transaction returns a verdict rather than throwing from inside it.
    const committed = await this.#unitOfWork.run(async (tx) => {
      const existing = await this.#loadForTransition(tx, mappingId, "suspended", "resume");
      const catchUp = await this.#catchUpPins(tx, existing);

      if (catchUp.kind === "broke-during-hold") {
        // SL-4 + SL-6, verbatim: mark stale, audit it, and record the scoped re-review job
        // that produces the successor proposal. The mapping STAYS pinned to the version it
        // was reviewed against (SL-4.3) — no re-pin on this path.
        const staled = await tx.approvedMappings.markStale(mappingId);
        if (staled === undefined) {
          throw new ConflictError(concurrentMessage(mappingId, "suspended", "resume"));
        }
        await tx.audit.insert(
          staleAuditEntry(existing, catchUp.pinned, catchUp.current, this.#clock()),
        );
        await tx.audit.insert(this.#attribution(actor, staled, "resume-rejected-stale"));
        await tx.detectionJobs.enqueueScoped(catchUp.current.id, catchUp.scope);
        const endpointIds = await reactWithin(tx, staled);
        return { kind: "broke-during-hold" as const, mapping: staled, endpointIds };
      }

      // SL-2, verbatim: re-pin each side that fell behind + its audit row, so the resumed
      // mapping points at the currently active versions.
      for (const repin of catchUp.repins) {
        await tx.audit.insert(
          repinAuditEntry(existing, repin.pinned, repin.current, this.#clock()),
        );
      }
      if (catchUp.repins.length > 0) {
        await tx.approvedMappings.repinSpecs(mappingId, catchUp.sourceSpecId, catchUp.targetSpecId);
      }

      // Resume re-claims the single `active` slot of this directional spec pair — checked
      // against the RE-PINNED pair, which is the pair the unique index will see.
      const incumbent = await tx.approvedMappings.getActiveByDirectionalSpecPair(
        catchUp.sourceSpecId,
        catchUp.targetSpecId,
      );
      if (incumbent !== undefined && incumbent.id !== mappingId) {
        throw new ConflictError(incumbentMessage(mappingId, incumbent.id));
      }

      const updated = await this.#markActiveOrConflict(tx, mappingId);
      await tx.audit.insert(this.#attribution(actor, updated, "resume"));
      const endpointIds = await reactWithin(tx, updated);
      return { kind: "resumed" as const, mapping: updated, endpointIds };
    });

    // Both outcomes changed the mapping's execution state, so both drop the cache.
    this.#dropCaches(committed.endpointIds);
    if (committed.kind === "broke-during-hold") {
      throw new ConflictError(brokeDuringHoldMessage(mappingId));
    }
    return committed.mapping;
  }

  /** Load the mapping and assert it is in the status the transition applies from. */
  async #loadForTransition(
    tx: TxStores,
    mappingId: string,
    expectedFrom: ApprovedMapping["status"],
    action: "suspend" | "resume",
  ): Promise<ApprovedMapping> {
    const existing = await tx.approvedMappings.getById(mappingId);
    if (existing === undefined) {
      throw new NotFoundError(`Approved mapping ${mappingId} not found.`);
    }
    if (existing.status !== expectedFrom) {
      throw new ConflictError(conflictMessage(mappingId, existing.status, action));
    }
    return existing;
  }

  /**
   * The compare-and-set resume write. A `23505` on `approved_mapping_active_direction_uq`
   * means another mapping claimed the pair's `active` slot between the pre-check and this
   * write (the approval service inserts a new active row for a pair whose only mapping is
   * suspended) — a **state conflict**, not a server fault, so it surfaces as `409` rather
   * than an unmapped constraint violation → `500`.
   */
  async #markActiveOrConflict(tx: TxStores, mappingId: string): Promise<ApprovedMapping> {
    let updated: ApprovedMapping | undefined;
    try {
      updated = await tx.approvedMappings.markActive(mappingId);
    } catch (error) {
      if (isActiveDirectionUniqueViolation(error)) {
        throw new ConflictError(
          `Approved mapping ${mappingId} cannot be resumed: another mapping concurrently became the active mapping for the same spec pair.`,
        );
      }
      throw error;
    }
    if (updated === undefined) {
      throw new ConflictError(concurrentMessage(mappingId, "suspended", "resume"));
    }
    return updated;
  }

  /**
   * **SL-10.2 — the pin catch-up.** For each side whose pinned `ApiSpec` is no longer
   * `active`, resolve that lineage's currently-active version (`app + role`) and diff the
   * pinned IR against it. Diffing **pinned → current directly** collapses any number of
   * intervening advances into one comparison, so a long hold needs no lineage walk.
   *
   * A breaking diff only matters if *this mapping* references something it invalidated — the
   * same precision SL-4.1 applies ("mark ONLY the mappings that reference a changed
   * element"), via the shared {@link classifyMappingAgainstBreaking}.
   */
  async #catchUpPins(tx: TxStores, mapping: ApprovedMapping): Promise<PinCatchUp> {
    const fields = await tx.mappingArtifacts.listFieldMappings(mapping.id);
    const operations = await tx.mappingArtifacts.listOperationMappings(mapping.id);

    let sourceSpecId = mapping.sourceSpecId;
    let targetSpecId = mapping.targetSpecId;
    const repins: { pinned: ApiSpec; current: ApiSpec }[] = [];

    // De-duplicated: a self-pair (both sides the same spec row) is diffed once.
    const pinnedIds = [...new Set([mapping.sourceSpecId, mapping.targetSpecId])];
    for (const pinnedId of pinnedIds) {
      const pinned = await tx.apiSpecs.getById(pinnedId);
      if (pinned === undefined) {
        // FK-guaranteed not to happen; fail as a conflict rather than resume onto nothing.
        throw new ConflictError(
          `Approved mapping ${mapping.id} cannot be resumed: its pinned spec ${pinnedId} no longer exists.`,
        );
      }
      if (pinned.status === "active") {
        continue; // This side never fell behind.
      }
      const current = await tx.apiSpecs.findActiveByAppAndRole(pinned.appId, pinned.role);
      if (current === undefined) {
        throw new ConflictError(
          `Approved mapping ${mapping.id} cannot be resumed: its ${pinned.role} spec lineage has no active version (the app was deregistered or its spec withdrawn).`,
        );
      }

      const diff = diffSpec(pinned.parsedIR, current.parsedIR);
      if (diff.classification === "breaking") {
        const verdict = classifyMappingAgainstBreaking(
          mapping,
          pinned.id,
          fields,
          operations,
          computeBreakingAffectedKeys(diff),
        );
        if (verdict.staled) {
          return {
            kind: "broke-during-hold",
            pinned,
            current,
            scope: {
              kind: "re-review",
              supersededSpecId: pinned.id,
              staleMappings: [
                { staleMappingId: mapping.id, affectedPairs: [...verdict.affectedPairs] },
              ],
            },
          };
        }
      }
      // Additive, or breaking but touching nothing this mapping references → advance it.
      if (mapping.sourceSpecId === pinnedId) sourceSpecId = current.id;
      if (mapping.targetSpecId === pinnedId) targetSpecId = current.id;
      repins.push({ pinned, current });
    }

    return { kind: "caught-up", sourceSpecId, targetSpecId, repins };
  }

  /** XI-2 — drop each affected endpoint's cache after commit; never fail the transition. */
  #dropCaches(endpointIds: readonly string[]): void {
    for (const endpointId of endpointIds) {
      try {
        this.#cacheInvalidator.invalidateEndpoint(endpointId);
      } catch {
        // A missed drop only costs a spurious cache hit until `cacheTtl`; never fail here.
      }
    }
  }

  /**
   * OA-3 — the audit row for one transition, attributed to the authenticated operator (never
   * `system`: suspend is always an explicit human action — there is no auto-suspend). Written
   * as a `mapping-decision` entry: the existing audit vocabulary carries no dedicated
   * suspend/resume type, and coining one is a schema migration this slice deliberately avoids
   * — the same discipline SL-2/SL-4's re-pin and stale rows follow. The `decision` column
   * stays unset (its four values are the review vocabulary, none of which is a hold).
   * `details` is metadata only — the action and its outcome — never a secret.
   */
  #attribution(
    actor: string,
    mapping: ApprovedMapping,
    action: "suspend" | "resume" | "resume-rejected-stale",
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "mapping-decision" as const,
      actor,
      relatedMappingId: mapping.id,
      details: attributionDetails(action, mapping.status),
      timestamp: this.#clock(),
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    });
  }
}

/** The outcome of the SL-10.2 pin catch-up. */
type PinCatchUp =
  | {
      readonly kind: "caught-up";
      /** The spec pair to resume onto (re-pinned where a side fell behind). */
      readonly sourceSpecId: string;
      readonly targetSpecId: string;
      /** One entry per side actually advanced — each gets SL-2's re-pin audit row. */
      readonly repins: readonly { readonly pinned: ApiSpec; readonly current: ApiSpec }[];
    }
  | {
      readonly kind: "broke-during-hold";
      readonly pinned: ApiSpec;
      readonly current: ApiSpec;
      readonly scope: ReReviewScope;
    };

/**
 * **SL-10.4 — the coupled graph recompute, inside the transaction**, keyed by the mapping's
 * version-agnostic `(sourceApp → targetApp)` pair (consumer = source, backend = target for a
 * consumer-provider mapping). A peer-peer mapping aggregates into the `sync` edge and has no
 * adapter bindings; a consumer-provider mapping aggregates into the `adapter-dependency` edge
 * and owns the endpoints whose cache must be dropped.
 *
 * Returns the distinct `AdapterEndpoint` ids to invalidate on commit (empty for peer-peer).
 * Writes only `graph_edge` rows and no audit row (GR-3.6) — the operator action is audited by
 * its own row.
 */
async function reactWithin(tx: TxStores, mapping: ApprovedMapping): Promise<readonly string[]> {
  if (mapping.variant === "peer-peer") {
    await tx.graph.recomputeSyncEdge(mapping.sourceAppId, mapping.targetAppId);
    return [];
  }
  await tx.graph.recomputeAdapterEdge(mapping.sourceAppId, mapping.targetAppId);
  const bindings = await tx.downstreamArtifacts.listAdapterBindingsByMapping(mapping.id);
  return [...new Set(bindings.map((binding) => binding.adapterEndpointId))];
}

/** The audit `details` for one transition — metadata only. */
function attributionDetails(
  action: "suspend" | "resume" | "resume-rejected-stale",
  status: ApprovedMapping["status"],
): string {
  switch (action) {
    case "suspend":
      return `approved mapping suspended by operator (status=${status}); rules pause and adapter bindings fail mapping-suspended`;
    case "resume":
      return `approved mapping resumed by operator (status=${status}); rules and adapter bindings resume under their stored state`;
    case "resume-rejected-stale":
      return `resume rejected by operator request (status=${status}): a breaking spec change landed during the hold, so the mapping was marked stale and awaits re-review`;
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
    ? `Approved mapping ${mappingId} is stale: a breaking spec change invalidated it, so it needs re-review (its successor proposal) to become active again — resume does not apply.`
    : `Approved mapping ${mappingId} is ${status}; only a suspended mapping can be resumed.`;
}

/** The 409 message when the compare-and-set found the row already moved on. */
function concurrentMessage(
  mappingId: string,
  expectedFrom: ApprovedMapping["status"],
  action: "suspend" | "resume",
): string {
  return `Approved mapping ${mappingId} is no longer ${expectedFrom} — its status changed concurrently; nothing was ${action === "suspend" ? "suspended" : "resumed"}.`;
}

/** The 409 message when another mapping holds the pair's single `active` slot. */
function incumbentMessage(mappingId: string, incumbentId: string): string {
  return `Approved mapping ${mappingId} cannot be resumed: mapping ${incumbentId} is already the active mapping for the same spec pair.`;
}

/** The 409 message for a resume refused because the spec broke during the hold. */
function brokeDuringHoldMessage(mappingId: string): string {
  return `Approved mapping ${mappingId} was not resumed: a breaking spec change landed while it was suspended, so it has been marked stale and needs re-review (its successor proposal) to become active again.`;
}

/**
 * Is `error` a Postgres unique violation (SQLSTATE `23505`) on the partial
 * `approved_mapping_active_direction_uq` index? Narrowed from `unknown` by shape — the pg
 * driver's error carries `code` and `constraint` as own string properties.
 */
function isActiveDirectionUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if (!("code" in error) || !("constraint" in error)) {
    return false;
  }
  return error.code === "23505" && error.constraint === "approved_mapping_active_direction_uq";
}
