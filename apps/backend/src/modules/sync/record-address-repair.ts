import type { RecordLink, ResourceBinding } from "@mediator/domain";
import type { RecordLinkSide } from "@mediator/db";
import { ContainerUnresolvedError, resolveScopeRefFillValues } from "@mediator/outbound";
import type { ScopeLinkReader } from "@mediator/outbound";
import {
  readRecordAddress,
  type MatchedTargetRecord,
  type TargetFetchResult,
  type TargetIdentityLookup,
  type TargetReadBinding,
} from "@mediator/sync-engine";

import { hasConfirmedScopePathBinding } from "./container-routing.js";
import {
  confirmedFieldPath,
  confirmedValue,
  isRefConfirmed,
  parseResourcePairRef,
} from "./resolution.js";

/**
 * **SS-19 `recordAddressRef` address-repair sweep** — the capability that stamps a
 * **container-relative address** onto the `RecordLink`s that predate a resource's
 * `recordAddressRef`, so confirming the ref on an **already-running** rule does not
 * strand its live records.
 *
 * ## The gap it closes
 *
 * A container-scoped record has two identities: the global `nativeIdRef` (what a
 * `RecordLink` correlates by) and the container-relative `recordAddressRef` (a Gitea
 * issue's `number` — what a scoped write's record-id path parameter must carry). The
 * confirmed address is frozen per side onto `RecordLink.appARecordAddress` /
 * `appBRecordAddress` at establishment (create-propagation / identity-match / manual).
 * A link established **before** the ref was confirmed carries **no** address, so the
 * moment the ref is confirmed on a running rule, `resolveRecordAddressing` flips to
 * `stored-address` and every such link **parks** (`RecordAddressUnresolvedError`) on its
 * next scoped write — reachable through the ordinary re-adoption flow. Parking is the
 * *correct* disposition (a native-id fallback 404s or clobbers a same-numbered record in
 * the container); this sweep makes the parked state **recoverable in bulk**.
 *
 * ## How it resolves an address (reusing the fetch-and-match machinery)
 *
 * The record cannot be read **by** its container-relative address (that is the value we
 * are missing), so — exactly as SS-14.1 scopes the identity lookup — the sweep
 * **enumerates the record's container** through the resource's confirmed
 * `collectionReadRef` ({@link TargetIdentityLookup.fetchAll}), filling the container path
 * parameters from the link's stored `scopeRef` / `ScopeLink` ({@link resolveScopeRefFillValues}),
 * **matches** the fetched record by the link's stored `nativeIdRef` value, reads that
 * record's `recordAddressRef` field ({@link readRecordAddress} — the *same* read Identity
 * Resolution freezes an address with), and **stamps** it onto the link. Enumeration,
 * paging, abort-on-partial and native-id extraction are the real `RestTargetIdentityLookup`;
 * this service never re-implements them.
 *
 * ## Fail-safe / idempotent / isolated (SP-4 discipline)
 *
 *  - **Fail-safe** — a link whose address cannot be resolved (record gone from the
 *    container, container unenumerable, ambiguous, partial fetch, field absent) is left
 *    **unstamped**, never guessed. It stays parked until the record reappears and a later
 *    sweep resolves it, or an operator unlinks + backfills. A stamped link then resolves
 *    `stored-address` on its next write and syncs normally.
 *  - **Idempotent** — only links whose addressing side is **NULL** are candidates
 *    ({@link RecordLinkStore.listActiveMissingRecordAddress} filters at the DB), and an
 *    already-stamped side is skipped again in-memory, so a re-run never double-stamps.
 *  - **Isolated** — every container fetch and every per-link stamp is wrapped, so one
 *    unresolvable link (or a throwing container) never blocks stamping the others.
 *
 * ## Both sides
 *
 * A bidirectional pair shares one link; the sweep stamps **whichever side** corresponds to
 * the resource whose `recordAddressRef` was just confirmed (chosen by parsing the canonical
 * `resourcePairRef`). It never touches `nativeIdRef` or any identity / uniqueness column —
 * an address is non-indexed, non-unique, and read by no lookup.
 *
 * ## Not wired here
 *
 * This ships as a **capability** ahead of its trigger, exactly as `ScopeLifecycleService` /
 * `ScopeLinkRepository.archiveByCorrespondence` did. {@link ResourceBindingService} invokes
 * {@link RecordAddressRepairTrigger.onRecordAddressRefConfirmed} after a `recordAddressRef`
 * confirm commits (out of the confirm transaction — this does network I/O); the composition
 * root constructs this service and passes it there. See the slice report for the exact wiring.
 */

/**
 * The `RecordLink` reads + the address stamp the sweep needs — the narrow slice of
 * `RecordLinkStore` it depends on, so it is unit-testable against the store fake that
 * mirrors the real repo ([[fakes-must-mirror-real-repos]]).
 */
export interface RecordAddressRepairLinks {
  listActiveMissingRecordAddress(appId: string): Promise<RecordLink[]>;
  setRecordAddress(id: string, side: RecordLinkSide, address: string): Promise<void>;
}

export interface RecordAddressRepairDeps {
  readonly recordLinks: RecordAddressRepairLinks;
  /** The real `RestTargetIdentityLookup` — the sweep enumerates each container through its `fetchAll`. */
  readonly lookup: TargetIdentityLookup;
  /** Resolves a stored `RecordLink.scopeRef` `ScopeLink` (archived-inclusive) — the real `ScopeLinkRepository`. */
  readonly scopeLinks: ScopeLinkReader;
}

/**
 * The post-confirm trigger port {@link ResourceBindingService} calls once a
 * `recordAddressRef` confirm commits. `Promise<void>` and **total** — a repair failure
 * must never fail the operator's confirm.
 */
export interface RecordAddressRepairTrigger {
  onRecordAddressRefConfirmed(binding: ResourceBinding, appId: string): Promise<void>;
}

/** The disposition of one candidate link — a discriminated union so no outcome is silent. */
export type RecordAddressRepairOutcome =
  | {
      readonly kind: "stamped";
      readonly linkId: string;
      readonly side: RecordLinkSide;
      readonly address: string;
    }
  | {
      readonly kind: "container-unresolved";
      readonly linkId: string;
      readonly side: RecordLinkSide;
    }
  | { readonly kind: "incomplete-fetch"; readonly linkId: string; readonly side: RecordLinkSide }
  | { readonly kind: "record-not-found"; readonly linkId: string; readonly side: RecordLinkSide }
  | { readonly kind: "ambiguous"; readonly linkId: string; readonly side: RecordLinkSide }
  | { readonly kind: "address-absent"; readonly linkId: string; readonly side: RecordLinkSide }
  | {
      readonly kind: "error";
      readonly linkId: string;
      readonly side: RecordLinkSide;
      readonly reason: string;
    };

export interface RecordAddressRepairResult {
  readonly outcomes: readonly RecordAddressRepairOutcome[];
}

/** A candidate link resolved to its addressing side, stored native id, and container fill. */
interface RepairCandidate {
  readonly link: RecordLink;
  readonly side: RecordLinkSide;
  readonly nativeId: string;
  readonly containerScope: ReadonlyMap<string, string> | undefined;
}

export class RecordAddressRepairService implements RecordAddressRepairTrigger {
  readonly #recordLinks: RecordAddressRepairLinks;
  readonly #lookup: TargetIdentityLookup;
  readonly #scopeLinks: ScopeLinkReader;

  public constructor(deps: RecordAddressRepairDeps) {
    this.#recordLinks = deps.recordLinks;
    this.#lookup = deps.lookup;
    this.#scopeLinks = deps.scopeLinks;
  }

  /**
   * The trigger adapter — run the sweep and discard the result, swallowing any error so a
   * repair failure never propagates back into the operator's confirm. The core
   * ({@link repairConfirmedBinding}) is already total per link; this is defense in depth.
   */
  public async onRecordAddressRefConfirmed(binding: ResourceBinding, appId: string): Promise<void> {
    try {
      await this.repairConfirmedBinding(binding, appId);
    } catch {
      // The core isolates per link; a top-level throw here is unexpected but must never
      // fail the confirm. Left unstamped links remain recoverable by a later sweep.
    }
  }

  /**
   * Stamp the container-relative address onto every active `RecordLink` under `appId`'s
   * `binding.resourceRef` that has none. Returns the per-link outcomes (empty when the
   * binding is not yet enumerable — an unconfirmed collection read / native id, or a ref
   * confirmed to a non-field target — nothing is scanned).
   */
  public async repairConfirmedBinding(
    binding: ResourceBinding,
    appId: string,
  ): Promise<RecordAddressRepairResult> {
    // Preconditions: the address ref must be confirmed to a readable FIELD, and the
    // resource must be enumerable (confirmed collection read + native id). Any missing
    // one leaves nothing to resolve — never a fabricated read.
    if (!isRefConfirmed(binding.recordAddressRef)) {
      return { outcomes: [] };
    }
    const addressPath = confirmedFieldPath(binding.recordAddressRef);
    if (addressPath === undefined) {
      return { outcomes: [] };
    }
    const collectionRef = confirmedValue(binding.collectionReadRef);
    const nativeIdPath = confirmedFieldPath(binding.nativeIdRef);
    if (collectionRef?.kind !== "operation" || nativeIdPath === undefined) {
      return { outcomes: [] };
    }
    const readBinding: TargetReadBinding = {
      collectionReadOperationId: collectionRef.operationId,
      nativeIdPath,
    };

    const scopePathBindings = binding.scopePathBindings ?? [];
    const scoped = hasConfirmedScopePathBinding(scopePathBindings);

    const outcomes: RecordAddressRepairOutcome[] = [];
    const links = await this.#recordLinks.listActiveMissingRecordAddress(appId);

    // 1) Narrow to this resource's addressing side and resolve each link's container.
    const candidates: RepairCandidate[] = [];
    for (const link of links) {
      const side = sideForResource(link, appId, binding.resourceRef);
      if (side === undefined) {
        continue; // a different resource of the same app — not this binding's concern.
      }
      if (recordAddressOfSide(link, side) !== undefined) {
        continue; // already stamped — idempotent skip (belt-and-suspenders vs. the DB filter).
      }
      const nativeId = nativeIdOfSide(link, side);
      // A scoped resource routes its container from the link's frozen `scopeRef`; a
      // constant-only / unscoped resource enumerates via the resolver's own constant fill.
      let containerScope: ReadonlyMap<string, string> | undefined;
      if (scoped) {
        try {
          containerScope = await resolveScopeRefFillValues({
            scopeRef: link.scopeRef,
            targetAppId: appId,
            scopePathBindings,
            reader: this.#scopeLinks,
          });
        } catch (error) {
          // A scopeRef-less / archived-away / mis-addressed container never guesses — leave
          // the link parked (SS-12.4 discipline, applied to the repair read).
          outcomes.push(
            error instanceof ContainerUnresolvedError
              ? { kind: "container-unresolved", linkId: link.id, side }
              : { kind: "error", linkId: link.id, side, reason: describeError(error) },
          );
          continue;
        }
      }
      candidates.push({ link, side, nativeId, containerScope });
    }

    // 2) Group by resolved container so each container is enumerated ONCE (OC-3 load
    //    discipline — the parking storm this repairs can span hundreds of links in one repo).
    const groups = new Map<string, RepairCandidate[]>();
    for (const candidate of candidates) {
      const key = containerKey(candidate.containerScope);
      const bucket = groups.get(key);
      if (bucket === undefined) {
        groups.set(key, [candidate]);
      } else {
        bucket.push(candidate);
      }
    }

    // 3) Enumerate each container and stamp the matched records (isolated per group + link).
    for (const group of groups.values()) {
      await this.#repairGroup(group, appId, readBinding, addressPath, outcomes);
    }
    return { outcomes };
  }

  /** Enumerate one container once and stamp each link whose record matched — abort-on-partial. */
  async #repairGroup(
    group: readonly RepairCandidate[],
    appId: string,
    readBinding: TargetReadBinding,
    addressPath: string,
    outcomes: RecordAddressRepairOutcome[],
  ): Promise<void> {
    const containerScope = group[0]?.containerScope; // same group key ⇒ same container.
    let fetched: TargetFetchResult;
    try {
      fetched = await this.#lookup.fetchAll({
        targetAppId: appId,
        binding: readBinding,
        ...(containerScope !== undefined ? { containerScope } : {}),
      });
    } catch (error) {
      for (const candidate of group) {
        outcomes.push({
          kind: "error",
          linkId: candidate.link.id,
          side: candidate.side,
          reason: describeError(error),
        });
      }
      return;
    }
    if (!fetched.complete) {
      // SP-4 — a partial fetch aborts EVERY link in this container (a truncated read must
      // never be misread as "record gone"), never mass-anything.
      for (const candidate of group) {
        outcomes.push({
          kind: "incomplete-fetch",
          linkId: candidate.link.id,
          side: candidate.side,
        });
      }
      return;
    }
    const byNativeId = indexByNativeId(fetched.records);
    for (const candidate of group) {
      try {
        outcomes.push(await this.#stampCandidate(candidate, byNativeId, addressPath));
      } catch (error) {
        outcomes.push({
          kind: "error",
          linkId: candidate.link.id,
          side: candidate.side,
          reason: describeError(error),
        });
      }
    }
  }

  /** Match one link's stored native id to a fetched record and stamp its address, or classify why not. */
  async #stampCandidate(
    candidate: RepairCandidate,
    byNativeId: ReadonlyMap<string, readonly MatchedTargetRecord[]>,
    addressPath: string,
  ): Promise<RecordAddressRepairOutcome> {
    const { link, side } = candidate;
    const matches = byNativeId.get(candidate.nativeId) ?? [];
    if (matches.length === 0) {
      return { kind: "record-not-found", linkId: link.id, side };
    }
    if (matches.length > 1) {
      // Defensive: the real lookup de-dups by native id, so >1 means the container reports
      // two records under one native id — a data-integrity break. Never stamp on ambiguity.
      return { kind: "ambiguous", linkId: link.id, side };
    }
    const matched = matches[0];
    if (matched === undefined) {
      return { kind: "record-not-found", linkId: link.id, side };
    }
    const address = readRecordAddress(matched.record, addressPath);
    if (address === undefined) {
      // The record does not carry the address field (absent / non-scalar) — leave parked
      // rather than stamp an empty or coerced value that would hit the wrong record.
      return { kind: "address-absent", linkId: link.id, side };
    }
    await this.#recordLinks.setRecordAddress(link.id, side, address);
    return { kind: "stamped", linkId: link.id, side, address };
  }
}

/**
 * The side of `link` that addresses `appId`'s `resourceRef` — `"A"` when it is the first
 * `appId:resourceRef` token of the canonical `resourcePairRef`, `"B"` the second, else
 * `undefined` (a foreign resource, or an unparseable ref). Determined from the ref, not the
 * bare `app_{a,b}_id`, so a self-pair (same app both sides, different resources) resolves
 * to the correct side.
 */
function sideForResource(
  link: RecordLink,
  appId: string,
  resourceRef: string,
): RecordLinkSide | undefined {
  const sides = parseResourcePairRef(link.resourcePairRef);
  if (sides === undefined) {
    return undefined;
  }
  if (sides.a.appId === appId && sides.a.resourceRef === resourceRef) {
    return "A";
  }
  if (sides.b.appId === appId && sides.b.resourceRef === resourceRef) {
    return "B";
  }
  return undefined;
}

function recordAddressOfSide(link: RecordLink, side: RecordLinkSide): string | undefined {
  return side === "A" ? link.appARecordAddress : link.appBRecordAddress;
}

function nativeIdOfSide(link: RecordLink, side: RecordLinkSide): string {
  return side === "A" ? link.appANativeId : link.appBNativeId;
}

/**
 * A stable grouping key for a resolved container fill — the sorted `parameterName=value`
 * pairs, so links whose `scopeRef` resolves to the **same** container enumerate once.
 * `undefined` (a constant-only / unscoped resource, filled by the resolver itself) groups
 * every candidate under one app-wide read.
 */
function containerKey(containerScope: ReadonlyMap<string, string> | undefined): string {
  if (containerScope === undefined) {
    return "";
  }
  return [...containerScope.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** Index fetched records by native id (arrays, so a defensive ambiguity check can see a collision). */
function indexByNativeId(
  records: readonly MatchedTargetRecord[],
): ReadonlyMap<string, readonly MatchedTargetRecord[]> {
  const byNativeId = new Map<string, MatchedTargetRecord[]>();
  for (const record of records) {
    const bucket = byNativeId.get(record.nativeId);
    if (bucket === undefined) {
      byNativeId.set(record.nativeId, [record]);
    } else {
      bucket.push(record);
    }
  }
  return byNativeId;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
