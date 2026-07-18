import type { ScopeKey, ScopeLink } from "@mediator/domain";

/**
 * Types for **scope discovery** — the SS-11 container-level, **link-only** pass that
 * establishes `ScopeLink`s (`docs/requirements/scoped-resource-sync.md` SS-11;
 * `docs/architecture/sync-engine.md` *Identity correlation*). It is the container analog
 * of Identity Resolution's RL-3/RL-4: match two containers by their **scope identity
 * key** value, establish a link on a single match, and **never** auto-link an ambiguous
 * one (park for manual linking, mirroring RL-4). It reads only — enumeration is the
 * caller's job (the adapter passes already-enumerated candidates) — and it **never writes
 * to either app** (SS-11.8).
 *
 * The stage works over pre-computed **identity signatures** so the value-preserving
 * comparison lives in one place (the adapter, reusing `sourceScopeRef` capture + the
 * scope-identity-key pairing) and the engine stays a pure matcher over signature strings
 * — exactly as Identity Resolution compares the identity value AS-IS (RL-3.3).
 */

/**
 * One enumerated / harvested **container candidate** for matching: the app it lives in,
 * its **addressing** scope key (`ScopeLink.appXScopeKey` — the path params to reach it,
 * `{ owner, name }` / `{ id }`), and its **identity signature** (the canonical string
 * over the scope-identity-key pairing values, computed by the adapter). `nativeId` is the
 * container's native id, surfaced only in an ambiguous-match report (never used to link).
 */
export interface ScopeContainerCandidate {
  readonly appId: string;
  readonly scopeKey: ScopeKey;
  readonly identitySignature: string;
  readonly nativeId?: string | undefined;
}

/**
 * A record's **captured source scope** for on-demand resolution (SS-11.4): the source
 * app, the captured `{ component → value }` addressing key, and the identity signature the
 * adapter computed from it. The steady-state analog of a source container candidate.
 */
export interface CapturedSourceScope {
  readonly appId: string;
  readonly scopeKey: ScopeKey;
  readonly identitySignature: string;
}

/**
 * The outcome of a single on-demand container resolution (SS-11.4/11.5):
 *  - `resolved` — an active `ScopeLink` was found (`establishedNow = false`) or just
 *    established by identity match (`establishedNow = true`).
 *  - `ambiguous` — the identity value matched >1 target container; **never** auto-linked
 *    (parked for manual linking, mirroring RL-4). A `failure` `SyncEvent` was recorded.
 *  - `unresolvable` — no target container matched (or a conflicting link exists); the
 *    record is parked, never written to a guessed container (SS-11.5).
 */
export type ContainerResolutionOutcome =
  | { readonly kind: "resolved"; readonly link: ScopeLink; readonly establishedNow: boolean }
  | {
      readonly kind: "ambiguous";
      readonly candidateNativeIds: readonly string[];
      readonly syncEventId: string;
    }
  | { readonly kind: "unresolvable" };

/** One ambiguous container match recorded during a discovery pass (parked for manual linking). */
export interface AmbiguousContainerMatch {
  readonly sourceScopeKey: ScopeKey;
  readonly candidateNativeIds: readonly string[];
  readonly syncEventId: string;
}

/**
 * The summary of an enablement / harvest discovery pass (SS-11.2/11.3): the links
 * newly established, how many source scopes were already linked (idempotent skip),
 * the ambiguous matches parked for manual linking, any establish `conflict`s (a
 * container already linked to a *different* counterpart — never overwritten), and the
 * source scopes that matched **no** target container (left for on-demand / manual).
 */
export interface DiscoveryPassResult {
  readonly established: readonly ScopeLink[];
  readonly alreadyLinked: number;
  readonly ambiguous: readonly AmbiguousContainerMatch[];
  readonly conflicts: readonly ScopeLink[];
  readonly unresolved: readonly ScopeKey[];
}
