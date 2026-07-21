import type { PostMergeDedup } from "@mediator/domain";

/**
 * Pure derivations behind the CU-2 union composition panel — kept free of Vue so
 * the derive-then-confirm state, the link-dedup gate, and the distinct-order nudge
 * are unit-testable without mounting. Every union invariant is the **server's**
 * (CO-3, and the request-validation rejections RP-2): this layer only turns the
 * available state into the distinctions and consequences the panel must surface.
 */

/**
 * Whether **link-based dedup** may be offered (CU-2.3): only when every contributing
 * backend resource has a **confirmed `nativeIdRef`**, since link dedup needs each
 * row's backend-native id as provenance. When it may not, the missing contributors
 * are named as the reason.
 *
 * NB (backend gap): the AP-2 `composition/preview` response does not currently
 * expose per-contributor `nativeIdRef` coverage, so a host view cannot populate
 * this from the preview alone. The panel therefore takes it as input and, absent it,
 * defaults to `server-enforced` — link dedup is offered but the server rejects it
 * (with the missing refs named) if a contributor lacks the ref. See the panel notes.
 */
export type LinkDedupAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly missingContributors: readonly string[] }
  | { readonly kind: "server-enforced" };

/** The dedup mode a `PostMergeDedup` value carries, or `null` when none is chosen yet. */
export function dedupMode(dedup: PostMergeDedup | null): PostMergeDedup["mode"] | null {
  return dedup?.mode ?? null;
}

/**
 * CU-2.2 — a pagination convention is **unconfirmed** until the composer explicitly
 * confirms it: a heuristically pre-filled value is present but not yet chosen. A
 * request using a pagination parameter while unconfirmed is rejected (RP-2), so the
 * unconfirmed state must be visible and never shown as if the composer picked it.
 */
export function isPaginationUnconfirmed(hasConvention: boolean, confirmed: boolean): boolean {
  return hasConvention && !confirmed;
}

/**
 * CU-2.3 — when dedup is enabled (`record-link` or `dedup-key`), the composer is
 * **nudged** to give the contributing bindings distinct `executionOrder`s, because
 * field conflicts between duplicate rows are resolved by `executionOrder` precedence
 * (ties broken deterministically by binding id). Returns `true` when dedup is on and
 * two or more contributing bindings share an order.
 */
export function shouldNudgeDistinctOrders(
  dedup: PostMergeDedup | null,
  executionOrders: readonly number[],
): boolean {
  if (dedup === null || dedup.mode === "none") {
    return false;
  }
  const seen = new Set<number>();
  for (const order of executionOrders) {
    if (seen.has(order)) {
      return true;
    }
    seen.add(order);
  }
  return false;
}
