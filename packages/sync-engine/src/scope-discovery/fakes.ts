import type { ScopeKey, ScopeLink } from "@mediator/domain";
import type { EstablishScopeLinkResult, ScopeLinkSideRef, ScopeLinkStore } from "@mediator/db";

/**
 * In-memory {@link ScopeLinkStore} that **faithfully mirrors** the real
 * `ScopeLinkRepository` ([[fakes-must-mirror-real-repos]]) — the **idempotent,
 * conflict-guarded** `establish` and the **active-only** `lookupByScopeKey` especially,
 * because a loose fake would let a re-run of discovery duplicate a link (breaking the
 * one-canonical-link-per-container-pair invariant SS-11 depends on).
 *
 *  - `establish` — `exists` when an active link already connects the **same** two
 *    containers, `conflict` when a container is already linked to a *different*
 *    counterpart (never re-pointed), else `created` (mirrors the repo's onA/onB checks).
 *  - `lookupByScopeKey` — matches an **active** link by (app, scope-key) on either side,
 *    scope keys compared order-insensitively (mirroring the jsonb normalization).
 *  - `sever` — a hard delete (mirroring the repo's manual-unlink delete).
 */
export class FakeScopeLinkStore implements ScopeLinkStore {
  readonly #links: ScopeLink[] = [];

  public establish(link: ScopeLink): Promise<EstablishScopeLinkResult> {
    const onA = this.#findActive(link.resourcePairRef, {
      appId: link.appAId,
      scopeKey: link.appAScopeKey,
    });
    if (onA !== undefined) {
      const same =
        onA.appBId === link.appBId && scopeKeysEqual(onA.appBScopeKey, link.appBScopeKey);
      return Promise.resolve(
        same ? { kind: "exists", link: clone(onA) } : { kind: "conflict", existing: clone(onA) },
      );
    }
    const onB = this.#findActive(link.resourcePairRef, {
      appId: link.appBId,
      scopeKey: link.appBScopeKey,
    });
    if (onB !== undefined) {
      return Promise.resolve({ kind: "conflict", existing: clone(onB) });
    }
    this.#links.push(clone(link));
    return Promise.resolve({ kind: "created", link: clone(link) });
  }

  public lookupByScopeKey(
    resourcePairRef: string,
    side: ScopeLinkSideRef,
  ): Promise<ScopeLink | undefined> {
    const found = this.#findActive(resourcePairRef, side);
    return Promise.resolve(found === undefined ? undefined : clone(found));
  }

  public sever(id: string): Promise<boolean> {
    const index = this.#links.findIndex((link) => link.id === id);
    if (index < 0) {
      return Promise.resolve(false);
    }
    this.#links.splice(index, 1);
    return Promise.resolve(true);
  }

  public listByCorrespondence(scopeCorrespondenceId: string): Promise<ScopeLink[]> {
    return Promise.resolve(
      this.#links.filter((link) => link.scopeCorrespondenceId === scopeCorrespondenceId).map(clone),
    );
  }

  public getById(id: string): Promise<ScopeLink | undefined> {
    const found = this.#links.find((link) => link.id === id);
    return Promise.resolve(found === undefined ? undefined : clone(found));
  }

  /** Every stored link (test assertions). */
  public all(): readonly ScopeLink[] {
    return this.#links.map(clone);
  }

  #findActive(resourcePairRef: string, side: ScopeLinkSideRef): ScopeLink | undefined {
    return this.#links.find(
      (link) =>
        link.status === "active" &&
        link.resourcePairRef === resourcePairRef &&
        ((link.appAId === side.appId && scopeKeysEqual(link.appAScopeKey, side.scopeKey)) ||
          (link.appBId === side.appId && scopeKeysEqual(link.appBScopeKey, side.scopeKey))),
    );
  }
}

function scopeKeysEqual(a: ScopeKey, b: ScopeKey): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

function clone(link: ScopeLink): ScopeLink {
  return {
    ...link,
    appAScopeKey: { ...link.appAScopeKey },
    appBScopeKey: { ...link.appBScopeKey },
  };
}
