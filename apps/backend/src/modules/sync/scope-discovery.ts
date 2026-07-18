import type {
  ApiSpec,
  AuditLogEntry,
  RegisteredApp,
  ResourceBinding,
  ScopeContainerRef,
  ScopeCorrespondence,
  ScopeKey,
  SourceScopeRef,
} from "@mediator/domain";
import type { EstablishScopeLinkResult, ScopeLinkStore } from "@mediator/db";
import {
  parseAmbiguousContainerDetails,
  type ContainerParkReader,
  type ContainerResolutionOutcome,
  type DiscoveryPassResult,
  type ScopeContainerCandidate,
  type ScopeDiscoveryStage,
  type TargetIdentityLookup,
  type TargetReadBinding,
} from "@mediator/sync-engine";
import { extractCapturedScope, type CapturedScope, type JsonRecord } from "@mediator/transform";

import {
  confirmedFieldPath,
  confirmedValue,
  isRefConfirmed,
  parseResourcePairRef,
} from "./resolution.js";
import {
  scopeKeyFromCaptured,
  sourceScopeSignature,
  targetContainerSignature,
} from "./scope-signature.js";

/**
 * **The SS-11 scope-discovery adapter/service** — the seam between the persisted
 * `ScopeCorrespondence`/`ResourceBinding`/IR state and the pure {@link ScopeDiscoveryStage}.
 * It enumerates container resources (reads only — abort-on-partial, the same OC-3 load
 * discipline as any read, via the shared {@link TargetIdentityLookup} paged reader),
 * extracts each container's addressing scope key + value-preserving identity signature
 * (reusing `sourceScopeRef` capture + the scope-identity-key pairing), and drives the
 * stage:
 *
 *  - {@link runEnablementDiscoveryPass} — SS-11.2: the enablement-time both-enumerable
 *    link-only pass (list both container resources, match, establish / park ambiguous).
 *  - {@link harvestFromCapturedScopes} — SS-11.3: harvest source scopes from records'
 *    captured `sourceScopeRef` values (source container not enumerable) and match to
 *    target containers listed via `targetContainerRef`'s collection read.
 *  - {@link resolveContainerOnDemand} — SS-11.4: on-demand inline resolution of one
 *    record's container at steady state.
 *  - {@link establishConstantLink} / {@link linkContainers} / {@link unlinkContainer} —
 *    SS-11.1 / SS-11.6: constant / manual link / sever.
 *
 * It **never writes to either app** (SS-11.8): the only ports are the container reader
 * (`fetchAll`) and the link store (via the stage). Enumeration failure is fail-closed —
 * an incomplete (partial) fetch never mass-anything (SP-4 discipline).
 */

/** How discovery enumerates a container resource (reads only, abort-on-partial). */
export interface ScopeContainerEnumerator {
  /**
   * List every container in `ref`'s resource, or `undefined` when the ref does not
   * resolve to a confirmed container collection read (not enumerable). `complete = false`
   * marks an aborted/partial fetch — the caller must NOT establish/park anything from it.
   */
  enumerate(ref: ScopeContainerRef): Promise<EnumeratedContainers | undefined>;
}

/** The result of enumerating a container resource. */
export interface EnumeratedContainers {
  readonly complete: boolean;
  readonly containers: readonly { readonly nativeId: string; readonly record: JsonRecord }[];
  /** The scope-key component name a target container's native id is stored under (its nativeIdRef leaf). */
  readonly nativeIdKeyName: string;
}

/** The narrow repo reads the enumerator/service need (the real `@mediator/db` repos satisfy them). */
export interface ScopeDiscoveryRepos {
  readonly apiSpecs: { listByAppId(appId: string): Promise<ApiSpec[]> };
  readonly resourceBindings: { listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]> };
  readonly registeredApps: { getById(appId: string): Promise<RegisteredApp | undefined> };
}

/**
 * The repo-backed {@link ScopeContainerEnumerator}: resolves a `ScopeContainerRef` to its
 * confirmed container collection read + native-id field, then pages it to exhaustion
 * through the shared {@link TargetIdentityLookup.fetchAll} (abort-on-partial). Returns
 * `undefined` for an unconfirmed / missing container read (never a fabricated enumeration).
 */
export class RepoScopeContainerEnumerator implements ScopeContainerEnumerator {
  readonly #repos: ScopeDiscoveryRepos;
  readonly #lookup: TargetIdentityLookup;

  public constructor(repos: ScopeDiscoveryRepos, lookup: TargetIdentityLookup) {
    this.#repos = repos;
    this.#lookup = lookup;
  }

  public async enumerate(ref: ScopeContainerRef): Promise<EnumeratedContainers | undefined> {
    const resource = await loadContainerResource(this.#repos, ref);
    if (resource === undefined) {
      return undefined;
    }
    const collectionRead = confirmedValue(resource.binding.collectionReadRef);
    const nativeIdPath = confirmedFieldPath(resource.binding.nativeIdRef);
    if (collectionRead?.kind !== "operation" || nativeIdPath === undefined) {
      return undefined;
    }
    const binding: TargetReadBinding = {
      collectionReadOperationId: collectionRead.operationId,
      nativeIdPath,
    };
    const result = await this.#lookup.fetchAll({ targetAppId: ref.appId, binding });
    const nativeIdKeyName = leafSegment(nativeIdPath);
    if (!result.complete) {
      return { complete: false, containers: [], nativeIdKeyName };
    }
    return { complete: true, containers: result.records, nativeIdKeyName };
  }
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface ScopeDiscoveryServiceDeps {
  readonly stage: ScopeDiscoveryStage;
  readonly links: ScopeLinkStore;
  readonly enumerator: ScopeContainerEnumerator;
  readonly correspondences: {
    getByResourcePair(resourcePairRef: string): Promise<ScopeCorrespondence | undefined>;
  };
  readonly repos: ScopeDiscoveryRepos;
}

/** Why a discovery pass could not run to completion (never a silent no-op). */
export type DiscoveryPassOutcome =
  | { readonly kind: "not-scoped" }
  | { readonly kind: "not-confirmed" }
  | { readonly kind: "source-not-enumerable" }
  | { readonly kind: "target-not-enumerable" }
  | { readonly kind: "incomplete-fetch"; readonly side: "source" | "target" }
  | { readonly kind: "completed"; readonly result: DiscoveryPassResult };

/** The outcome of an on-demand container resolution (SS-11.4) at the service level. */
export type OnDemandResolutionOutcome =
  | { readonly kind: "not-scoped" }
  | { readonly kind: "not-confirmed" }
  | { readonly kind: "unusable-scope" }
  | { readonly kind: "target-not-enumerable" }
  | { readonly kind: "incomplete-fetch" }
  | { readonly kind: "resolution"; readonly outcome: ContainerResolutionOutcome };

/** The outcome of a manual/constant establish request (SS-11.1/11.6). */
export type EstablishLinkOutcome =
  | { readonly kind: "not-scoped" }
  | { readonly kind: "established"; readonly result: EstablishScopeLinkResult };

export class ScopeDiscoveryService {
  readonly #stage: ScopeDiscoveryStage;
  readonly #links: ScopeLinkStore;
  readonly #enumerator: ScopeContainerEnumerator;
  readonly #correspondences: ScopeDiscoveryServiceDeps["correspondences"];
  readonly #repos: ScopeDiscoveryRepos;

  public constructor(deps: ScopeDiscoveryServiceDeps) {
    this.#stage = deps.stage;
    this.#links = deps.links;
    this.#enumerator = deps.enumerator;
    this.#correspondences = deps.correspondences;
    this.#repos = deps.repos;
  }

  /**
   * SS-11.2 — the enablement-time, **both-enumerable** link-only discovery pass. Lists
   * both container resources, matches by scope identity value, establishes `identity-match`
   * links, and parks an ambiguous match. A no-op-with-reason when the pair is not scoped /
   * not confirmed / the source container is not enumerable (harvest / on-demand handle
   * that). An incomplete (partial) fetch aborts the pass rather than mass-anything (SP-4).
   */
  public async runEnablementDiscoveryPass(resourcePairRef: string): Promise<DiscoveryPassOutcome> {
    const correspondence = await this.#confirmedCorrespondence(resourcePairRef);
    if (correspondence.kind !== "ok") {
      return correspondence;
    }
    const { sourceContainerRef } = correspondence.value;
    if (sourceContainerRef === undefined) {
      return { kind: "source-not-enumerable" };
    }
    const sourceScopeRef = await this.#loadSourceScopeRef(sourceContainerRef);
    if (sourceScopeRef === undefined) {
      return { kind: "source-not-enumerable" };
    }
    const sourceEnum = await this.#enumerator.enumerate(sourceContainerRef);
    if (sourceEnum === undefined) {
      return { kind: "source-not-enumerable" };
    }
    if (!sourceEnum.complete) {
      return { kind: "incomplete-fetch", side: "source" };
    }
    const targets = await this.#enumerateTargets(correspondence.value);
    if (targets.kind !== "ok") {
      return targets;
    }

    const sourceCandidates: ScopeContainerCandidate[] = [];
    for (const container of sourceEnum.containers) {
      const captured = extractCapturedScope(container.record, sourceScopeRef);
      const candidate = this.#sourceCandidate(
        sourceContainerRef.appId,
        captured,
        correspondence.value,
      );
      if (candidate !== undefined) {
        sourceCandidates.push({ ...candidate, nativeId: container.nativeId });
      }
    }

    const result = await this.#stage.establishByIdentityMatch({
      correspondence: correspondence.value,
      sourceCandidates,
      targetCandidates: targets.candidates,
    });
    return { kind: "completed", result };
  }

  /**
   * SS-11.3 — harvest source scopes from records' captured `sourceScopeRef` values (the
   * source container is not enumerable) and match each to a target container listed via
   * `targetContainerRef`. `capturedScopes` are the scopes the poll pipeline already
   * captured in-flight (L2 SS-8); duplicates are idempotent skips.
   */
  public async harvestFromCapturedScopes(
    resourcePairRef: string,
    capturedScopes: readonly CapturedScope[],
  ): Promise<DiscoveryPassOutcome> {
    const correspondence = await this.#confirmedCorrespondence(resourcePairRef);
    if (correspondence.kind !== "ok") {
      return correspondence;
    }
    const sourceAppId = this.#sourceAppIdOf(correspondence.value);
    if (sourceAppId === undefined) {
      return { kind: "source-not-enumerable" };
    }
    const targets = await this.#enumerateTargets(correspondence.value);
    if (targets.kind !== "ok") {
      return targets;
    }

    const sourceCandidates: ScopeContainerCandidate[] = [];
    for (const captured of capturedScopes) {
      const candidate = this.#sourceCandidate(sourceAppId, captured, correspondence.value);
      if (candidate !== undefined) {
        sourceCandidates.push(candidate);
      }
    }

    const result = await this.#stage.establishByIdentityMatch({
      correspondence: correspondence.value,
      sourceCandidates,
      targetCandidates: targets.candidates,
    });
    return { kind: "completed", result };
  }

  /**
   * SS-11.4 — on-demand inline resolution of one record's container. An active link short-
   * circuits (no target enumeration); otherwise the target is enumerated once and matched.
   * Fail-closed on an unusable captured scope, an unconfirmed correspondence, or an
   * incomplete target fetch (retry, never a guessed container).
   */
  public async resolveContainerOnDemand(
    resourcePairRef: string,
    capturedScope: CapturedScope,
  ): Promise<OnDemandResolutionOutcome> {
    const correspondence = await this.#confirmedCorrespondence(resourcePairRef);
    if (correspondence.kind !== "ok") {
      return correspondence;
    }
    const sourceAppId = this.#sourceAppIdOf(correspondence.value);
    if (sourceAppId === undefined) {
      return { kind: "unusable-scope" };
    }
    const candidate = this.#sourceCandidate(sourceAppId, capturedScope, correspondence.value);
    if (candidate === undefined) {
      return { kind: "unusable-scope" };
    }

    // An active link short-circuits — no need to enumerate the target (steady-state hot path).
    const existing = await this.#links.lookupByScopeKey(resourcePairRef, {
      appId: candidate.appId,
      scopeKey: candidate.scopeKey,
    });
    if (existing !== undefined) {
      return {
        kind: "resolution",
        outcome: { kind: "resolved", link: existing, establishedNow: false },
      };
    }

    const targets = await this.#enumerateTargets(correspondence.value);
    if (targets.kind === "target-not-enumerable") {
      return { kind: "target-not-enumerable" };
    }
    if (targets.kind === "incomplete-fetch") {
      return { kind: "incomplete-fetch" };
    }
    const outcome = await this.#stage.resolveContainer({
      correspondence: correspondence.value,
      source: {
        appId: candidate.appId,
        scopeKey: candidate.scopeKey,
        identitySignature: candidate.identitySignature,
      },
      targetCandidates: targets.candidates,
    });
    return { kind: "resolution", outcome };
  }

  /** SS-11.1 — establish a `constant` container link by literal source/target scope keys. */
  public async establishConstantLink(
    resourcePairRef: string,
    sourceAppId: string,
    sourceScopeKey: ScopeKey,
    targetAppId: string,
    targetScopeKey: ScopeKey,
  ): Promise<EstablishLinkOutcome> {
    const correspondence = await this.#correspondences.getByResourcePair(resourcePairRef);
    if (correspondence === undefined) {
      return { kind: "not-scoped" };
    }
    const result = await this.#stage.establishConstant({
      correspondence,
      sourceAppId,
      sourceScopeKey,
      targetAppId,
      targetScopeKey,
    });
    return { kind: "established", result };
  }

  /** SS-11.6 — manually link two containers (`establishedBy = manual`). */
  public async linkContainers(
    resourcePairRef: string,
    sourceAppId: string,
    sourceScopeKey: ScopeKey,
    targetAppId: string,
    targetScopeKey: ScopeKey,
  ): Promise<EstablishLinkOutcome> {
    const correspondence = await this.#correspondences.getByResourcePair(resourcePairRef);
    if (correspondence === undefined) {
      return { kind: "not-scoped" };
    }
    const result = await this.#stage.linkManually({
      correspondence,
      sourceAppId,
      sourceScopeKey,
      targetAppId,
      targetScopeKey,
    });
    return { kind: "established", result };
  }

  /** SS-11.6 — sever a `ScopeLink`. Returns whether a row was removed. */
  public async unlinkContainer(scopeLinkId: string): Promise<boolean> {
    return this.#stage.unlink(scopeLinkId);
  }

  // ── internals ────────────────────────────────────────────────────────────

  async #confirmedCorrespondence(
    resourcePairRef: string,
  ): Promise<
    | { readonly kind: "ok"; readonly value: ScopeCorrespondence }
    | { readonly kind: "not-scoped" }
    | { readonly kind: "not-confirmed" }
  > {
    const correspondence = await this.#correspondences.getByResourcePair(resourcePairRef);
    if (correspondence === undefined) {
      return { kind: "not-scoped" };
    }
    if (correspondence.confirmedBy === null || correspondence.confirmedAt === null) {
      return { kind: "not-confirmed" };
    }
    return { kind: "ok", value: correspondence };
  }

  async #enumerateTargets(
    correspondence: ScopeCorrespondence,
  ): Promise<
    | { readonly kind: "ok"; readonly candidates: readonly ScopeContainerCandidate[] }
    | { readonly kind: "target-not-enumerable" }
    | { readonly kind: "incomplete-fetch"; readonly side: "target" }
  > {
    const targetEnum = await this.#enumerator.enumerate(correspondence.targetContainerRef);
    if (targetEnum === undefined) {
      return { kind: "target-not-enumerable" };
    }
    if (!targetEnum.complete) {
      return { kind: "incomplete-fetch", side: "target" };
    }
    const candidates: ScopeContainerCandidate[] = [];
    for (const container of targetEnum.containers) {
      const signature = targetContainerSignature(container.record, correspondence.scopeIdentityKey);
      if (signature === undefined) {
        continue; // no comparable identity value — not matchable
      }
      candidates.push({
        appId: correspondence.targetContainerRef.appId,
        scopeKey: { [targetEnum.nativeIdKeyName]: container.nativeId },
        identitySignature: signature,
        nativeId: container.nativeId,
      });
    }
    return { kind: "ok", candidates };
  }

  /** Build a source container candidate from a captured scope, or `undefined` when unusable. */
  #sourceCandidate(
    sourceAppId: string,
    captured: CapturedScope,
    correspondence: ScopeCorrespondence,
  ): ScopeContainerCandidate | undefined {
    const scopeKey = scopeKeyFromCaptured(captured);
    const identitySignature = sourceScopeSignature(captured, correspondence.scopeIdentityKey);
    if (scopeKey === undefined || identitySignature === undefined) {
      return undefined;
    }
    return { appId: sourceAppId, scopeKey, identitySignature };
  }

  /** The source app id of a scoped pair — its `sourceContainerRef` app, else the pair side that is not the target. */
  #sourceAppIdOf(correspondence: ScopeCorrespondence): string | undefined {
    if (correspondence.sourceContainerRef !== undefined) {
      return correspondence.sourceContainerRef.appId;
    }
    const sides = parseResourcePairRef(correspondence.resourcePairRef);
    if (sides === undefined) {
      return undefined;
    }
    const targetAppId = correspondence.targetContainerRef.appId;
    if (sides.a.appId !== targetAppId) {
      return sides.a.appId;
    }
    if (sides.b.appId !== targetAppId) {
      return sides.b.appId;
    }
    return undefined;
  }

  async #loadSourceScopeRef(ref: ScopeContainerRef): Promise<SourceScopeRef | undefined> {
    const resource = await loadContainerResource(this.#repos, ref);
    const sourceScopeRef = resource?.binding.sourceScopeRef;
    if (
      sourceScopeRef === undefined ||
      sourceScopeRef.confirmedBy === null ||
      sourceScopeRef.confirmedAt === null
    ) {
      return undefined;
    }
    return sourceScopeRef;
  }
}

// ── shared container-resource resolution ───────────────────────────────────────

/** The container resource's binding (its collection read + native id + source scope ref live here). */
async function loadContainerResource(
  repos: ScopeDiscoveryRepos,
  ref: ScopeContainerRef,
): Promise<{ readonly binding: ResourceBinding } | undefined> {
  const app = await repos.registeredApps.getById(ref.appId);
  if (app?.baseUrl === undefined) {
    return undefined;
  }
  const specs = await repos.apiSpecs.listByAppId(ref.appId);
  for (const spec of specs) {
    if (spec.role !== "PROVIDER" || spec.status !== "active") {
      continue;
    }
    const hasGroup = spec.parsedIR.some((group) => group.resourceRef === ref.resourceRef);
    if (!hasGroup) {
      continue;
    }
    const bindings = await repos.resourceBindings.listByApiSpecId(spec.id);
    const binding = bindings.find((entry) => entry.resourceRef === ref.resourceRef);
    if (binding !== undefined && isRefConfirmed(binding.collectionReadRef)) {
      return { binding };
    }
  }
  return undefined;
}

/** The leaf segment of a dotted field path (`repository.id` → `id`) — the scope-key component name. */
function leafSegment(path: string): string {
  const segments = path.split(".");
  const leaf = segments[segments.length - 1];
  return leaf !== undefined && leaf.length > 0 ? leaf : path;
}

// ── Container-park dedup reader (SS-11.7) ──────────────────────────────────────

/** The narrow `failure`-event read the {@link RepoContainerParkReader} needs. */
export interface ContainerParkAuditReader {
  querySyncEvents(query: {
    readonly status: "failure";
    readonly limit: number;
  }): Promise<AuditLogEntry[]>;
}

/**
 * The repo-backed {@link ContainerParkReader}: dedups a container park across sweeps
 * (SS-11.7) by finding an **open** (still-unresolved) container-park `failure` `SyncEvent`
 * for a `(pair, source scope key)`. "Open" = the parsed park event's source scope has no
 * **active** `ScopeLink` covering it yet — the same drop-resolved rule the operator queue
 * uses. Returns the existing event id (reuse it, mint nothing) or `undefined` (mint fresh).
 * Bounded by a `limit` scan of recent failures.
 */
export class RepoContainerParkReader implements ContainerParkReader {
  readonly #audit: ContainerParkAuditReader;
  readonly #links: Pick<ScopeLinkStore, "lookupByScopeKey">;
  readonly #limit: number;

  public constructor(
    audit: ContainerParkAuditReader,
    links: Pick<ScopeLinkStore, "lookupByScopeKey">,
    options: { readonly limit?: number } = {},
  ) {
    this.#audit = audit;
    this.#links = links;
    this.#limit = options.limit ?? DEFAULT_PARK_DEDUP_SCAN;
  }

  public async findOpenContainerPark(
    resourcePairRef: string,
    sourceScopeKey: ScopeKey,
  ): Promise<string | undefined> {
    const events = await this.#audit.querySyncEvents({ status: "failure", limit: this.#limit });
    for (const event of events) {
      if (event.details === undefined) {
        continue;
      }
      const parsed = parseAmbiguousContainerDetails(event.details);
      if (
        parsed === undefined ||
        parsed.resourcePairRef !== resourcePairRef ||
        !scopeKeysEqual(parsed.sourceScopeKey, sourceScopeKey)
      ) {
        continue;
      }
      // Still OPEN only while no active link covers the container (else it was resolved and
      // a fresh park is warranted for a re-parked container).
      const active = await this.#links.lookupByScopeKey(resourcePairRef, {
        appId: parsed.sourceAppId,
        scopeKey: parsed.sourceScopeKey,
      });
      if (active === undefined) {
        return event.id;
      }
    }
    return undefined;
  }
}

/** The default bounded scan for the park-dedup reader (recent failures only). */
const DEFAULT_PARK_DEDUP_SCAN = 500;

/** Two scope-key maps are equal iff they carry the same components with the same values. */
function scopeKeysEqual(a: ScopeKey, b: ScopeKey): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}
