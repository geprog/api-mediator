import type { RecordLinkScopeRef } from "@mediator/domain";

import { canonicalJson } from "../identity-resolution/hash.js";

/**
 * **SS-14.2 — the scope prefix of the scope-qualified pre-link ordering-queue key.** The
 * pre-link OQ-3.1 identity-value key of a **scoped** rule is qualified by the record's
 * resolved **container**, so two records sharing an identity value in **different**
 * containers do not collide onto one queue and cross-match, while the **same** record's two
 * directions still serialize on **one** queue (`docs/requirements/scoped-resource-sync.md`
 * SS-14.2; `docs/architecture/sync-engine.md` *Ordering and consistency*).
 *
 * The load-bearing invariant is **both directions compute the identical prefix**: each side
 * of the pair resolves its captured scope to the **shared `ScopeLink` first** (the poller's
 * pre-enqueue resolution and Identity Resolution's `scopeRefForNewLink` both do), so the
 * prefix is derived from a **direction-agnostic** representation of that container:
 *
 *  - **L3, arbitrary value-space** (`{ kind: "scope-link", scopeLinkId }`) → the
 *    `ScopeLink`'s **id**. The link is one canonical row per container pair (SS-11), so app
 *    A's `owner/repo` and app B's `project 42` both resolve to the **same** link id — the
 *    "ScopeLink canonical key".
 *  - **L2, shared value-space** (`{ kind: "resolved", values }`) → the canonical
 *    serialization of the resolved container's **values, sorted**. In a shared value-space
 *    the two sides carry the identical scope *value(s)* (their target parameter *names* may
 *    differ), so serializing the sorted values — not the `{ name → value }` map — yields the
 *    identical prefix from either direction.
 *
 * The two kinds are tagged (`sl:` / `rv:`) so an L2 prefix can never collide with an L3 one.
 * A `::`-joined key never shares Postgres's `uuid` shape (a link-keyed OQ-2 entry does), so
 * the OQ-4 handoff gate never mistakes a scoped pre-link key for a link id.
 */
const SCOPE_KEY_SEPARATOR = "::";

/** The direction-agnostic scope prefix of a resolved container (SS-14.2). */
export function scopePrefixOf(scopeRef: RecordLinkScopeRef): string {
  if (scopeRef.kind === "scope-link") {
    return `sl:${scopeRef.scopeLinkId}`;
  }
  const sortedValues = Object.values(scopeRef.values).sort();
  return `rv:${canonicalJson(sortedValues)}`;
}

/**
 * The scope-qualified pre-link identity-value queue key: `<scope prefix>::<identity value>`
 * (SS-14.2). `identityKey` is the already-stringified identity value ({@link
 * stringifyIdentityValue}), so this composes the *same* string the Identity Resolution stage
 * retains as `RecordLink.establishingQueueKey.value` for the OQ-4 continuation gate.
 */
export function scopeQualifiedIdentityKey(
  scopeRef: RecordLinkScopeRef,
  identityKey: string,
): string {
  return `${scopePrefixOf(scopeRef)}${SCOPE_KEY_SEPARATOR}${identityKey}`;
}
