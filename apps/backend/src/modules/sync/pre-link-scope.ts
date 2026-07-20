import { randomUUID } from "node:crypto";

import type { AuditLogEntry } from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type { ScopeLinkStore } from "@mediator/db";
import type {
  ContainerParkReader,
  ContainerParkRecord,
  ContainerParkSink,
  PreLinkScopeInput,
  PreLinkScopeResolution,
  PreLinkScopeResolver,
  SyncEventRecorder,
} from "@mediator/sync-engine";
import { formatAmbiguousContainerDetails } from "@mediator/sync-engine";

import { hasConfirmedScopePathBinding, resolveScopedContainer } from "./container-routing.js";
import { scopeKeyFromCaptured } from "./scope-signature.js";

/**
 * **SS-14.2/14.3 — the pre-enqueue scoped-container resolver** the Poller's `QueueKeyResolver`
 * delegates to. It resolves a **pre-link** scoped change's captured scope to its **shared**
 * container `RecordLinkScopeRef` (the container the scope prefix is derived from) via the
 * **same** {@link resolveScopedContainer} the steady-state loader / backfill freeze the new
 * link's `scopeRef` from — so the poller's pre-link key and Identity Resolution's retained
 * `establishingQueueKey` compute the identical string, and both directions of a pair resolve
 * to the one shared `ScopeLink` first (SS-14.2). An unresolvable container is surfaced as
 * `unresolved` so the poller **parks before enqueue** (SS-14.3), never a guessed key.
 */
export class RepoPreLinkScopeResolver implements PreLinkScopeResolver {
  readonly #scopeLinks: ScopeLinkStore;

  public constructor(scopeLinks: ScopeLinkStore) {
    this.#scopeLinks = scopeLinks;
  }

  public async resolve(input: PreLinkScopeInput): Promise<PreLinkScopeResolution> {
    if (!hasConfirmedScopePathBinding(input.targetScopePathBindings)) {
      // A non-scoped rule (no confirmed container binding) — the pre-link key is unchanged.
      return { kind: "not-scoped" };
    }
    const container = await resolveScopedContainer({
      capturedScope: input.capturedScope,
      resourcePairRef: input.resourcePairRef,
      sourceAppId: input.sourceAppId,
      targetAppId: input.targetAppId,
      scopePathBindings: input.targetScopePathBindings,
      scopeLinks: this.#scopeLinks,
    });
    if (container.scopeRefForNewLink === undefined) {
      // SS-14.3 — no active ScopeLink for this record's container → cannot be safely
      // scope-keyed → the poller parks it for manual container linking (never a guessed key).
      return {
        kind: "unresolved",
        reason: `no active ScopeLink for the record's source container in ${input.resourcePairRef}`,
      };
    }
    return { kind: "scoped", scopeRef: container.scopeRefForNewLink };
  }
}

/** Options for {@link RepoContainerParkSink} (clock / id seams, mirroring the discovery stage). */
export interface RepoContainerParkSinkOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
  readonly actor?: string;
}

/**
 * **SS-14.3 — the container-link park sink** the Poller routes an unresolved-container record
 * to (parked before enqueue). It records the record's park on the **same SS-11.5 parked-
 * container surface** the `ScopeDiscoveryStage` uses: a `failure` `SyncEvent` encoded with
 * {@link formatAmbiguousContainerDetails} and an **empty** candidate list (empty = an
 * *unresolvable* — no-match — park, the container analog of RL-4's no-match). Deduped across
 * polls (SS-11.7) via the shared {@link ContainerParkReader}: while an open park already
 * covers this `(pair, source scope key)`, no new event is minted — so a still-unresolved
 * record polled every cycle accumulates one open park entry, not one per poll. Scope keys are
 * operator config, never a payload value — no secret crosses the audit boundary.
 */
export class RepoContainerParkSink implements ContainerParkSink {
  readonly #events: SyncEventRecorder;
  readonly #parkReader: ContainerParkReader;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #actor: string;

  public constructor(
    events: SyncEventRecorder,
    parkReader: ContainerParkReader,
    options: RepoContainerParkSinkOptions = {},
  ) {
    this.#events = events;
    this.#parkReader = parkReader;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#actor = options.actor ?? "system";
  }

  public async park(park: ContainerParkRecord): Promise<void> {
    const sourceScopeKey =
      park.capturedScope !== undefined ? scopeKeyFromCaptured(park.capturedScope) : undefined;
    // SS-15 gate-gating (carried-over SS-14 review item, documentation only — no behavior
    // change): the `sourceScopeKey === undefined` path below skips SS-11.7 dedup for a parked
    // record whose captured scope is absent. This is **unreachable for a gated scoped rule**:
    // the SS-15.1 gate requires the pair's `ScopeCorrespondence.scopeIdentityKey` confirmed, and
    // that key is built on the source `sourceScopeRef` (SS-7), so a gated scoped rule always has
    // a confirmed `sourceScopeRef` and thus a non-empty captured scope here. A parked record that
    // captured no scope is therefore an anomaly, not a normal flow. If a future mode ever admits a
    // scoped rule without a `sourceScopeRef`, revisit this dedup-skip.
    if (sourceScopeKey !== undefined) {
      // SS-11.7 — reuse an already-open park for this container; mint no duplicate event.
      const existing = await this.#parkReader.findOpenContainerPark(
        park.resourcePairRef,
        sourceScopeKey,
      );
      if (existing !== undefined) {
        return;
      }
    }
    const details = formatAmbiguousContainerDetails({
      resourcePairRef: park.resourcePairRef,
      sourceAppId: park.sourceAppId,
      sourceScopeKey: sourceScopeKey ?? {},
      candidateNativeIds: [],
    });
    const entry: AuditLogEntry = stripUndefined({
      id: this.#newId(),
      type: "sync-execution" as const,
      actor: this.#actor,
      status: "failure" as const,
      relatedRuleId: park.ruleId,
      relatedMappingId: park.mappingId,
      sourceNativeId: park.sourceNativeId,
      originAppId: park.sourceAppId,
      details,
      timestamp: this.#clock(),
    });
    await this.#events.record(entry);
  }
}
