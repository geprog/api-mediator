import type { RecordLinkScopeRef } from "@mediator/domain";
import type { CapturedScope } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { canonicalJson, stringifyIdentityValue } from "../identity-resolution/hash.js";
import {
  QueueKeyResolver,
  type PreLinkScopeInput,
  type PreLinkScopeResolution,
  type PreLinkScopeResolver,
  type QueueKeyChange,
  type QueueKeyResolution,
} from "./queue-key-resolver.js";
import { scopePrefixOf, scopeQualifiedIdentityKey } from "./scoped-queue-key.js";

/**
 * **SS-14.2 — the scope-qualified pre-link ordering-queue key.** Proves the load-bearing
 * invariant: **both directions of a pair compute the identical key** (each side resolved to
 * the shared `ScopeLink` first), while two records sharing an identity value in **different**
 * containers get **different** keys (no cross-match / cross-serialize). The park-before-enqueue
 * (SS-14.3) and the non-scoped-unchanged regression live here too.
 */

const PAIR = "rp:issues";
const APP_A = "app-gitea";
const APP_B = "app-vikunja";

/** A confirmed scope-link binding — its presence flips the resolver to the scoped path. */
const SCOPED_CONTEXT = {
  targetScopePathBindings: [
    {
      kind: "scope-link" as const,
      parameterName: "id",
      scopeKeyRef: "id",
      confirmedBy: "op",
      confirmedAt: new Date("2026-07-19T00:00:00.000Z"),
    },
  ],
};

/**
 * A fake {@link PreLinkScopeResolver} that models the real container resolution: it maps a
 * captured scope to its resolved `RecordLinkScopeRef` — so the test can make app A's
 * `owner/repo` and app B's `project 42` resolve to the **same** `ScopeLink` (as the real
 * resolver does), and prove both directions then compute the identical scope-qualified key.
 */
class FakePreLinkScopeResolver implements PreLinkScopeResolver {
  readonly #byScope: Map<string, PreLinkScopeResolution>;

  public constructor(entries: ReadonlyArray<readonly [CapturedScope, PreLinkScopeResolution]>) {
    this.#byScope = new Map(entries.map(([scope, res]) => [canonicalJson(scope), res]));
  }

  public resolve(input: PreLinkScopeInput): Promise<PreLinkScopeResolution> {
    const key = canonicalJson(input.capturedScope ?? {});
    return Promise.resolve(this.#byScope.get(key) ?? { kind: "unresolved", reason: "no link" });
  }
}

function scoped(scopeLinkId: string): PreLinkScopeResolution {
  return { kind: "scoped", scopeRef: { kind: "scope-link", scopeLinkId } };
}

function change(overrides: Partial<QueueKeyChange>): QueueKeyChange {
  return {
    resourcePairRef: PAIR,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    sourceNativeId: "n1",
    ...overrides,
  };
}

function queued(resolution: QueueKeyResolution): { queueKey: string; basis: string } {
  if (resolution.outcome !== "queue") {
    throw new Error(`expected an enqueued key, got ${resolution.outcome}`);
  }
  return { queueKey: resolution.queueKey, basis: resolution.basis };
}

describe("scopePrefixOf / scopeQualifiedIdentityKey (SS-14.2)", () => {
  it("L3 — derives the prefix from the shared ScopeLink id (direction-agnostic)", () => {
    const ref: RecordLinkScopeRef = { kind: "scope-link", scopeLinkId: "sl-1" };
    expect(scopePrefixOf(ref)).toBe("sl:sl-1");
    expect(scopeQualifiedIdentityKey(ref, canonicalJson("Bug"))).toBe(
      `sl:sl-1::${canonicalJson("Bug")}`,
    );
  });

  it("L2 — derives the prefix from the resolved values SORTED, so param NAMES do not matter", () => {
    // The two directions of a shared value-space carry the SAME value under DIFFERENT target
    // parameter names — serializing the sorted VALUES yields the identical prefix.
    const sideA: RecordLinkScopeRef = { kind: "resolved", values: { projectB: "7" } };
    const sideB: RecordLinkScopeRef = { kind: "resolved", values: { projectA: "7" } };
    expect(scopePrefixOf(sideA)).toBe(scopePrefixOf(sideB));
    expect(scopePrefixOf(sideA)).toBe(`rv:${canonicalJson(["7"])}`);
  });

  it("uses a printable separator — never a NUL byte in the composite key", () => {
    const key = scopeQualifiedIdentityKey({ kind: "scope-link", scopeLinkId: "sl-1" }, "Bug");
    expect(key).toContain("::");
    expect(key).not.toContain("\u0000");
  });

  it("tags L2 vs L3 so their prefixes can never collide", () => {
    expect(scopePrefixOf({ kind: "scope-link", scopeLinkId: "x" })).toMatch(/^sl:/);
    expect(scopePrefixOf({ kind: "resolved", values: { p: "x" } })).toMatch(/^rv:/);
  });
});

describe("QueueKeyResolver — SS-14.2 scope-qualified pre-link key", () => {
  it("BOTH directions compute the SAME key: app-A owner/repo and app-B project 42 → one ScopeLink", async () => {
    const links = new FakeRecordLinkStore(); // unlinked — pre-link keying
    // app A's `alice/phoenix` and app B's `project 42` resolve to the SAME ScopeLink `sl-1`.
    const scope = new FakePreLinkScopeResolver([
      [{ owner: "alice", repo: "phoenix" }, scoped("sl-1")],
      [{ project: "42" }, scoped("sl-1")],
    ]);
    const resolver = new QueueKeyResolver(links, scope);

    const forward = queued(
      await resolver.resolve(
        change({
          sourceAppId: APP_A,
          targetAppId: APP_B,
          sourceNativeId: "g1",
          observedRecord: { title: "Bug" },
          capturedScope: { owner: "alice", repo: "phoenix" },
        }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );
    const reverse = queued(
      await resolver.resolve(
        change({
          sourceAppId: APP_B,
          targetAppId: APP_A,
          sourceNativeId: "v1",
          observedRecord: { title: "Bug" },
          capturedScope: { project: "42" },
        }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );

    // The anti-cross-direction-duplicate guarantee, now per-container: identical key.
    expect(forward.queueKey).toBe(reverse.queueKey);
    expect(forward.basis).toBe("identity-value");
    // The identity value is stringified AS-IS (a string passes through raw), then prefixed.
    expect(forward.queueKey).toBe(`sl:sl-1::${stringifyIdentityValue("Bug")}`);
  });

  it("container-local: the SAME identity value in a DIFFERENT container gets a DIFFERENT key", async () => {
    const links = new FakeRecordLinkStore();
    const scope = new FakePreLinkScopeResolver([
      [{ project: "42" }, scoped("sl-1")],
      [{ project: "99" }, scoped("sl-2")], // a different container
    ]);
    const resolver = new QueueKeyResolver(links, scope);

    const inFortyTwo = queued(
      await resolver.resolve(
        change({ observedRecord: { title: "Bug" }, capturedScope: { project: "42" } }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );
    const inNinetyNine = queued(
      await resolver.resolve(
        change({ observedRecord: { title: "Bug" }, capturedScope: { project: "99" } }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );

    // Same title, different container → they must NOT collide/serialize/cross-match.
    expect(inFortyTwo.queueKey).not.toBe(inNinetyNine.queueKey);
  });

  it("SS-14.3 — an unresolved container PARKS (never enqueued under a guessed key)", async () => {
    const links = new FakeRecordLinkStore();
    const scope = new FakePreLinkScopeResolver([]); // nothing resolves → unresolved
    const resolver = new QueueKeyResolver(links, scope);

    const resolved = await resolver.resolve(
      change({ observedRecord: { title: "Bug" }, capturedScope: { project: "unknown" } }),
      { identitySourcePath: "title", scope: SCOPED_CONTEXT },
    );
    expect(resolved.outcome).toBe("park-container");
  });

  it("OQ-2 still wins on a scoped rule: an active link keys by link id, no scope resolution", async () => {
    const links = new FakeRecordLinkStore();
    await links.insert({
      id: "link-1",
      appAId: APP_A,
      appANativeId: "g1",
      appBId: APP_B,
      appBNativeId: "v1",
      resourcePairRef: PAIR,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "identity-value", value: "sl:sl-1::x" },
      createdAt: new Date("2026-07-19T00:00:00.000Z"),
      tombstonedAt: null,
    });
    // A scope resolver that would PARK — proving OQ-2 short-circuits before it runs.
    const resolver = new QueueKeyResolver(links, new FakePreLinkScopeResolver([]));

    const resolved = queued(
      await resolver.resolve(
        change({
          sourceAppId: APP_A,
          sourceNativeId: "g1",
          observedRecord: { title: "Bug" },
          capturedScope: { project: "42" },
        }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );
    expect(resolved).toStrictEqual({ queueKey: "link-1", basis: "record-link" });
  });

  it("non-scoped regression: no scope context → the plain identity-value key, byte-for-byte", async () => {
    const links = new FakeRecordLinkStore();
    // A scope resolver is injected but must be IGNORED when the context carries no scope.
    const resolver = new QueueKeyResolver(links, new FakePreLinkScopeResolver([]));

    const resolved = queued(
      await resolver.resolve(
        change({ observedRecord: { title: "Bug" }, capturedScope: { project: "42" } }),
        { identitySourcePath: "title" /* no scope → non-scoped keying */ },
      ),
    );
    expect(resolved).toStrictEqual({
      queueKey: stringifyIdentityValue("Bug"),
      basis: "identity-value",
    });
  });

  it("SS-15.7 — a scoped context with NO PreLinkScopeResolver wired THROWS (never keyed as non-scoped)", async () => {
    const links = new FakeRecordLinkStore();
    // NO scope resolver — the fail-loud footgun guard: a scoped rule must never fall through
    // to the plain non-scoped identity-value key.
    const resolver = new QueueKeyResolver(links);

    await expect(
      resolver.resolve(
        change({ observedRecord: { title: "Bug" }, capturedScope: { project: "42" } }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    ).rejects.toThrow(/PreLinkScopeResolver/);
  });

  it("SS-15.7 — no throw when the scoped change is short-circuited by OQ-2 (an active link) before keying", async () => {
    const links = new FakeRecordLinkStore();
    await links.insert({
      id: "link-1",
      appAId: APP_A,
      appANativeId: "g1",
      appBId: APP_B,
      appBNativeId: "v1",
      resourcePairRef: PAIR,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "identity-value", value: "sl:sl-1::x" },
      createdAt: new Date("2026-07-19T00:00:00.000Z"),
      tombstonedAt: null,
    });
    // Scoped context, NO resolver — but the record is linked, so keying resolves via the link
    // id before the identity-value branch is ever reached (no throw).
    const resolver = new QueueKeyResolver(links);

    const resolved = queued(
      await resolver.resolve(
        change({
          sourceAppId: APP_A,
          sourceNativeId: "g1",
          observedRecord: { title: "Bug" },
          capturedScope: { project: "42" },
        }),
        { identitySourcePath: "title", scope: SCOPED_CONTEXT },
      ),
    );
    expect(resolved).toStrictEqual({ queueKey: "link-1", basis: "record-link" });
  });
});
