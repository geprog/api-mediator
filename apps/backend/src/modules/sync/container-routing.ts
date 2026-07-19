import type { RecordLinkScopeRef, ResourceBinding } from "@mediator/domain";
import type { ScopeLinkStore } from "@mediator/db";
import {
  resolveRecordDerivedScopeValues,
  resolveScopeLinkScopeValues,
  targetScopeKeyOf,
} from "@mediator/outbound";
import type { DetectedChange } from "@mediator/sync-engine";

import { scopeKeyFromCaptured } from "./scope-signature.js";

/**
 * **SS-12 write-side container resolution, shared** — the record's target container
 * resolved from a change's **captured scope**, for the create op's `scope-link` fill
 * (`createScopeLinkValues`) **and** the `RecordLink.scopeRef` frozen at link
 * establishment (`scopeRefForNewLink`). Extracted from the steady-state
 * `RepoSyncPipelineContextLoader` so the **initial backfill** (SS-13 discharges the
 * SS-12 deferral) freezes the *same* `scopeRef` a steady-state create would — a
 * backfilled record's later scoped delete then routes from stored state instead of
 * parking (SS-12.3/12.4).
 *
 * Returns an **empty** object when the container does not resolve (a delete carries no
 * captured scope; an L3 create whose captured scope matches **no active `ScopeLink`** —
 * SS-12.6 — leaves the create op templated so the pipeline handler parks, and the new
 * link scopeRef-less, never a guessed container):
 *
 *  - **Layer 3** (`scope-link` bindings) — the captured scope's source key → the active
 *    `ScopeLink` (`lookupByScopeKey`) → its target-side key → `createScopeLinkValues`, and
 *    `scopeRef = { kind: "scope-link", scopeLinkId }`;
 *  - **Layer 2** (`record-derived` bindings) — the frozen resolved values, as
 *    `scopeRef = { kind: "resolved", values }`, so the L2 rule's deletes route from stored
 *    values too (SS-12.7).
 */
export async function resolveScopedContainer(
  change: DetectedChange,
  targetBinding: ResourceBinding,
  scopeLinks: ScopeLinkStore,
): Promise<{
  readonly createScopeLinkValues?: ReadonlyMap<string, string>;
  readonly scopeRefForNewLink?: RecordLinkScopeRef;
}> {
  const bindings = targetBinding.scopePathBindings ?? [];
  const captured = change.capturedScope;
  if (captured === undefined) {
    return {}; // delete / non-scoped — a linked write routes from the stored scopeRef.
  }
  if (bindings.some((binding) => binding.kind === "scope-link" && isConfirmed(binding))) {
    // Layer 3 — resolve the captured scope to an active ScopeLink; never establish inline
    // (on-demand establishment is SS-11's steady-state harvest). No active link → leave
    // unresolved (SS-12.6 park / scopeRef-less link — the fail-safe).
    const sourceScopeKey = scopeKeyFromCaptured(captured);
    if (sourceScopeKey === undefined) {
      return {};
    }
    const link = await scopeLinks.lookupByScopeKey(change.resourcePairRef, {
      appId: change.sourceAppId,
      scopeKey: sourceScopeKey,
    });
    if (link === undefined) {
      return {};
    }
    const targetScopeKey = targetScopeKeyOf(link, change.targetAppId);
    if (targetScopeKey === undefined) {
      return {};
    }
    return {
      createScopeLinkValues: resolveScopeLinkScopeValues(bindings, targetScopeKey),
      scopeRefForNewLink: { kind: "scope-link", scopeLinkId: link.id },
    };
  }
  if (bindings.some((binding) => binding.kind === "record-derived" && isConfirmed(binding))) {
    // Layer 2 — freeze the resolved record-derived values so deletes route from them (SS-12.7).
    const values = resolveRecordDerivedScopeValues(bindings, captured);
    if (values.size === 0) {
      return {};
    }
    return { scopeRefForNewLink: { kind: "resolved", values: Object.fromEntries(values) } };
  }
  return {};
}

/** A scope path binding is confirmed iff both confirmation stamps are set (used nowhere until then). */
function isConfirmed(binding: { confirmedBy: string | null; confirmedAt: Date | null }): boolean {
  return binding.confirmedBy !== null && binding.confirmedAt !== null;
}
