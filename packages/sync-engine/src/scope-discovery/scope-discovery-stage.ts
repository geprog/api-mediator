import { randomUUID } from "node:crypto";

import type {
  AuditLogEntry,
  AuditLogStatus,
  ScopeCorrespondence,
  ScopeKey,
  ScopeLink,
  ScopeLinkEstablishedBy,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { EstablishScopeLinkResult, ScopeLinkStore } from "@mediator/db";

import type { StageTraceContext, SyncEventRecorder } from "../identity-resolution/types.js";
import { canonicalScopeSides } from "./canonical.js";
import { formatAmbiguousContainerDetails } from "./details.js";
import type {
  AmbiguousContainerMatch,
  CapturedSourceScope,
  ContainerResolutionOutcome,
  DiscoveryPassResult,
  ScopeContainerCandidate,
} from "./types.js";

/**
 * **Scope discovery** — the SS-11 container-level, **link-only** pass that establishes
 * `ScopeLink`s (`docs/requirements/scoped-resource-sync.md` SS-11;
 * `docs/architecture/sync-engine.md` *Identity correlation*, *Reconciliation*). The
 * container analog of Identity Resolution (RL-3/RL-4): match two containers by their
 * **scope identity key** value and establish the link, but **never** auto-link an
 * ambiguous match — park it for manual linking (RL-4's hard guard, one level up).
 *
 * Split by concern:
 *  - {@link establishConstant} — SS-11.1: an operator maps one container to another by
 *    literal → `establishedBy = constant`.
 *  - {@link establishByIdentityMatch} — SS-11.2 (both-enumerable) **and** SS-11.3
 *    (harvest, source not enumerable): both reduce to "match already-enumerated /
 *    harvested source scopes against target containers", so they share this one method.
 *  - {@link resolveContainer} — SS-11.4: on-demand inline resolution at steady state
 *    (existing link → match/establish → park).
 *  - {@link linkManually} / {@link unlink} — SS-11.6: operator link / sever.
 *
 * ## Invariants it upholds
 *  - **Direction-agnostic, one canonical link per pair** ({@link canonicalScopeSides} +
 *    the store's idempotent `establish`): re-running discovery never duplicates a link.
 *  - **Ambiguous → park, never auto-link** (SS-11.2/11.5): a `failure` `SyncEvent`
 *    carrying the candidate container ids, zero link/write side effects.
 *  - **Never writes to either app** (SS-11.8): the stage depends only on the
 *    {@link ScopeLinkStore} (link persistence) and the {@link SyncEventRecorder} — there
 *    is **no** outbound-write port here. Enumeration (reads) is the adapter's job.
 */
export interface ScopeDiscoveryStageDeps {
  readonly links: ScopeLinkStore;
  /** The `SyncEvent`/`AuditLog` append port — discovery executions are ordinary events (SS-11.8). */
  readonly events: SyncEventRecorder;
}

export interface ScopeDiscoveryStageOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for these system-initiated discovery events (default `"system"`). */
  readonly actor?: string;
}

/** Parameters for a constant / manual container link (SS-11.1 / SS-11.6). */
export interface EstablishContainerLinkParams {
  readonly correspondence: ScopeCorrespondence;
  readonly sourceAppId: string;
  readonly sourceScopeKey: ScopeKey;
  readonly targetAppId: string;
  readonly targetScopeKey: ScopeKey;
}

/** Parameters for an enablement / harvest discovery pass (SS-11.2 / SS-11.3). */
export interface DiscoveryPassParams {
  readonly correspondence: ScopeCorrespondence;
  /** The enumerated source containers, or harvested source scopes (each carries its signature). */
  readonly sourceCandidates: readonly ScopeContainerCandidate[];
  /** The enumerated target containers to match against. */
  readonly targetCandidates: readonly ScopeContainerCandidate[];
}

/** Parameters for an on-demand inline resolution of one record's container (SS-11.4). */
export interface ResolveContainerParams {
  readonly correspondence: ScopeCorrespondence;
  readonly source: CapturedSourceScope;
  readonly targetCandidates: readonly ScopeContainerCandidate[];
}

const DEFAULT_ACTOR = "system";

export class ScopeDiscoveryStage {
  readonly #links: ScopeLinkStore;
  readonly #events: SyncEventRecorder;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;

  public constructor(deps: ScopeDiscoveryStageDeps, options: ScopeDiscoveryStageOptions = {}) {
    this.#links = deps.links;
    this.#events = deps.events;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
  }

  /**
   * SS-11.1 — an operator maps a single source container to a target container by literal:
   * write a `ScopeLink` `establishedBy = constant` under the pair's `ScopeCorrespondence`.
   * Idempotent + conflict-guarded through the store.
   */
  public async establishConstant(
    params: EstablishContainerLinkParams,
  ): Promise<EstablishScopeLinkResult> {
    return this.#establish(params, "constant");
  }

  /**
   * SS-11.6 — an operator links two containers by hand → `establishedBy = manual`.
   * Same idempotent + conflict-guarded establish as a constant, distinguished only by
   * `establishedBy` (mirrors SA-3's manual record link).
   */
  public async linkManually(
    params: EstablishContainerLinkParams,
  ): Promise<EstablishScopeLinkResult> {
    return this.#establish(params, "manual");
  }

  /** SS-11.6 — sever a `ScopeLink` an operator judged wrong. Returns whether a row was removed. */
  public async unlink(scopeLinkId: string): Promise<boolean> {
    return this.#links.sever(scopeLinkId);
  }

  /**
   * SS-11.2 (both-enumerable) / SS-11.3 (harvest) — the enablement-time / harvest
   * **link-only** discovery pass. For each source scope: an active link already covering
   * it is an idempotent skip; otherwise match it against the target containers by identity
   * signature — a single match establishes `establishedBy = identity-match`, **more than
   * one is parked** (never auto-linked, RL-4), and no match is left `unresolved` (for
   * on-demand / manual). Reads only; **never** writes to either app (SS-11.8).
   */
  public async establishByIdentityMatch(params: DiscoveryPassParams): Promise<DiscoveryPassResult> {
    const { correspondence } = params;
    const established: ScopeLink[] = [];
    const ambiguous: AmbiguousContainerMatch[] = [];
    const conflicts: ScopeLink[] = [];
    const unresolved: ScopeKey[] = [];
    let alreadyLinked = 0;

    for (const source of params.sourceCandidates) {
      const existing = await this.#links.lookupByScopeKey(correspondence.resourcePairRef, {
        appId: source.appId,
        scopeKey: source.scopeKey,
      });
      if (existing !== undefined) {
        alreadyLinked += 1;
        continue;
      }

      const matches = params.targetCandidates.filter(
        (candidate) => candidate.identitySignature === source.identitySignature,
      );
      if (matches.length === 0) {
        unresolved.push(source.scopeKey);
        continue;
      }
      if (matches.length > 1) {
        // RL-4, one level up: an ambiguous container match is NEVER auto-linked.
        const match = await this.#parkAmbiguous(correspondence, source, matches);
        ambiguous.push(match);
        continue;
      }

      const target = requireFirst(matches);
      const outcome = await this.#establish(
        {
          correspondence,
          sourceAppId: source.appId,
          sourceScopeKey: source.scopeKey,
          targetAppId: target.appId,
          targetScopeKey: target.scopeKey,
        },
        "identity-match",
      );
      if (outcome.kind === "created") {
        established.push(outcome.link);
      } else if (outcome.kind === "exists") {
        alreadyLinked += 1;
      } else {
        conflicts.push(outcome.existing);
        await this.#recordConflict(correspondence, source, outcome.existing);
      }
    }

    return { established, alreadyLinked, ambiguous, conflicts, unresolved };
  }

  /**
   * SS-11.4 — on-demand inline resolution of one record's container at steady state. An
   * active `ScopeLink` for the captured scope resolves immediately; otherwise match it
   * against the enumerated target containers — a single match establishes the link
   * inline, an ambiguous match is **parked** (never auto-linked), and no match (or a
   * conflicting link) is **parked as unresolvable** (SS-11.5). Never a guessed container.
   */
  public async resolveContainer(
    params: ResolveContainerParams,
  ): Promise<ContainerResolutionOutcome> {
    const { correspondence, source } = params;
    const existing = await this.#links.lookupByScopeKey(correspondence.resourcePairRef, {
      appId: source.appId,
      scopeKey: source.scopeKey,
    });
    if (existing !== undefined) {
      return { kind: "resolved", link: existing, establishedNow: false };
    }

    const matches = params.targetCandidates.filter(
      (candidate) => candidate.identitySignature === source.identitySignature,
    );
    if (matches.length === 0) {
      // Parked as unresolvable — recorded, surfaced, never a guessed container (SS-11.5).
      await this.#parkAmbiguous(correspondence, source, []);
      return { kind: "unresolvable" };
    }
    if (matches.length > 1) {
      const match = await this.#parkAmbiguous(correspondence, source, matches);
      return {
        kind: "ambiguous",
        candidateNativeIds: match.candidateNativeIds,
        syncEventId: match.syncEventId,
      };
    }

    const target = requireFirst(matches);
    const outcome = await this.#establish(
      {
        correspondence,
        sourceAppId: source.appId,
        sourceScopeKey: source.scopeKey,
        targetAppId: target.appId,
        targetScopeKey: target.scopeKey,
      },
      "identity-match",
    );
    if (outcome.kind === "conflict") {
      // A conflicting link (the target is already linked to a different source) is not a
      // guess we make — park and refuse (SS-11.5).
      await this.#recordConflict(correspondence, source, outcome.existing);
      return { kind: "unresolvable" };
    }
    // outcome is `created` | `exists` here (the conflict branch returned above); both
    // carry `.link`.
    return { kind: "resolved", link: outcome.link, establishedNow: outcome.kind === "created" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Build a canonical `ScopeLink` and establish it idempotently, recording a `success` event on a create. */
  async #establish(
    params: EstablishContainerLinkParams,
    establishedBy: ScopeLinkEstablishedBy,
  ): Promise<EstablishScopeLinkResult> {
    const sides = canonicalScopeSides({
      sourceAppId: params.sourceAppId,
      sourceScopeKey: params.sourceScopeKey,
      targetAppId: params.targetAppId,
      targetScopeKey: params.targetScopeKey,
    });
    const link: ScopeLink = {
      id: this.#newId(),
      scopeCorrespondenceId: params.correspondence.id,
      appAId: sides.appAId,
      appAScopeKey: sides.appAScopeKey,
      appBId: sides.appBId,
      appBScopeKey: sides.appBScopeKey,
      resourcePairRef: params.correspondence.resourcePairRef,
      establishedBy,
      status: "active",
      createdAt: this.#clock(),
    };
    const result = await this.#links.establish(link);
    if (result.kind === "created") {
      await this.#events.record(
        this.#buildEvent({
          status: "success",
          originAppId: params.sourceAppId,
          details: `scope link established (${establishedBy}) for pair ${params.correspondence.resourcePairRef}`,
        }),
      );
    }
    return result;
  }

  /**
   * Record an ambiguous / unresolvable container match as a `failure` `SyncEvent` (SS-11.2/
   * 11.5) — the container analog of RL-4. `candidates` empty encodes an unresolvable
   * (no-match) park; >1 encodes an ambiguous one. Zero link, zero write side effects.
   */
  async #parkAmbiguous(
    correspondence: ScopeCorrespondence,
    source: { readonly appId: string; readonly scopeKey: ScopeKey },
    candidates: readonly ScopeContainerCandidate[],
  ): Promise<AmbiguousContainerMatch> {
    const candidateNativeIds = candidates.map((candidate) => candidate.nativeId ?? "");
    const syncEventId = this.#newId();
    await this.#events.record(
      this.#buildEvent({
        id: syncEventId,
        status: "failure",
        originAppId: source.appId,
        details: formatAmbiguousContainerDetails({
          resourcePairRef: correspondence.resourcePairRef,
          sourceAppId: source.appId,
          sourceScopeKey: source.scopeKey,
          candidateNativeIds,
        }),
      }),
    );
    return { sourceScopeKey: source.scopeKey, candidateNativeIds, syncEventId };
  }

  /** Record an establish `conflict` (a container already linked to a *different* counterpart). */
  async #recordConflict(
    correspondence: ScopeCorrespondence,
    source: { readonly appId: string },
    existing: ScopeLink,
  ): Promise<void> {
    await this.#events.record(
      this.#buildEvent({
        status: "failure",
        originAppId: source.appId,
        details: `scope link conflict for pair ${correspondence.resourcePairRef}: a container is already linked to a different counterpart (existing link ${existing.id})`,
      }),
    );
  }

  #buildEvent(fields: {
    readonly id?: string;
    readonly status: AuditLogStatus;
    readonly details: string;
    readonly originAppId?: string;
  }): AuditLogEntry {
    const trace = this.#readTraceContext();
    return stripUndefined({
      id: fields.id ?? this.#newId(),
      type: "sync-execution" as const,
      actor: this.#actor,
      status: fields.status,
      originAppId: fields.originAppId,
      details: fields.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
  }
}

function requireFirst(candidates: readonly ScopeContainerCandidate[]): ScopeContainerCandidate {
  const first = candidates[0];
  if (first === undefined) {
    throw new Error("expected at least one container candidate");
  }
  return first;
}
