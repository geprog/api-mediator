import { stripUndefined, type AuditLogEntry, type RegisteredApp } from "@mediator/domain";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { BadRequestError, ConflictError, NotFoundError } from "../app-errors.js";
import type { EndpointCacheInvalidator, TxStores, UnitOfWork } from "./persistence.js";

/**
 * **AL-1 — take a `RegisteredApp` out of service (reversibly) and put it back.**
 *
 * Disable is a **derived, execution-time condition on the app**, exactly analogous to
 * mapping staleness/suspension living on the `ApprovedMapping` alone: "every `SyncRule`
 * where the app is source or target stops executing, and its `AdapterBinding`s stop being
 * called … A disabled app is simply no longer polled. Like mapping staleness, the pause
 * touches no rule's own `status` — being disabled is a condition of the *app*, derived at
 * execution time, not stored per rule. Re-enabling simply lifts that condition: rules
 * resume under their stored `status`, and polling resumes from stored cursors/snapshots,
 * so no separate re-backfill is needed" (`docs/architecture/extensibility.md` *App
 * lifecycle: disable & deregister*).
 *
 * ## What this service writes — and what it must never write
 *
 * It moves **one column**: `RegisteredApp.status` (`active ↔ disabled`, the enum the
 * schema already carries). It writes **no** `SyncRule.status`, **no** `cursor`,
 * `lastSnapshotRef` or `backfillStatus`, **no** `AdapterBinding.status`, and **no**
 * `ApprovedMapping.status`. That is what makes re-enable free: there is nothing to
 * restore, so AL-1.3's "no separate re-backfill" is a property of the design rather than
 * a step in the enable path.
 *
 * ## Where the condition is actually read (AL-1.1/1.2/1.6)
 *
 * - **Sync** — `SyncRuleRepository.listPollCandidates` joins **both** apps' live status
 *   on every tick and `pollPauseConditions`/`decidePoll` hold the rule with the distinct
 *   `app-disabled` reason. Because the join is live, the very next tick after this
 *   transaction commits already sees the change — there is no per-rule state to migrate.
 * - **Adapter** — the request-time Resolution Planner (`validateBindingHealth`, RP-3.5)
 *   re-reads the backing app's status per request and eliminates the binding with the
 *   distinct `backend-disabled` cause, which then follows the endpoint's **normal**
 *   role/strictness semantics (a `supplement` may degrade the response; a `primary` or a
 *   load-bearing supplement fails the request) — no special-casing (AL-1.2).
 * - **Composition (AL-1.6)** — both gates evaluate the app condition *alongside* the
 *   mapping conditions rather than instead of them, so a rule paused by an app disable
 *   **and** a `stale`/`suspended` mapping resumes only when **all** of them clear.
 *
 * ## Coupled reactions on commit (AL-1.5)
 *
 * Mirroring `ApprovedMappingSuspensionService`, and for both directions:
 *
 * - the affected `GraphEdge`s **recompute inside the transaction** (GR-2/GR-3), so the
 *   projection commits atomically with the status flip and no edge keeps showing a live
 *   dependency on an app that is out of service — while the app itself **remains a node**
 *   (disable never removes one — GR-5.4); and
 * - the endpoints backed by this app have their cached entries dropped through the shared
 *   by-endpoint `invalidateEndpoint` seam **after commit** (XI-2.2 / CH-5.3), so a
 *   response cached while the binding was healthy is not served past the disable.
 *
 * Every transition is attributed to the authenticated operator in the audit log
 * (AL-1.4/OA-3); the route layer rejects a `viewer` with `403` before this service runs.
 */
export class AppLifecycleService {
  readonly #unitOfWork: UnitOfWork;
  readonly #newId: () => string;
  readonly #clock: () => Date;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #cacheInvalidator: EndpointCacheInvalidator;

  public constructor(deps: {
    /**
     * The transactional store seam (the same one the Spec Registry and the SL-10
     * suspension service run on), so the whole transition — guard, status write, audit,
     * graph recompute — commits or rolls back as one, and the transition logic is
     * unit-testable against the in-memory `FakeUnitOfWork`.
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
   * **AL-1.1 — disable an `active` app.** Throws `NotFoundError` (unknown app) or
   * `ConflictError` (the app is already `disabled`). Nothing but `RegisteredApp.status`
   * is written: the rules it is source or target of keep their own `status`, cursors and
   * snapshots, and simply stop being polled while the condition stands.
   */
  public disable(appId: string, actor: string): Promise<RegisteredApp> {
    return this.#transition(appId, actor, "disable");
  }

  /**
   * **AL-1.3 — re-enable a `disabled` app.** Throws `NotFoundError` (unknown app) or
   * `ConflictError` (the app is already `active`). This **lifts the condition and
   * restores nothing**: rules resume under their stored `status` and poll on from their
   * stored cursors/snapshots, so no re-backfill is performed and no re-approval needed.
   */
  public enable(appId: string, actor: string): Promise<RegisteredApp> {
    return this.#transition(appId, actor, "enable");
  }

  /**
   * **AL-2 — deregister an app (destructive, confirmed) and run the whole cascade.**
   *
   * `confirmation` must equal the app's own `name` (AL-2.1): deregister "requires
   * explicit confirmation before it proceeds — deregister is destructive, unlike the
   * reversible disable" (`docs/architecture/extensibility.md` *App lifecycle*). Typing
   * the target's name is the mechanism (README open question 5 leaves it open), and it is
   * enforced **here**, in the service that owns the invariant — not only in the route — so
   * a bare/absent/wrong confirmation can never reach the cascade whatever calls it.
   * Rejects with `BadRequestError`; nothing is written.
   *
   * ## The cascade, in one transaction (a partial cascade is far worse than a slow one)
   *
   * Ordered so every FK-referencing row goes before what it references, and so the graph
   * recompute at the end sees the *post*-cascade aggregate:
   *
   * 1. **AL-2.3** the app's own `AdapterEndpoint`s (it registered a `CONSUMER` spec) are
   *    **deleted**, their bindings + write outcomes cascading with them — its adapter
   *    server is torn down and callers hit **nothing**, not `not-yet-mapped`;
   * 2. **AL-2.2** every `AdapterBinding` the app **backs** on other consumers' endpoints
   *    is **deleted**, and any endpoint left with **no** bindings reverts to serving
   *    `not-yet-mapped` (RT-3.1) — additionally flagged `composition-required` so it reads
   *    as awaiting a backend rather than as a live configuration backed by nothing;
   * 3. **AL-2.2** every `SyncRule` of every mapping naming the app is **deleted** (its
   *    snapshots/scope state cascade);
   * 4. **AL-2.4** every `ApprovedMapping` naming the app is **archived** — retained for
   *    audit, never executed again — and every `counterpartMappingId` *pointing at* one of
   *    them is **cleared**; the app's `ApiSpec`s are **archived** the same way (the
   *    archived mappings still pin them, so they stay resolvable for audit);
   * 5. **AL-2.5** its `RecordLink`s and their `SyncFieldState` are **archived** —
   *    deliberately **not** tombstoned, since no record was deleted (contrast `Tombstone`
   *    in `docs/glossary.md`) — and each scoped pair's `ScopeLink`s are archived through
   *    the existing SS-10.5 `archiveByCorrespondence` sweep;
   * 6. **AL-2.6** its `Credential`s are **deleted outright** (never archived),
   *    `adapterToken` included — which is exactly how the adapter token is revoked with
   *    the app (AT-4.5) — while the audit log keeps every historical event;
   * 7. the `RegisteredApp` row itself is **retained** and moved to `disabled` — see
   *    {@link deregister} note below;
   * 8. **AL-2.7** every `GraphEdge` incident to the app is recomputed: its aggregate is
   *    now empty, so GR-1.2 **removes** it. Endpoint caches are dropped **after** commit.
   *
   * ## Why the `RegisteredApp` row is retained rather than deleted
   *
   * `extensibility.md`'s cascade enumerates what is deleted (rules, bindings, a consumer's
   * endpoints, credentials) and what is archived; the app row is in neither list. It
   * **cannot** be deleted: AL-2.4 requires the app's `ApiSpec`s and `ApprovedMapping`s to
   * survive as archived audit records, and both carry `NOT NULL` foreign keys to
   * `registered_app` with no cascade — deleting the app would have to delete exactly the
   * history the criterion retains. `registered_app_status` carries no `archived` value and
   * Phase 6 coins no new status, so the row is moved to the one non-`active` status the
   * enum has: `disabled`. That is also the status every derived gate already reads — the
   * poll-candidate join, `validateBindingHealth` (RP-3.5), `listMountableConsumerApps`
   * (RT-4.2), and adapter-token validation, which rejects "a non-`active` app's tokens"
   * (`docs/architecture/data-model.md` `Credential.validUntil`) — so the departed app
   * fails **closed** on every path even if some artifact escaped the cascade.
   *
   * The residue is that this slice cannot make the app disappear from the *node* set
   * AL-2.7/GR-5.4 also ask for: nodes are `RegisteredApp` rows and the row must survive.
   * All of the app's **edges** are removed here; excluding a deregistered app from
   * `GraphService.getGraph`'s nodes needs a durable marker this schema cannot express
   * without a migration, and GR-5's read does not exist yet.
   *
   * Every effect is attributed to the authenticated operator with a **cascade summary**
   * in the audit log (AL-2.8/OA-3); the route layer rejects a `viewer` with `403` before
   * this service runs.
   */
  public async deregister(
    appId: string,
    actor: string,
    confirmation: string,
  ): Promise<AppDeregistration> {
    const committed = await this.#unitOfWork.run(async (tx) => {
      const app = await tx.registeredApps.getById(appId);
      if (app === undefined) {
        throw new NotFoundError(`RegisteredApp ${appId} not found.`);
      }
      // AL-2.1 — the destructive-action gate, before a single row is touched.
      if (confirmation !== app.name) {
        throw new BadRequestError(
          `Deregistering RegisteredApp ${appId} requires confirmation: repeat the app's exact name in "confirm".`,
        );
      }

      const cascade = await runDeregisterCascade(tx, appId);

      // The row is retained (archived mappings/specs pin it) and moved out of service.
      // `markDisabled` is the compare-and-set from `active`; an already-`disabled` app
      // (disabled first, then deregistered — or a concurrent disable) is already in the
      // target state, so the read-back is the committed row either way.
      const updated =
        app.status === "active" ? await tx.registeredApps.markDisabled(appId) : undefined;
      const finalApp = updated ?? (await tx.registeredApps.getById(appId));
      if (finalApp === undefined) {
        throw new ConflictError(`RegisteredApp ${appId} disappeared during deregistration.`);
      }

      // AL-2.7 — every incident edge's aggregate is empty now that the rules/bindings are
      // deleted, so each recompute REMOVES its edge (GR-1.2). Inside the transaction, so
      // no edge survives a rolled-back cascade.
      const graphEdgesRecomputed = await recomputeIncidentEdges(tx, appId);

      const summary: AppDeregistrationSummary = { ...cascade.summary, graphEdgesRecomputed };
      await tx.audit.insert(this.#deregistrationAttribution(actor, finalApp, summary));
      return { app: finalApp, summary, endpointIds: cascade.endpointIds };
    });

    // XI-2 / CH-5.3 — after commit: the app's own (now deleted) endpoints and every
    // endpoint it backed. Nothing cached while it was serving may outlive the cascade.
    this.#dropCaches(committed.endpointIds);
    return { app: committed.app, summary: committed.summary };
  }

  /** Both directions are the same transaction shape; only the compare-and-set differs. */
  async #transition(
    appId: string,
    actor: string,
    action: AppLifecycleAction,
  ): Promise<RegisteredApp> {
    const expectedFrom = action === "disable" ? "active" : "disabled";
    const committed = await this.#unitOfWork.run(async (tx) => {
      const existing = await tx.registeredApps.getById(appId);
      if (existing === undefined) {
        throw new NotFoundError(`RegisteredApp ${appId} not found.`);
      }
      if (existing.status !== expectedFrom) {
        throw new ConflictError(conflictMessage(appId, existing.status, action));
      }

      const updated =
        action === "disable"
          ? await tx.registeredApps.markDisabled(appId)
          : await tx.registeredApps.markActive(appId);
      if (updated === undefined) {
        // The compare-and-set found the row already moved on between the read and the
        // write — a state conflict (409), never a silent overwrite of the other actor.
        throw new ConflictError(concurrentMessage(appId, expectedFrom, action));
      }

      await tx.audit.insert(this.#attribution(actor, updated, action));
      const endpointIds = await reactWithin(tx, updated.id);
      return { app: updated, endpointIds };
    });

    this.#dropCaches(committed.endpointIds);
    return committed.app;
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
   * AL-1.4 / OA-3 — the audit row for one transition, attributed to the authenticated
   * operator (never `system`: a disable/enable is always an explicit human action).
   * Written as a `mapping-decision` entry with the app on `originAppId`: the existing
   * audit vocabulary carries no dedicated app-lifecycle type, and coining one is a schema
   * migration this slice deliberately avoids — the same discipline the SL-2 re-pin, the
   * SL-10 suspend/resume, and the SL-9 re-inclusion rows follow. The `decision` column
   * stays unset (its four values are the review vocabulary, none of which is a lifecycle
   * transition). `details` opens with the stable {@link APP_LIFECYCLE_AUDIT_PREFIX} so the
   * rows are countable by prefix, and is metadata only — never a secret, never a base URL
   * or credential.
   */
  #attribution(actor: string, app: RegisteredApp, action: AppLifecycleAction): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "mapping-decision" as const,
      actor,
      originAppId: app.id,
      details: attributionDetails(action, app.status),
      timestamp: this.#clock(),
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    });
  }

  /**
   * AL-2.8 / OA-3 — the audit row for one deregistration, attributed to the authenticated
   * operator and carrying the **cascade summary** the criterion asks for. Same shape and
   * same reasoning as {@link #attribution}: a `mapping-decision` entry with the app on
   * `originAppId` (no dedicated app-lifecycle type is coined here — retrofitting one
   * across all five call sites is its own slice), `decision` unset, `details` opening with
   * {@link APP_LIFECYCLE_AUDIT_PREFIX}.
   *
   * The summary is **counts only** — no app name, no base URL, no credential id, no
   * record id — so the durable row can never leak landscape detail (the audit log is
   * metadata-only, `docs/architecture/security.md`). Every historical row for this app,
   * including this one, is retained: deregistration deletes credentials, never audit.
   */
  #deregistrationAttribution(
    actor: string,
    app: RegisteredApp,
    summary: AppDeregistrationSummary,
  ): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: this.#newId(),
      type: "mapping-decision" as const,
      actor,
      originAppId: app.id,
      details: deregistrationDetails(summary),
      timestamp: this.#clock(),
      traceId: trace?.traceId,
      spanId: trace?.spanId,
    });
  }
}

/** The two directions of the reversible AL-1 transition. */
type AppLifecycleAction = "disable" | "enable";

/**
 * **AL-2 — what the deregister cascade did**, in counts only. Returned to the operator
 * (so AL-4's UI can report the cascade it just ran) and folded into the audit row. It
 * deliberately carries no ids or names: it is metadata that crosses the API and the
 * durable audit log alike.
 */
export interface AppDeregistrationSummary {
  /** AL-2.2 — `SyncRule`s deleted (of every mapping naming the app on either side). */
  readonly syncRulesDeleted: number;
  /** AL-2.3 — the app's own `AdapterEndpoint`s deleted (its adapter server torn down). */
  readonly adapterEndpointsTornDown: number;
  /** AL-2.2 — bindings deleted on *other* consumers' endpoints (the app backed them). */
  readonly adapterBindingsDeleted: number;
  /** AL-2.2 — surviving endpoints left with no bindings, now serving `not-yet-mapped`. */
  readonly adapterEndpointsRevertedToNotYetMapped: number;
  /** AL-2.4 — `ApprovedMapping`s archived (retained for audit, never executed again). */
  readonly approvedMappingsArchived: number;
  /** AL-2.4 — `counterpartMappingId` links **pointing at** those archived rows, cleared. */
  readonly counterpartLinksCleared: number;
  /** AL-2.4 — the app's `ApiSpec`s archived (archived mappings still pin them). */
  readonly apiSpecsArchived: number;
  /** AL-2.5 — `RecordLink`s archived — deliberately **not** tombstoned. */
  readonly recordLinksArchived: number;
  /** AL-2.5 — `SyncFieldState` rows archived (the per-side baselines of those links). */
  readonly syncFieldStatesArchived: number;
  /** AL-2.5 — `ScopeLink`s archived through the SS-10.5 by-correspondence sweep. */
  readonly scopeLinksArchived: number;
  /** AL-2.6 — `Credential`s deleted outright, `adapterToken` included (AT-4.5). */
  readonly credentialsDeleted: number;
  /** AL-2.7 — incident `GraphEdge`s recomputed; each aggregate is empty, so each is removed. */
  readonly graphEdgesRecomputed: number;
  /** AL-2.7 / XI-2 — distinct `AdapterEndpoint`s whose cached entries were dropped. */
  readonly endpointCachesDropped: number;
}

/** AL-2 — the committed outcome: the retained (now out-of-service) app + what it cost. */
export interface AppDeregistration {
  readonly app: RegisteredApp;
  readonly summary: AppDeregistrationSummary;
}

/** The stable marker every AL-1 audit row's `details` opens with (countable by prefix). */
export const APP_LIFECYCLE_AUDIT_PREFIX = "app lifecycle:";

/**
 * **AL-1.5 — the coupled graph recompute, inside the transaction.** Every `GraphEdge`
 * incident to the app is recomputed from its **current** aggregate, keyed by the stable
 * `(app pair)` (GR-1.4): a `peer-peer` mapping's pair is its `sync` edge, a
 * `consumer-provider` mapping's pair its `adapter-dependency` edge. Both directions are
 * covered because the mappings are read by "app on either side"; each distinct
 * `(pair, type)` is recomputed once.
 *
 * The app **stays a node** — nothing here touches `registered_app`, and an edge is only
 * ever removed by its aggregate being empty (GR-2.5/GR-3.5), which a disable never makes
 * it: a disabled app's rules/bindings all still exist, they are merely paused (GR-5.4).
 *
 * Returns the distinct `AdapterEndpoint` ids to invalidate on commit: the endpoints of the
 * bindings this app **backs** (XI-2.2). The app's own consumer endpoints are deliberately
 * not dropped — a disabled app's adapter surface keeps being served (only AL-2's
 * deregister tears it down), so their cached entries stay valid.
 *
 * Writes only `graph_edge` rows and no audit row (GR-3.6) — the operator action is
 * audited by its own row.
 */
async function reactWithin(tx: TxStores, appId: string): Promise<readonly string[]> {
  await recomputeIncidentEdges(tx, appId);
  const backedBindings = await tx.downstreamArtifacts.listAdapterBindingsByBackendApp(appId);
  return [...new Set(backedBindings.map((binding) => binding.adapterEndpointId))];
}

/**
 * Recompute **every** `GraphEdge` incident to the app, once per distinct `(pair, type)`,
 * from its **current** aggregate — the shared half of AL-1.5 and AL-2.7.
 *
 * The pairs come from the app's mappings in **any** status (`listByAppId`), so an AL-2
 * cascade that has just archived them still finds every edge to repaint. What differs is
 * only what the recompute *finds*: after a disable the rules/bindings still exist and the
 * edge is rewritten `paused`; after a deregister they are deleted, the aggregate is empty,
 * and GR-1.2 **removes** the edge instead.
 *
 * Writes only `graph_edge` rows and no audit row (GR-3.6) — the operator action is
 * audited by its own row. Returns how many distinct edges were recomputed.
 */
async function recomputeIncidentEdges(tx: TxStores, appId: string): Promise<number> {
  const mappings = await tx.approvedMappings.listByAppId(appId);
  const recomputed = new Set<string>();
  for (const mapping of mappings) {
    const type = mapping.variant === "peer-peer" ? "sync" : "adapter-dependency";
    // The pair key is direction-sensitive (an edge is `(source → target)`), so both
    // directions of a bidirectional peer sync are their own edges and both recompute.
    const key = `${type}|${mapping.sourceAppId}|${mapping.targetAppId}`;
    if (recomputed.has(key)) {
      continue;
    }
    recomputed.add(key);
    if (mapping.variant === "peer-peer") {
      await tx.graph.recomputeSyncEdge(mapping.sourceAppId, mapping.targetAppId);
    } else {
      await tx.graph.recomputeAdapterEdge(mapping.sourceAppId, mapping.targetAppId);
    }
  }
  return recomputed.size;
}

/**
 * **AL-2.2 … AL-2.6 — the destructive half of the cascade, inside the caller's
 * transaction.** Split out of {@link AppLifecycleService.deregister} so the ordering is
 * readable in one place and unit-testable step by step.
 *
 * **Ordering is load-bearing** — every step removes rows that reference what a later step
 * touches, and the graph recompute the caller runs afterwards must see the *post*-cascade
 * aggregate:
 *
 * 1. the app's own endpoints go **first**, so the bindings they own cascade away before
 *    the by-backend delete counts what is left (nothing is deleted or counted twice);
 * 2. rules go before their mappings are archived — the mapping rows are **archived, never
 *    deleted**, so the rules cannot ride on a mapping cascade;
 * 3. counterpart links are cleared **after** the archive, keyed by the ids just archived;
 * 4. the record-link ids are read **before** they are archived (the read is by app and
 *    status-agnostic, so ordering is not strictly required — but the field-state archive
 *    is keyed by those ids, and reading first keeps the two steps independent).
 *
 * Returns the counts plus the distinct `AdapterEndpoint` ids whose caches the caller drops
 * after commit: the app's own (now deleted) endpoints **and** every endpoint it backed.
 */
async function runDeregisterCascade(
  tx: TxStores,
  appId: string,
): Promise<{
  readonly summary: Omit<AppDeregistrationSummary, "graphEdgesRecomputed">;
  readonly endpointIds: readonly string[];
}> {
  // ── AL-2.3 — tear down the app's own adapter surface (a CONSUMER spec's server). ──
  // The delete returns the ids it removed, which are exactly the endpoints whose cached
  // entries must be dropped after commit — no separate read needed.
  const tornDown = await tx.downstreamArtifacts.deleteAdapterEndpointsByConsumerApp(appId);

  // ── AL-2.2 — delete the bindings the app BACKS on other consumers' endpoints. ──
  // Read first: the rows give both the count and the endpoints to re-inspect/invalidate.
  const backed = await tx.downstreamArtifacts.listAdapterBindingsByBackendApp(appId);
  const affectedEndpointIds = await tx.downstreamArtifacts.deleteAdapterBindingsByBackendApp(appId);
  let reverted = 0;
  for (const endpointId of affectedEndpointIds) {
    const remaining = await tx.downstreamArtifacts.listAdapterBindingsByEndpoint(endpointId);
    if (remaining.length > 0) {
      continue;
    }
    // No bindings at all → RT-3.1 already answers `not-yet-mapped`. Flag it
    // `composition-required` too (the guarded CO-1.3 transition, a no-op on a `disabled`
    // or already-flagged endpoint) so the endpoint reads as awaiting a backend and a
    // later single-binding attach can auto-activate it again (CO-1.2).
    await tx.downstreamArtifacts.markAdapterEndpointCompositionRequired(endpointId);
    reverted += 1;
  }

  // ── AL-2.2 — delete every SyncRule of every mapping naming the app. ──
  const deletedRules = await tx.syncRules.deleteByApp(appId);

  // ── AL-2.4 — archive the mappings, clear counterparts pointing at them, archive specs. ──
  const mappings = await tx.approvedMappings.listByAppId(appId);
  const archivedMappingIds: string[] = [];
  for (const mapping of mappings) {
    const archived = await tx.approvedMappings.markArchived(mapping.id);
    if (archived !== undefined) {
      archivedMappingIds.push(archived.id);
    }
  }
  const clearedCounterparts =
    await tx.approvedMappings.clearCounterpartsPointingAt(archivedMappingIds);

  const specs = await tx.apiSpecs.listByAppId(appId);
  let archivedSpecs = 0;
  for (const spec of specs) {
    if (spec.status === "archived") {
      continue;
    }
    await tx.apiSpecs.updateStatus(spec.id, "archived");
    archivedSpecs += 1;
  }

  // ── AL-2.5 — archive the linked sync state (never a tombstone: no record was deleted). ──
  const recordLinkIds = await tx.syncStateArchival.listRecordLinkIdsByApp(appId);
  const archivedLinks = await tx.syncStateArchival.archiveRecordLinksByApp(appId);
  const archivedFieldStates =
    await tx.syncStateArchival.archiveSyncFieldStatesByRecordLinks(recordLinkIds);
  const correspondences = await tx.scopeCorrespondences.listByApp(appId);
  let archivedScopeLinks = 0;
  for (const correspondence of correspondences) {
    archivedScopeLinks += await tx.syncStateArchival.archiveScopeLinksByCorrespondence(
      correspondence.id,
    );
  }

  // ── AL-2.6 — delete the credentials outright (adapterToken included → AT-4.5). ──
  const credentialsDeleted = await tx.credentials.deleteByAppId(appId);

  const endpointIds = [
    ...new Set([...tornDown, ...backed.map((binding) => binding.adapterEndpointId)]),
  ];
  return {
    summary: {
      syncRulesDeleted: deletedRules.length,
      adapterEndpointsTornDown: tornDown.length,
      adapterBindingsDeleted: backed.length,
      adapterEndpointsRevertedToNotYetMapped: reverted,
      approvedMappingsArchived: archivedMappingIds.length,
      counterpartLinksCleared: clearedCounterparts.length,
      apiSpecsArchived: archivedSpecs,
      recordLinksArchived: archivedLinks.length,
      syncFieldStatesArchived: archivedFieldStates,
      scopeLinksArchived: archivedScopeLinks,
      credentialsDeleted,
      endpointCachesDropped: endpointIds.length,
    },
    endpointIds,
  };
}

/**
 * AL-2.8 — the audit `details` for one deregistration: the cascade summary rendered as
 * `key=count` pairs. **Counts only** — no name, no base URL, no ids — so the durable row
 * stays metadata (`docs/architecture/security.md`). Prefixed with the same stable
 * {@link APP_LIFECYCLE_AUDIT_PREFIX} as the AL-1 rows, and additionally self-describing
 * ("app deregistered by operator"), so the two are distinguishable by prefix scan.
 */
function deregistrationDetails(summary: AppDeregistrationSummary): string {
  const counts = Object.entries(summary)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `${APP_LIFECYCLE_AUDIT_PREFIX} app deregistered by operator (cascade committed; credentials deleted, mappings/specs/links archived, rules/bindings deleted); ${counts}`;
}

/** The audit `details` for one transition — metadata only. */
function attributionDetails(action: AppLifecycleAction, status: RegisteredApp["status"]): string {
  return action === "disable"
    ? `${APP_LIFECYCLE_AUDIT_PREFIX} app disabled by operator (status=${status}); its sync rules stop being polled and its adapter bindings fail backend-disabled`
    : `${APP_LIFECYCLE_AUDIT_PREFIX} app re-enabled by operator (status=${status}); rules resume under their stored status from their stored cursors/snapshots with no re-backfill`;
}

/** The 409 message for a transition attempted from a status it does not apply to. */
function conflictMessage(
  appId: string,
  status: RegisteredApp["status"],
  action: AppLifecycleAction,
): string {
  return action === "disable"
    ? `RegisteredApp ${appId} is ${status}; only an active app can be disabled.`
    : `RegisteredApp ${appId} is ${status}; only a disabled app can be re-enabled.`;
}

/** The 409 message when the compare-and-set found the row already moved on. */
function concurrentMessage(
  appId: string,
  expectedFrom: RegisteredApp["status"],
  action: AppLifecycleAction,
): string {
  return `RegisteredApp ${appId} is no longer ${expectedFrom} — its status changed concurrently; nothing was ${action === "disable" ? "disabled" : "re-enabled"}.`;
}
