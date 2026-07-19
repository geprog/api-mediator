import type { RecordLinkScopeRef, ScopePathBinding } from "@mediator/domain";
import type { ScopeLinkStore } from "@mediator/db";
import {
  resolveRecordDerivedScopeValues,
  resolveScopeLinkScopeValues,
  targetScopeKeyOf,
} from "@mediator/outbound";
import type { CapturedScope } from "@mediator/transform";

import { scopeKeyFromCaptured } from "./scope-signature.js";

/**
 * **SS-12 write-side container resolution, shared** — the record's target container
 * resolved from a change's **captured scope**, for the create op's `scope-link` fill
 * (`createScopeLinkValues`), the `RecordLink.scopeRef` frozen at link establishment
 * (`scopeRefForNewLink`), **and** (SS-14.1) the target-side container path-param fill a
 * **scoped identity lookup** searches within (`targetContainerScope`). Extracted from the
 * steady-state `RepoSyncPipelineContextLoader` so the **initial backfill** (SS-13
 * discharges the SS-12 deferral) and the pre-enqueue queue-key scope resolution (SS-14)
 * freeze the *same* `scopeRef` a steady-state create would — a backfilled record's later
 * scoped delete then routes from stored state instead of parking (SS-12.3/12.4).
 *
 * Returns an **empty** object when the container does not resolve (a delete carries no
 * captured scope; an L3 create whose captured scope matches **no active `ScopeLink`** —
 * SS-12.6 — leaves the create op templated so the pipeline handler parks, and the new
 * link scopeRef-less, never a guessed container):
 *
 *  - **Layer 3** (`scope-link` bindings) — the captured scope's source key → the active
 *    `ScopeLink` (`lookupByScopeKey`) → its target-side key → `createScopeLinkValues` /
 *    `targetContainerScope`, and `scopeRef = { kind: "scope-link", scopeLinkId }`;
 *  - **Layer 2** (`record-derived` bindings) — the frozen resolved values, as
 *    `scopeRef = { kind: "resolved", values }` **and** `targetContainerScope`, so the L2
 *    rule's deletes route from stored values too (SS-12.7) and its scoped identity lookup
 *    searches within the same container.
 *
 * An empty object is **not** distinguishable here between a non-scoped rule and an
 * unresolved container — callers that must tell them apart (the SS-14.3 park decision)
 * pair this with {@link hasConfirmedScopePathBinding}.
 */
export interface ScopedContainerResolution {
  /** SS-12.2 — the create op's `{ parameterName → value }` `scope-link` fill (Layer 3 only). */
  readonly createScopeLinkValues?: ReadonlyMap<string, string>;
  /** SS-12.2/12.7 — the container frozen onto the new `RecordLink.scopeRef` at establishment. */
  readonly scopeRefForNewLink?: RecordLinkScopeRef;
  /**
   * SS-14.1 — the **target-side** container scope path-param fill a scoped identity lookup
   * fills its collection read with, so fetch-and-match / filtered-read search **only within**
   * the resolved target container (Layer 3: the `ScopeLink` target-side key; Layer 2: the
   * record-derived fill). Absent when the container did not resolve.
   */
  readonly targetContainerScope?: ReadonlyMap<string, string>;
}

/** The direction-agnostic ids + captured scope a container resolution reads (a `DetectedChange` subset). */
export interface ScopedContainerInput {
  readonly capturedScope: CapturedScope | undefined;
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  /** The **target** resource's scope path bindings (constant / record-derived / scope-link). */
  readonly scopePathBindings: readonly ScopePathBinding[];
  readonly scopeLinks: ScopeLinkStore;
}

export async function resolveScopedContainer(
  input: ScopedContainerInput,
): Promise<ScopedContainerResolution> {
  const bindings = input.scopePathBindings;
  const captured = input.capturedScope;
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
    const link = await input.scopeLinks.lookupByScopeKey(input.resourcePairRef, {
      appId: input.sourceAppId,
      scopeKey: sourceScopeKey,
    });
    if (link === undefined) {
      return {};
    }
    const targetScopeKey = targetScopeKeyOf(link, input.targetAppId);
    if (targetScopeKey === undefined) {
      return {};
    }
    const targetContainerScope = resolveScopeLinkScopeValues(bindings, targetScopeKey);
    return {
      createScopeLinkValues: targetContainerScope,
      scopeRefForNewLink: { kind: "scope-link", scopeLinkId: link.id },
      targetContainerScope,
    };
  }
  if (bindings.some((binding) => binding.kind === "record-derived" && isConfirmed(binding))) {
    // Layer 2 — freeze the resolved record-derived values so deletes route from them (SS-12.7).
    const values = resolveRecordDerivedScopeValues(bindings, captured);
    if (values.size === 0) {
      return {};
    }
    return {
      scopeRefForNewLink: { kind: "resolved", values: Object.fromEntries(values) },
      targetContainerScope: values,
    };
  }
  return {};
}

/**
 * SS-14.3 — whether the target resource carries a **confirmed** scoped container binding
 * (a `scope-link` or `record-derived` entry). Distinguishes a **non-scoped** rule (keying /
 * matching unchanged) from a **scoped** rule whose container merely failed to resolve (which
 * must **park before enqueue**, never enqueue under a guessed key) — the classification
 * {@link resolveScopedContainer}'s empty return alone cannot make.
 */
export function hasConfirmedScopePathBinding(
  scopePathBindings: readonly ScopePathBinding[],
): boolean {
  return scopePathBindings.some(
    (binding) =>
      (binding.kind === "scope-link" || binding.kind === "record-derived") && isConfirmed(binding),
  );
}

/** A scope path binding is confirmed iff both confirmation stamps are set (used nowhere until then). */
function isConfirmed(binding: { confirmedBy: string | null; confirmedAt: Date | null }): boolean {
  return binding.confirmedBy !== null && binding.confirmedAt !== null;
}
