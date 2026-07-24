import { stripUndefined, type AuditLogEntry, type RegisteredApp } from "@mediator/domain";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";

import { ConflictError, NotFoundError } from "../app-errors.js";
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
}

/** The two directions of the reversible AL-1 transition. */
type AppLifecycleAction = "disable" | "enable";

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

  const backedBindings = await tx.downstreamArtifacts.listAdapterBindingsByBackendApp(appId);
  return [...new Set(backedBindings.map((binding) => binding.adapterEndpointId))];
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
