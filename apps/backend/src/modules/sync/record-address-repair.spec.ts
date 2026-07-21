import type { WithCredentialResult } from "@mediator/credentials";
import type {
  ConfirmableRef,
  IrRefTarget,
  RecordLink,
  ResourceBinding,
  ScopeLink,
  ScopePathBinding,
} from "@mediator/domain";
import {
  AppLoadGovernor,
  type CredentialAccess,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
  type ScopeLinkReader,
} from "@mediator/outbound";
import {
  FakeRecordLinkStore,
  type MatchedTargetRecord,
  type TargetFetchResult,
  type TargetIdentityLookup,
  type TargetReadBinding,
} from "@mediator/sync-engine";
import type { JsonValue } from "@mediator/transform";
import { beforeEach, describe, expect, it } from "vitest";

import { RecordAddressRepairService } from "./record-address-repair.js";
import {
  RestTargetIdentityLookup,
  type ResolvedTargetCollectionRead,
  type TargetCollectionReadResolver,
} from "./target-identity-lookup.js";

/**
 * Unit coverage for the **SS-19 `recordAddressRef` address-repair sweep**. Every
 * disposition that a live enumeration can produce is driven through the **real**
 * {@link RestTargetIdentityLookup} — its paging, native-id extraction, abort-on-partial,
 * and de-dup are the enumeration/matching machinery the sweep reuses, and only the wire
 * (`ProtocolClient`) and the collection-read resolver are faked, so a "record gone" is a
 * genuine absence from the enumerated page and a "partial fetch" a genuine non-2xx read.
 *
 * The one disposition a de-duping lookup can never emit — an ambiguous native-id match —
 * is exercised against a small fake lookup that violates the de-dup contract, to prove the
 * sweep's defensive guard leaves such a link unstamped rather than stamp one of two.
 */

const DATE = new Date("2026-07-21T00:00:00.000Z");
const GITEA = "app-gitea";
const VIKUNJA = "app-vikunja";
// Canonical direction-agnostic pair: `app-gitea:issues` < `app-vikunja:tasks`, so the
// Gitea issues resource is side **A** (its address lands on `appARecordAddress`).
const PAIR = `${GITEA}:issues|${VIKUNJA}:tasks`;

function confirm(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "operator", confirmedAt: DATE };
}

/** The Gitea issues binding as an operator leaves it after confirming `recordAddressRef`. */
function giteaBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  return {
    id: "rb-gitea-issues",
    apiSpecId: "spec-gitea",
    resourceRef: "issues",
    nativeIdRef: confirm({ kind: "field", path: "id" }),
    recordAddressRef: confirm({ kind: "field", path: "number" }),
    collectionReadRef: confirm({ kind: "operation", operationId: "issueListIssues" }),
    scopePathBindings: [],
    ...overrides,
  };
}

function link(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: "link-1",
    appAId: GITEA,
    appANativeId: "4242",
    appBId: VIKUNJA,
    appBNativeId: "task-1",
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "Ship it" },
    createdAt: DATE,
    tombstonedAt: null,
    ...overrides,
  };
}

const NO_CREDENTIAL: CredentialAccess = {
  withCredential: <T>(): Promise<WithCredentialResult<T>> =>
    Promise.resolve({ outcome: "no-credential" }),
};

/** A wire whose response + status the test controls; records the URLs it was asked for. */
class IssuesProtocol implements ProtocolClient {
  public readonly urls: string[] = [];
  public constructor(
    private readonly status: number,
    private readonly bodyFor: (url: string) => JsonValue,
  ) {}
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.urls.push(request.url);
    return Promise.resolve({ status: this.status, headers: {}, body: this.bodyFor(request.url) });
  }
}

/**
 * A {@link TargetCollectionReadResolver} double: composes the Gitea issues collection read
 * wire shape, substituting `{owner}`/`{repo}` from the sweep-supplied `containerScope` when
 * the resource is scope-link scoped (else a fixed single-repo path). Mirrors what
 * `RepoTargetCollectionReadResolver` returns, without loading specs.
 */
function issuesResolver(): TargetCollectionReadResolver {
  return {
    resolve: (
      targetAppId: string,
      binding: TargetReadBinding,
      containerScope?: ReadonlyMap<string, string>,
    ): Promise<ResolvedTargetCollectionRead | undefined> => {
      const owner = containerScope?.get("owner") ?? "alice";
      const repo = containerScope?.get("repo") ?? "phoenix";
      return Promise.resolve({
        binding: {
          sourceAppId: targetAppId,
          baseUrl: "https://gitea.test",
          method: "GET",
          path: `/repos/${owner}/${repo}/issues`,
          nativeIdPath: binding.nativeIdPath,
          pagination: { kind: "single-page" },
        },
        parameters: [],
      });
    },
  };
}

function realLookup(protocol: ProtocolClient): RestTargetIdentityLookup {
  return new RestTargetIdentityLookup(
    issuesResolver(),
    protocol,
    NO_CREDENTIAL,
    new AppLoadGovernor(),
    {
      applyCredential: (headers) => ({ ...headers }),
    },
  );
}

/** A `ScopeLinkReader` returning the configured links (empty ⇒ every id resolves to undefined). */
class FakeScopeLinkReader implements ScopeLinkReader {
  readonly #links = new Map<string, ScopeLink>();
  public set(scopeLink: ScopeLink): void {
    this.#links.set(scopeLink.id, scopeLink);
  }
  public getById(id: string): Promise<ScopeLink | undefined> {
    return Promise.resolve(this.#links.get(id));
  }
}

function serviceOf(
  store: FakeRecordLinkStore,
  lookup: TargetIdentityLookup,
  scopeLinks: ScopeLinkReader = new FakeScopeLinkReader(),
): RecordAddressRepairService {
  return new RecordAddressRepairService({ recordLinks: store, lookup, scopeLinks });
}

async function seed(store: FakeRecordLinkStore, links: readonly RecordLink[]): Promise<void> {
  for (const entry of links) {
    await store.insert(entry);
  }
}

describe("RecordAddressRepairService — resolve-and-stamp over the real enumeration machinery", () => {
  let store: FakeRecordLinkStore;

  beforeEach(() => {
    store = new FakeRecordLinkStore();
  });

  it("stamps the container-relative address of each active link whose record is present", async () => {
    await seed(store, [
      link({ id: "link-a", appANativeId: "4242", appBNativeId: "task-a" }),
      link({ id: "link-b", appANativeId: "4243", appBNativeId: "task-b" }),
    ]);
    const protocol = new IssuesProtocol(200, () => [
      { id: 4242, number: 7 },
      { id: 4243, number: 8 },
    ]);

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      giteaBinding(),
      GITEA,
    );

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        { kind: "stamped", linkId: "link-a", side: "A", address: "7" },
        { kind: "stamped", linkId: "link-b", side: "A", address: "8" },
      ]),
    );
    // The frozen address lands on side A; the native ids the link correlates by are untouched.
    const a = await store.getById("link-a");
    expect(a?.appARecordAddress).toBe("7");
    expect(a?.appANativeId).toBe("4242");
    expect(a?.appBRecordAddress).toBeUndefined();
    expect((await store.getById("link-b"))?.appARecordAddress).toBe("8");
    // The container is enumerated once, not once per link (OC-3 load discipline).
    expect(protocol.urls).toEqual(["https://gitea.test/repos/alice/phoenix/issues"]);
  });

  it("leaves a link unstamped (record-not-found) when its record is gone from the container, without blocking the others", async () => {
    await seed(store, [
      link({ id: "present", appANativeId: "4242", appBNativeId: "task-p" }),
      link({ id: "gone", appANativeId: "9999", appBNativeId: "task-g" }),
    ]);
    // Only 4242 is in the container; 9999 was deleted from the app.
    const protocol = new IssuesProtocol(200, () => [{ id: 4242, number: 7 }]);

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      giteaBinding(),
      GITEA,
    );

    expect(result.outcomes).toContainEqual({
      kind: "stamped",
      linkId: "present",
      side: "A",
      address: "7",
    });
    expect(result.outcomes).toContainEqual({
      kind: "record-not-found",
      linkId: "gone",
      side: "A",
    });
    // Isolation: the resolvable link is stamped even though a sibling could not resolve.
    expect((await store.getById("present"))?.appARecordAddress).toBe("7");
    expect((await store.getById("gone"))?.appARecordAddress).toBeUndefined();
  });

  it("aborts every link in a container on a partial fetch — never a mass no-match", async () => {
    await seed(store, [
      link({ id: "link-a", appANativeId: "4242", appBNativeId: "task-a" }),
      link({ id: "link-b", appANativeId: "4243", appBNativeId: "task-b" }),
    ]);
    // A non-2xx page → the real lookup returns `{ complete: false }`.
    const protocol = new IssuesProtocol(500, () => []);

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      giteaBinding(),
      GITEA,
    );

    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        { kind: "incomplete-fetch", linkId: "link-a", side: "A" },
        { kind: "incomplete-fetch", linkId: "link-b", side: "A" },
      ]),
    );
    expect((await store.getById("link-a"))?.appARecordAddress).toBeUndefined();
    expect((await store.getById("link-b"))?.appARecordAddress).toBeUndefined();
  });

  it("leaves a link unstamped (address-absent) when the matched record does not carry the address field", async () => {
    await seed(store, [link({ id: "no-number", appANativeId: "4242" })]);
    // The record is found but exposes no `number` (or a non-scalar one) — never coerce.
    const protocol = new IssuesProtocol(200, () => [{ id: 4242 }]);

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      giteaBinding(),
      GITEA,
    );

    expect(result.outcomes).toEqual([{ kind: "address-absent", linkId: "no-number", side: "A" }]);
    expect((await store.getById("no-number"))?.appARecordAddress).toBeUndefined();
  });

  it("is idempotent — a re-run never re-stamps an already-addressed link", async () => {
    await seed(store, [link({ id: "link-a", appANativeId: "4242" })]);
    const protocol = new IssuesProtocol(200, () => [{ id: 4242, number: 7 }]);
    const service = serviceOf(store, realLookup(protocol));

    const first = await service.repairConfirmedBinding(giteaBinding(), GITEA);
    expect(first.outcomes).toEqual([
      { kind: "stamped", linkId: "link-a", side: "A", address: "7" },
    ]);

    // Second sweep: the link now has an address, so it is no longer a candidate at all.
    const second = await service.repairConfirmedBinding(giteaBinding(), GITEA);
    expect(second.outcomes).toEqual([]);
    expect((await store.getById("link-a"))?.appARecordAddress).toBe("7");
    // The first read enumerated once; the second issued NO further read (no candidates).
    expect(protocol.urls).toEqual(["https://gitea.test/repos/alice/phoenix/issues"]);
  });

  it("does nothing (scans nothing) when the address ref is unconfirmed or the resource is not enumerable", async () => {
    await seed(store, [link({ id: "link-a" })]);
    const protocol = new IssuesProtocol(200, () => [{ id: 4242, number: 7 }]);
    const service = serviceOf(store, realLookup(protocol));

    // Unconfirmed recordAddressRef → confirming has not happened yet.
    const unconfirmedRef = await service.repairConfirmedBinding(
      giteaBinding({
        recordAddressRef: {
          value: { kind: "field", path: "number" },
          confirmedBy: null,
          confirmedAt: null,
        },
      }),
      GITEA,
    );
    expect(unconfirmedRef.outcomes).toEqual([]);

    // No confirmed collection read → the resource cannot be enumerated.
    const noCollectionRead = await service.repairConfirmedBinding(
      giteaBinding({ collectionReadRef: undefined }),
      GITEA,
    );
    expect(noCollectionRead.outcomes).toEqual([]);
    // Neither precondition failure ever hit the wire.
    expect(protocol.urls).toEqual([]);
  });

  it("ignores links that belong to a different resource of the same app", async () => {
    // Same app (`app-gitea`) but the pair's Gitea side is `pulls`, not `issues`.
    await seed(store, [
      link({ id: "pulls-link", resourcePairRef: `${GITEA}:pulls|${VIKUNJA}:tasks` }),
    ]);
    const protocol = new IssuesProtocol(200, () => [{ id: 4242, number: 7 }]);

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      giteaBinding(),
      GITEA,
    );

    expect(result.outcomes).toEqual([]);
    expect((await store.getById("pulls-link"))?.appARecordAddress).toBeUndefined();
    expect(protocol.urls).toEqual([]);
  });

  it("stamps the Vikunja-side address when the confirmed resource is the pair's side B", async () => {
    // Confirm the address ref on the Vikunja `tasks` resource — it is side B of the pair.
    await seed(store, [link({ id: "link-a", appBNativeId: "task-77" })]);
    const protocol = new IssuesProtocol(200, () => [{ id: "task-77", number: 3 }]);
    const vikunjaBinding = giteaBinding({
      id: "rb-vikunja-tasks",
      apiSpecId: "spec-vikunja",
      resourceRef: "tasks",
      nativeIdRef: confirm({ kind: "field", path: "id" }),
    });

    const result = await serviceOf(store, realLookup(protocol)).repairConfirmedBinding(
      vikunjaBinding,
      VIKUNJA,
    );

    expect(result.outcomes).toEqual([
      { kind: "stamped", linkId: "link-a", side: "B", address: "3" },
    ]);
    const stored = await store.getById("link-a");
    expect(stored?.appBRecordAddress).toBe("3");
    expect(stored?.appARecordAddress).toBeUndefined();
  });
});

describe("RecordAddressRepairService — scope-link container resolution + fail-safe", () => {
  const SCOPE_BINDINGS: ScopePathBinding[] = [
    {
      kind: "scope-link",
      parameterName: "owner",
      scopeKeyRef: "owner",
      confirmedBy: "op",
      confirmedAt: DATE,
    },
    {
      kind: "scope-link",
      parameterName: "repo",
      scopeKeyRef: "repo",
      confirmedBy: "op",
      confirmedAt: DATE,
    },
  ];

  function scopedBinding(): ResourceBinding {
    return giteaBinding({ scopePathBindings: SCOPE_BINDINGS });
  }

  function scopeLink(overrides: Partial<ScopeLink> = {}): ScopeLink {
    return {
      id: "scope-phoenix",
      scopeCorrespondenceId: "corr-1",
      appAId: GITEA,
      appAScopeKey: { owner: "alice", repo: "phoenix" },
      appBId: VIKUNJA,
      appBScopeKey: { id: "42" },
      resourcePairRef: PAIR,
      establishedBy: "identity-match",
      status: "active",
      createdAt: DATE,
      ...overrides,
    };
  }

  it("resolves the container from the link's scopeRef and enumerates only that container", async () => {
    const store = new FakeRecordLinkStore();
    await store.insert(
      link({
        id: "scoped",
        appANativeId: "4242",
        scopeRef: { kind: "scope-link", scopeLinkId: "scope-phoenix" },
      }),
    );
    const reader = new FakeScopeLinkReader();
    reader.set(scopeLink());
    const protocol = new IssuesProtocol(200, (url) =>
      url.includes("/repos/alice/phoenix/") ? [{ id: 4242, number: 7 }] : [],
    );

    const result = await new RecordAddressRepairService({
      recordLinks: store,
      lookup: realLookup(protocol),
      scopeLinks: reader,
    }).repairConfirmedBinding(scopedBinding(), GITEA);

    expect(result.outcomes).toEqual([
      { kind: "stamped", linkId: "scoped", side: "A", address: "7" },
    ]);
    // The scope-link key filled `{owner}`/`{repo}` — the read stayed inside alice/phoenix.
    expect(protocol.urls).toEqual(["https://gitea.test/repos/alice/phoenix/issues"]);
  });

  it("leaves a scoped link unstamped (container-unresolved) when its scopeRef is absent — never a guessed container", async () => {
    const store = new FakeRecordLinkStore();
    // A scoped resource, but this link never captured its container (scopeRef absent).
    await store.insert(link({ id: "no-scope", appANativeId: "4242" }));
    const protocol = new IssuesProtocol(200, () => [{ id: 4242, number: 7 }]);

    const result = await new RecordAddressRepairService({
      recordLinks: store,
      lookup: realLookup(protocol),
      scopeLinks: new FakeScopeLinkReader(),
    }).repairConfirmedBinding(scopedBinding(), GITEA);

    expect(result.outcomes).toEqual([
      { kind: "container-unresolved", linkId: "no-scope", side: "A" },
    ]);
    expect((await store.getById("no-scope"))?.appARecordAddress).toBeUndefined();
    // No fetch was ever issued for the unresolvable container.
    expect(protocol.urls).toEqual([]);
  });
});

/**
 * A lookup that returns TWO records under one native id — a contract violation the real
 * de-duping `RestTargetIdentityLookup` cannot produce, used solely to prove the sweep's
 * defensive ambiguity guard never stamps one of two colliding records.
 */
class AmbiguousLookup implements TargetIdentityLookup {
  public constructor(private readonly records: readonly MatchedTargetRecord[]) {}
  public filteredRead(): Promise<readonly MatchedTargetRecord[]> {
    return Promise.resolve([]);
  }
  public fetchAll(): Promise<TargetFetchResult> {
    return Promise.resolve({ complete: true, records: this.records });
  }
}

describe("RecordAddressRepairService — ambiguity guard (defensive)", () => {
  it("leaves a link unstamped when two records claim its native id", async () => {
    const store = new FakeRecordLinkStore();
    await store.insert(link({ id: "ambiguous", appANativeId: "4242" }));
    const lookup = new AmbiguousLookup([
      { nativeId: "4242", record: { id: "4242", number: 7 } },
      { nativeId: "4242", record: { id: "4242", number: 8 } },
    ]);

    const result = await new RecordAddressRepairService({
      recordLinks: store,
      lookup,
      scopeLinks: new FakeScopeLinkReader(),
    }).repairConfirmedBinding(giteaBinding(), GITEA);

    expect(result.outcomes).toEqual([{ kind: "ambiguous", linkId: "ambiguous", side: "A" }]);
    expect((await store.getById("ambiguous"))?.appARecordAddress).toBeUndefined();
  });
});
