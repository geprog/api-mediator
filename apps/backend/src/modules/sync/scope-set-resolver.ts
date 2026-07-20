import type { ScopeCorrespondence, ScopeLink, ScopePathBinding } from "@mediator/domain";
import { resolveScopeLinkScopeValues, targetScopeKeyOf } from "@mediator/outbound";
import type { PollScope, PollScopeUnresolved } from "@mediator/sync-engine";

import type { DiscoveryPassOutcome } from "./scope-discovery.js";

/**
 * **SS-17 — the shared per-scope scope-set resolution** (Call 5 read-side + Call 6
 * backfill fan-out). One place resolves the scope set a per-scope rule polls (SS-13.2/
 * 13.4) **and** the scope set its initial backfill fans out over (SS-17.4), so the two
 * never diverge: the {@link RepoPollPlanResolver} builds its {@link PerScopePollPlan}
 * from it, and the enable-input resolver builds the backfill fan-out from it.
 *
 * For **per-scope-enumerated** it runs the SS-17.1 **live container re-list** first (the
 * "enumerate scopes" step of the poll / the backfill's scope discovery), then reads the
 * now-refreshed active `ScopeLink`s; for **per-scope-pinned** it never re-lists (SS-17.6)
 * — the scope set is exactly the operator's pinned links. It **reuses** SS-11's
 * establishment (`runEnablementDiscoveryPass` → `establishByIdentityMatch`) and SS-12's
 * source-side container fill (`resolveScopeLinkScopeValues`) — it re-implements neither.
 */

/** The effective per-scope mode (SS-13.5) this resolution runs for (cross-scope never reaches here). */
export type PerScopeMode = "per-scope-enumerated" | "per-scope-pinned";

/**
 * The SS-11 discovery pass the enumerated re-list drives (SS-17.1). The
 * {@link ScopeDiscoveryService} satisfies it structurally; a fake mirrors it in tests.
 * Its outcome is deliberately **not** acted on for control flow: a `completed` pass
 * establishes every newly-appeared container's `ScopeLink` before the links are read; an
 * `incomplete-fetch` (SP-4) or any other outcome establishes nothing, so the resolution
 * proceeds over the **previously-established** links only (SS-17.3 fail-loud — never a
 * mass-poll, never a dropped known scope). An ambiguous new container is parked **inside**
 * the pass (SS-11.5), never returned here as a guessed scope.
 */
export interface EnumerationRelister {
  runEnablementDiscoveryPass(resourcePairRef: string): Promise<DiscoveryPassOutcome>;
}

/** The narrow `ScopeLink` read the scope-set resolution needs (the real repo satisfies it). */
export interface ScopeLinkLister {
  listByCorrespondence(scopeCorrespondenceId: string): Promise<ScopeLink[]>;
}

/** The resolved scope set: the pollable/backfillable scopes + the fail-loud unresolvable ones. */
export interface ResolvedScopeSet {
  readonly scopes: readonly PollScope[];
  readonly unresolvedScopes: readonly PollScopeUnresolved[];
}

export interface ResolveScopeSetInput {
  readonly effectiveMode: PerScopeMode;
  readonly resourcePairRef: string;
  /** The **source** app id — a scope's source-side scope key is selected off the link for it. */
  readonly sourceAppId: string;
  /** The **source** resource's scope path bindings — the source read's per-container fill (SS-12, source side). */
  readonly sourceScopePathBindings: readonly ScopePathBinding[];
  /** The pair's `ScopeCorrespondence` (or `undefined` when the pair has none yet). */
  readonly correspondence: ScopeCorrespondence | undefined;
  readonly links: ScopeLinkLister;
  /** The SS-17.1 re-list driver (enumerated mode only). Absent → no re-list (established links only). */
  readonly relister?: EnumerationRelister | undefined;
}

/**
 * Resolve the per-scope scope set (SS-13.2/13.4 + SS-17.1). Enumerated mode re-lists live
 * source containers + establishes `ScopeLink`s (SS-11.2) **before** enumerating them;
 * pinned mode never re-lists. Each active link becomes a scope whose `fillValues` are its
 * source-side container scope-path fill; a link that does not address the source app, or
 * whose source-side fill does not resolve, is surfaced as an `unresolvedScopes` entry the
 * caller parks — never a guessed container (fail-loud, SS-11.5 / SS-12.6).
 */
export async function resolveScopeSet(input: ResolveScopeSetInput): Promise<ResolvedScopeSet> {
  const { effectiveMode, correspondence } = input;

  // SS-17.1 — enumerated mode re-lists the live source container list via the confirmed
  // `sourceContainerRef.collectionReadRef` (paged to exhaustion) and runs the SS-11
  // enablement discovery pass over it, establishing a `ScopeLink` for every newly-appeared
  // container that matches a target container — BEFORE the links below are read. SS-17.6 —
  // pinned mode never re-lists (there is no `sourceContainerRef` to enumerate).
  if (effectiveMode === "per-scope-enumerated" && input.relister !== undefined) {
    await input.relister.runEnablementDiscoveryPass(input.resourcePairRef);
  }

  if (correspondence === undefined) {
    return {
      scopes: [],
      unresolvedScopes: [
        {
          container: input.resourcePairRef,
          reason:
            "no ScopeCorrespondence for the pair — confirm the scope identity key and link containers",
        },
      ],
    };
  }

  const links = await input.links.listByCorrespondence(correspondence.id);
  const pinnedOnly = effectiveMode === "per-scope-pinned";
  const scopes: PollScope[] = [];
  const unresolvedScopes: PollScopeUnresolved[] = [];
  for (const link of links) {
    if (link.status !== "active") {
      continue; // an archived link is not polled (its records route deletes via scopeRef).
    }
    if (pinnedOnly && link.establishedBy !== "constant" && link.establishedBy !== "manual") {
      continue; // SS-13.4 — pinned mode polls only operator-pinned links.
    }
    const sourceScopeKey = targetScopeKeyOf(link, input.sourceAppId);
    if (sourceScopeKey === undefined) {
      unresolvedScopes.push({
        container: link.id,
        reason: `ScopeLink ${link.id} does not address source app ${input.sourceAppId}`,
      });
      continue;
    }
    const fillValues = resolveScopeLinkScopeValues(input.sourceScopePathBindings, sourceScopeKey);
    if (fillValues.size === 0) {
      unresolvedScopes.push({
        container: link.id,
        reason: `source scope path parameters did not resolve for ScopeLink ${link.id}`,
      });
      continue;
    }
    scopes.push({ scopeLinkId: link.id, fillValues });
  }
  return { scopes, unresolvedScopes };
}
