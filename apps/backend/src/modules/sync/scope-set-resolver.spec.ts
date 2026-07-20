import type { ScopeCorrespondence, ScopeLink, ScopePathBinding } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { DiscoveryPassOutcome } from "./scope-discovery.js";
import {
  resolveScopeSet,
  type EnumerationRelister,
  type PerScopeMode,
  type ScopeLinkLister,
} from "./scope-set-resolver.js";

/**
 * SS-17 — the shared per-scope scope-set resolution (poll-time live re-list + backfill
 * fan-out scope set). Proves the SS-17.1 enumerated re-list (reusing the SS-11 discovery
 * pass), SS-17.3 fail-loud abort-to-known-links, SS-17.6 pinned-never-re-lists, and the
 * fail-loud unresolved-container surfacing (SS-11.5 / SS-12.6) — never a guessed container.
 */

const APP_SRC = "app-src";
const APP_TGT = "app-tgt";
const PAIR = `${APP_SRC}:repos|${APP_TGT}:projects`;
const CORR_ID = "corr-1";
const T0 = new Date("2026-07-19T00:00:00.000Z");

/** A confirmed source-side `scope-link` binding filling `{param}` from the link's `ref` component. */
function srcBinding(parameterName: string, scopeKeyRef: string): ScopePathBinding {
  return { kind: "scope-link", parameterName, scopeKeyRef, confirmedBy: "op", confirmedAt: T0 };
}
// The Gitea-shaped source read: `/repos/{owner}/{repo}/issues`.
const SOURCE_BINDINGS: readonly ScopePathBinding[] = [
  srcBinding("owner", "owner"),
  srcBinding("repo", "repo"),
];

function link(overrides: Partial<ScopeLink> = {}): ScopeLink {
  return {
    id: "link-1",
    scopeCorrespondenceId: CORR_ID,
    appAId: APP_SRC,
    appAScopeKey: { owner: "alice", repo: "phoenix" },
    appBId: APP_TGT,
    appBScopeKey: { id: "42" },
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    createdAt: T0,
    ...overrides,
  };
}

function correspondence(): ScopeCorrespondence {
  return {
    id: CORR_ID,
    resourcePairRef: PAIR,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: APP_TGT, resourceRef: "projects" },
    sourceContainerRef: { appId: APP_SRC, resourceRef: "repos" },
    confirmedBy: "op",
    confirmedAt: T0,
  };
}

/** An array-backed {@link ScopeLinkLister} (a re-list mutates it, mirroring an establish). */
class FakeLinks implements ScopeLinkLister {
  public readonly links: ScopeLink[];
  public constructor(links: ScopeLink[] = []) {
    this.links = links;
  }
  public listByCorrespondence(id: string): Promise<ScopeLink[]> {
    return Promise.resolve(this.links.filter((l) => l.scopeCorrespondenceId === id));
  }
}

/** A fake SS-11 discovery pass: records its calls and optionally establishes new links. */
class FakeRelister implements EnumerationRelister {
  public readonly calls: string[] = [];
  readonly #outcome: DiscoveryPassOutcome;
  readonly #onRun: (() => void) | undefined;
  public constructor(opts: { outcome?: DiscoveryPassOutcome; onRun?: () => void } = {}) {
    this.#outcome = opts.outcome ?? {
      kind: "completed",
      result: {
        established: [],
        alreadyLinked: 0,
        ambiguous: [],
        conflicts: [],
        unresolved: [],
        overridden: [],
      },
    };
    this.#onRun = opts.onRun;
  }
  public runEnablementDiscoveryPass(resourcePairRef: string): Promise<DiscoveryPassOutcome> {
    this.calls.push(resourcePairRef);
    this.#onRun?.();
    return Promise.resolve(this.#outcome);
  }
}

function run(input: {
  mode: PerScopeMode;
  links: FakeLinks;
  relister?: EnumerationRelister;
  noCorrespondence?: boolean;
}): ReturnType<typeof resolveScopeSet> {
  return resolveScopeSet({
    effectiveMode: input.mode,
    resourcePairRef: PAIR,
    sourceAppId: APP_SRC,
    sourceScopePathBindings: SOURCE_BINDINGS,
    correspondence: input.noCorrespondence === true ? undefined : correspondence(),
    links: input.links,
    ...(input.relister !== undefined ? { relister: input.relister } : {}),
  });
}

describe("SS-17.1/17.2 — per-scope-enumerated live re-list", () => {
  it("re-lists (drives the SS-11 pass) BEFORE enumerating, then polls the now-refreshed links", async () => {
    const existing = link({
      id: "link-existing",
      appAScopeKey: { owner: "alice", repo: "phoenix" },
    });
    const links = new FakeLinks([existing]);
    // The re-list discovers a NEW container and establishes its link (mirrors establishByIdentityMatch).
    const relister = new FakeRelister({
      onRun: () =>
        links.links.push(
          link({
            id: "link-new",
            appAScopeKey: { owner: "bob", repo: "atlas" },
            appBScopeKey: { id: "77" },
          }),
        ),
    });

    const { scopes, unresolvedScopes } = await run({
      mode: "per-scope-enumerated",
      links,
      relister,
    });

    expect(relister.calls).toStrictEqual([PAIR]); // ran on THIS cadence, once, before reading links
    expect(unresolvedScopes).toHaveLength(0);
    const ids = scopes.map((s) => s.scopeLinkId).sort();
    expect(ids).toStrictEqual(["link-existing", "link-new"]);
    // The newly-appeared container's source-side fill is present (it will be polled).
    const fresh = scopes.find((s) => s.scopeLinkId === "link-new");
    expect(fresh?.fillValues.get("owner")).toBe("bob");
    expect(fresh?.fillValues.get("repo")).toBe("atlas");
  });

  it("a re-list on an unchanged landscape is a cheap no-op that still enumerates the existing links", async () => {
    const links = new FakeLinks([link({ id: "link-existing" })]);
    const relister = new FakeRelister(); // establishes nothing

    const { scopes } = await run({ mode: "per-scope-enumerated", links, relister });

    expect(relister.calls).toStrictEqual([PAIR]);
    expect(scopes.map((s) => s.scopeLinkId)).toStrictEqual(["link-existing"]);
  });

  it("an INCOMPLETE re-list aborts to the previously-established links only (never mass-polls, never drops a known scope)", async () => {
    const links = new FakeLinks([link({ id: "link-existing" })]);
    // A partial container fetch: the pass aborts and establishes NOTHING (SP-4).
    const relister = new FakeRelister({ outcome: { kind: "incomplete-fetch", side: "source" } });

    const { scopes, unresolvedScopes } = await run({
      mode: "per-scope-enumerated",
      links,
      relister,
    });

    expect(relister.calls).toStrictEqual([PAIR]);
    // Only the previously-established scope is polled — no guessed/mass scope was added.
    expect(scopes.map((s) => s.scopeLinkId)).toStrictEqual(["link-existing"]);
    expect(unresolvedScopes).toHaveLength(0);
  });

  it("an AMBIGUOUS new container is parked inside the pass, never returned as a guessed scope", async () => {
    const links = new FakeLinks([link({ id: "link-existing" })]);
    // The pass establishes the unambiguous new container but PARKS the ambiguous one
    // (never auto-links it), so only the unambiguous one appears in the link store.
    const relister = new FakeRelister({
      onRun: () =>
        links.links.push(
          link({
            id: "link-unambiguous",
            appAScopeKey: { owner: "carol", repo: "vega" },
            appBScopeKey: { id: "9" },
          }),
        ),
    });

    const { scopes } = await run({ mode: "per-scope-enumerated", links, relister });

    expect(scopes.map((s) => s.scopeLinkId).sort()).toStrictEqual([
      "link-existing",
      "link-unambiguous",
    ]);
  });

  it("with NO relister injected, no re-list runs — the previously-established links only", async () => {
    const links = new FakeLinks([link({ id: "link-existing" })]);
    const { scopes } = await run({ mode: "per-scope-enumerated", links });
    expect(scopes.map((s) => s.scopeLinkId)).toStrictEqual(["link-existing"]);
  });
});

describe("SS-17.6 — per-scope-pinned never re-lists", () => {
  it("does NOT run the re-list and polls only the operator-pinned (constant/manual) links", async () => {
    const links = new FakeLinks([
      link({ id: "link-const", establishedBy: "constant" }),
      link({ id: "link-manual", establishedBy: "manual", appAScopeKey: { owner: "m", repo: "m" } }),
      link({
        id: "link-discovered",
        establishedBy: "identity-match",
        appAScopeKey: { owner: "d", repo: "d" },
      }),
    ]);
    const relister = new FakeRelister();

    const { scopes } = await run({ mode: "per-scope-pinned", links, relister });

    expect(relister.calls).toStrictEqual([]); // SS-17.6 — no live re-list in pinned mode
    expect(scopes.map((s) => s.scopeLinkId).sort()).toStrictEqual(["link-const", "link-manual"]);
  });
});

describe("SS-11.5 / SS-12.6 — fail-loud unresolved scopes (never a guessed container)", () => {
  it("a link that does not address the source app is surfaced as unresolved, never guessed", async () => {
    const links = new FakeLinks([
      link({ id: "link-foreign", appAId: APP_TGT, appBId: "app-other" }),
    ]);
    const { scopes, unresolvedScopes } = await run({
      mode: "per-scope-enumerated",
      links,
      relister: new FakeRelister(),
    });
    expect(scopes).toHaveLength(0);
    expect(unresolvedScopes).toHaveLength(1);
    expect(unresolvedScopes[0]?.container).toBe("link-foreign");
  });

  it("a link whose source-side fill does not resolve is surfaced as unresolved", async () => {
    // The source-side key has no `owner`/`repo` the source read bindings reference.
    const links = new FakeLinks([link({ id: "link-unfilled", appAScopeKey: { project: "x" } })]);
    const { scopes, unresolvedScopes } = await run({
      mode: "per-scope-enumerated",
      links,
      relister: new FakeRelister(),
    });
    expect(scopes).toHaveLength(0);
    expect(unresolvedScopes[0]?.container).toBe("link-unfilled");
  });

  it("an archived link is never polled", async () => {
    const links = new FakeLinks([
      link({ id: "link-active" }),
      link({ id: "link-archived", status: "archived", appAScopeKey: { owner: "z", repo: "z" } }),
    ]);
    const { scopes } = await run({
      mode: "per-scope-enumerated",
      links,
      relister: new FakeRelister(),
    });
    expect(scopes.map((s) => s.scopeLinkId)).toStrictEqual(["link-active"]);
  });

  it("a pair with no ScopeCorrespondence surfaces the pair as unresolved (nothing polled)", async () => {
    const { scopes, unresolvedScopes } = await run({
      mode: "per-scope-enumerated",
      links: new FakeLinks(),
      relister: new FakeRelister(),
      noCorrespondence: true,
    });
    expect(scopes).toHaveLength(0);
    expect(unresolvedScopes[0]?.container).toBe(PAIR);
  });
});
