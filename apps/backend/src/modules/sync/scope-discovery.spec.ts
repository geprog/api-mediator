import type {
  ApiSpec,
  AuditLogEntry,
  IrResourceGroup,
  RegisteredApp,
  ResourceBinding,
  ScopeContainerRef,
  ScopeCorrespondence,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import {
  FakeScopeLinkStore,
  FakeSyncEventRecorder,
  formatAmbiguousContainerDetails,
  ScopeDiscoveryStage,
  type MatchedTargetRecord,
  type TargetFetchResult,
  type TargetIdentityLookup,
} from "@mediator/sync-engine";
import type { CapturedScope } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import {
  RepoContainerParkReader,
  RepoScopeContainerEnumerator,
  ScopeDiscoveryService,
  type ContainerParkAuditReader,
  type EnumeratedContainers,
  type ScopeContainerEnumerator,
} from "./scope-discovery.js";

/**
 * Unit tests for the SS-11 scope-discovery adapter/service — the enablement (both-
 * enumerable) pass, the harvest path, on-demand resolution, and the constant/manual
 * establish. The pure matching invariants are proven at the engine level; these cover
 * the adapter's enumeration + signature assembly + fail-closed reasons.
 */

const T0 = new Date("2026-07-18T00:00:00.000Z");
const SOURCE_APP = "app-gitea";
const TARGET_APP = "app-vikunja";
const PAIR = `${SOURCE_APP}:issues|${TARGET_APP}:tasks`;

function correspondence(overrides: Partial<ScopeCorrespondence> = {}): ScopeCorrespondence {
  return {
    id: "corr-1",
    resourcePairRef: PAIR,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: TARGET_APP, resourceRef: "projects" },
    sourceContainerRef: undefined,
    confirmedBy: "operator@example.test",
    confirmedAt: T0,
    ...overrides,
  };
}

/** A fake enumerator keyed by resourceRef → the containers to return. */
class FakeEnumerator implements ScopeContainerEnumerator {
  readonly #byResource = new Map<string, EnumeratedContainers | undefined>();

  public set(resourceRef: string, value: EnumeratedContainers | undefined): void {
    this.#byResource.set(resourceRef, value);
  }

  public enumerate(ref: ScopeContainerRef): Promise<EnumeratedContainers | undefined> {
    return Promise.resolve(this.#byResource.get(ref.resourceRef));
  }
}

function targetContainers(
  records: readonly { nativeId: string; title: string }[],
): EnumeratedContainers {
  return {
    complete: true,
    containers: records.map((r) => ({
      nativeId: r.nativeId,
      record: { id: r.nativeId, title: r.title },
    })),
    nativeIdKeyName: "id",
  };
}

function makeService(deps: {
  enumerator: ScopeContainerEnumerator;
  links?: FakeScopeLinkStore;
  correspondence?: ScopeCorrespondence | undefined;
  repos?: ConstructorParameters<typeof RepoScopeContainerEnumerator>[0];
}): { service: ScopeDiscoveryService; links: FakeScopeLinkStore; events: FakeSyncEventRecorder } {
  const links = deps.links ?? new FakeScopeLinkStore();
  const events = new FakeSyncEventRecorder();
  let counter = 0;
  const stage = new ScopeDiscoveryStage(
    { links, events },
    { clock: (): Date => T0, newId: (): string => `id-${String((counter += 1))}` },
  );
  const corr =
    deps.correspondence === undefined && !("correspondence" in deps)
      ? correspondence()
      : deps.correspondence;
  const service = new ScopeDiscoveryService({
    stage,
    links,
    enumerator: deps.enumerator,
    correspondences: {
      getByResourcePair: (): Promise<ScopeCorrespondence | undefined> => Promise.resolve(corr),
    },
    repos: deps.repos ?? emptyRepos(),
  });
  return { service, links, events };
}

function emptyRepos(): ConstructorParameters<typeof RepoScopeContainerEnumerator>[0] {
  return {
    apiSpecs: { listByAppId: (): Promise<ApiSpec[]> => Promise.resolve([]) },
    resourceBindings: { listByApiSpecId: (): Promise<ResourceBinding[]> => Promise.resolve([]) },
    registeredApps: {
      getById: (): Promise<RegisteredApp | undefined> => Promise.resolve(undefined),
    },
  };
}

describe("SS-11.3 harvestFromCapturedScopes", () => {
  it("matches harvested source scopes to enumerated target containers, establishing identity-match links", async () => {
    const enumerator = new FakeEnumerator();
    enumerator.set(
      "projects",
      targetContainers([
        { nativeId: "42", title: "phoenix" },
        { nativeId: "43", title: "atlas" },
      ]),
    );
    const { service, links } = makeService({ enumerator });

    const captured: CapturedScope[] = [
      { owner: "alice", name: "phoenix" },
      { owner: "bob", name: "atlas" },
      { owner: "carol", name: "orphan" }, // no target → unresolved
    ];
    const outcome = await service.harvestFromCapturedScopes(PAIR, captured);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result.established).toHaveLength(2);
      expect(outcome.result.unresolved).toStrictEqual([{ owner: "carol", name: "orphan" }]);
    }
    expect(links.all()).toHaveLength(2);
    // The target's addressing key is stored under its native-id component name.
    const linkForPhoenix = await links.lookupByScopeKey(PAIR, {
      appId: TARGET_APP,
      scopeKey: { id: "42" },
    });
    expect(linkForPhoenix?.appAScopeKey).toStrictEqual({ owner: "alice", name: "phoenix" });
  });

  it("parks an ambiguous harvested scope (two target containers share the identity value)", async () => {
    const enumerator = new FakeEnumerator();
    enumerator.set(
      "projects",
      targetContainers([
        { nativeId: "42", title: "dup" },
        { nativeId: "43", title: "dup" },
      ]),
    );
    const { service, links, events } = makeService({ enumerator });

    const outcome = await service.harvestFromCapturedScopes(PAIR, [
      { owner: "alice", name: "dup" },
    ]);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result.ambiguous).toHaveLength(1);
      expect(outcome.result.established).toHaveLength(0);
    }
    expect(links.all()).toHaveLength(0);
    expect(events.all().some((e) => e.status === "failure")).toBe(true);
  });

  it("aborts on an incomplete target fetch (never mass-anything on a partial read)", async () => {
    const enumerator = new FakeEnumerator();
    enumerator.set("projects", { complete: false, containers: [], nativeIdKeyName: "id" });
    const { service, links } = makeService({ enumerator });
    const outcome = await service.harvestFromCapturedScopes(PAIR, [
      { owner: "alice", name: "phoenix" },
    ]);
    expect(outcome).toStrictEqual({ kind: "incomplete-fetch", side: "target" });
    expect(links.all()).toHaveLength(0);
  });

  it("reports not-confirmed / not-scoped without touching the apps", async () => {
    const enumerator = new FakeEnumerator();
    const unconfirmed = makeService({
      enumerator,
      correspondence: correspondence({ confirmedBy: null, confirmedAt: null }),
    });
    expect((await unconfirmed.service.harvestFromCapturedScopes(PAIR, [])).kind).toBe(
      "not-confirmed",
    );

    const notScoped = makeService({ enumerator, correspondence: undefined });
    expect((await notScoped.service.harvestFromCapturedScopes(PAIR, [])).kind).toBe("not-scoped");
  });
});

describe("SS-11.4 resolveContainerOnDemand", () => {
  it("short-circuits on an existing active link (no target enumeration)", async () => {
    const links = new FakeScopeLinkStore();
    const enumerator = new FakeEnumerator(); // deliberately returns undefined for projects
    const { service } = makeService({ enumerator, links });
    // Pre-establish a constant link.
    await service.establishConstantLink(
      PAIR,
      SOURCE_APP,
      { owner: "alice", name: "phoenix" },
      TARGET_APP,
      { id: "42" },
    );

    const outcome = await service.resolveContainerOnDemand(PAIR, {
      owner: "alice",
      name: "phoenix",
    });
    expect(outcome.kind).toBe("resolution");
    if (outcome.kind === "resolution") {
      expect(outcome.outcome.kind).toBe("resolved");
      expect(outcome.outcome.kind === "resolved" && outcome.outcome.establishedNow).toBe(false);
    }
  });

  it("establishes a link inline on a single target match", async () => {
    const enumerator = new FakeEnumerator();
    enumerator.set("projects", targetContainers([{ nativeId: "42", title: "phoenix" }]));
    const { service, links } = makeService({ enumerator });
    const outcome = await service.resolveContainerOnDemand(PAIR, {
      owner: "alice",
      name: "phoenix",
    });
    expect(outcome.kind === "resolution" && outcome.outcome.kind).toBe("resolved");
    expect(links.all()).toHaveLength(1);
  });

  it("parks an unresolvable record (no target match) — never a guessed container", async () => {
    const enumerator = new FakeEnumerator();
    enumerator.set("projects", targetContainers([{ nativeId: "42", title: "phoenix" }]));
    const { service, links, events } = makeService({ enumerator });
    const outcome = await service.resolveContainerOnDemand(PAIR, {
      owner: "carol",
      name: "orphan",
    });
    expect(outcome.kind === "resolution" && outcome.outcome.kind).toBe("unresolvable");
    expect(links.all()).toHaveLength(0);
    expect(events.all().some((e) => e.status === "failure")).toBe(true);
  });

  it("fails closed on an unusable captured scope", async () => {
    const enumerator = new FakeEnumerator();
    const { service } = makeService({ enumerator });
    expect((await service.resolveContainerOnDemand(PAIR, { owner: "alice" })).kind).toBe(
      "unusable-scope",
    );
  });
});

describe("SS-11.1 / SS-11.6 establish / link / unlink", () => {
  it("establishes a constant link and severs a manual one", async () => {
    const enumerator = new FakeEnumerator();
    const { service, links } = makeService({ enumerator });

    const constant = await service.establishConstantLink(
      PAIR,
      SOURCE_APP,
      { owner: "alice", name: "phoenix" },
      TARGET_APP,
      { id: "42" },
    );
    expect(constant.kind === "established" && constant.result.kind).toBe("created");
    expect(links.all()[0]?.establishedBy).toBe("constant");

    const manual = await service.linkContainers(
      PAIR,
      SOURCE_APP,
      { owner: "bob", name: "atlas" },
      TARGET_APP,
      { id: "43" },
    );
    const linkId =
      manual.kind === "established" && manual.result.kind === "created"
        ? manual.result.link.id
        : "";
    expect(links.all().find((l) => l.id === linkId)?.establishedBy).toBe("manual");

    // Unlink ARCHIVES (never deletes): both rows survive; the manual one is archived, the
    // constant one stays active.
    expect(await service.unlinkContainer(linkId)).toBe(true);
    expect(links.all()).toHaveLength(2);
    expect(links.all().find((l) => l.id === linkId)?.status).toBe("archived");
    expect(links.all().filter((l) => l.status === "active")).toHaveLength(1);
  });

  it("reports not-scoped when the pair has no ScopeCorrespondence", async () => {
    const enumerator = new FakeEnumerator();
    const { service } = makeService({ enumerator, correspondence: undefined });
    expect(
      (
        await service.establishConstantLink(PAIR, SOURCE_APP, { name: "x" }, TARGET_APP, {
          id: "1",
        })
      ).kind,
    ).toBe("not-scoped");
  });
});

// ── RepoScopeContainerEnumerator (resolves a container ref + delegates to fetchAll) ──

class StubLookup implements TargetIdentityLookup {
  public constructor(private readonly result: TargetFetchResult) {}
  public filteredRead(): Promise<readonly MatchedTargetRecord[]> {
    return Promise.resolve([]);
  }
  public fetchAll(): Promise<TargetFetchResult> {
    return Promise.resolve(this.result);
  }
}

function containerGroup(resourceRef: string): IrResourceGroup {
  return {
    resourceRef,
    name: resourceRef,
    operations: [{ operationId: "listProjects", method: "get", path: "/projects", parameters: [] }],
    schemas: [],
    crossResourceRefs: [],
  };
}

function containerBinding(resourceRef: string): ResourceBinding {
  return stripUndefined({
    id: `rb-${resourceRef}`,
    apiSpecId: `spec-${resourceRef}`,
    resourceRef,
    nativeIdRef: {
      value: { kind: "field" as const, path: "id" },
      confirmedBy: "op",
      confirmedAt: T0,
    },
    collectionReadRef: {
      value: { kind: "operation" as const, operationId: "listProjects" },
      confirmedBy: "op",
      confirmedAt: T0,
    },
    scopePathBindings: [],
  });
}

function containerSpec(resourceRef: string): ApiSpec {
  return {
    id: `spec-${resourceRef}`,
    appId: TARGET_APP,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR: [containerGroup(resourceRef)],
    analysisExclusions: [],
    version: 1,
    contentHash: "hash",
    status: "active",
    createdAt: T0,
  };
}

function containerRepos(fetch: TargetFetchResult): {
  repos: ConstructorParameters<typeof RepoScopeContainerEnumerator>[0];
  lookup: TargetIdentityLookup;
} {
  return {
    repos: {
      apiSpecs: {
        listByAppId: (): Promise<ApiSpec[]> => Promise.resolve([containerSpec("projects")]),
      },
      resourceBindings: {
        listByApiSpecId: (): Promise<ResourceBinding[]> =>
          Promise.resolve([containerBinding("projects")]),
      },
      registeredApps: {
        getById: (): Promise<RegisteredApp | undefined> =>
          Promise.resolve({
            id: TARGET_APP,
            name: TARGET_APP,
            status: "active",
            baseUrl: `https://${TARGET_APP}`,
            capabilities: {
              supportsPolling: true,
              supportsDeltaQuery: false,
              supportsChangeTimestamps: false,
              defaultPollInterval: 60_000,
            },
            createdAt: T0,
          }),
      },
    },
    lookup: new StubLookup(fetch),
  };
}

describe("RepoScopeContainerEnumerator", () => {
  const ref: ScopeContainerRef = { appId: TARGET_APP, resourceRef: "projects" };

  it("resolves the container collection read and returns containers + native-id key name", async () => {
    const { repos, lookup } = containerRepos({
      complete: true,
      records: [{ nativeId: "42", record: { id: "42", title: "phoenix" } }],
    });
    const enumerator = new RepoScopeContainerEnumerator(repos, lookup);
    const result = await enumerator.enumerate(ref);
    expect(result?.complete).toBe(true);
    expect(result?.nativeIdKeyName).toBe("id");
    expect(result?.containers).toHaveLength(1);
  });

  it("propagates an incomplete (abort-on-partial) fetch", async () => {
    const { repos, lookup } = containerRepos({ complete: false });
    const enumerator = new RepoScopeContainerEnumerator(repos, lookup);
    const result = await enumerator.enumerate(ref);
    expect(result?.complete).toBe(false);
    expect(result?.containers).toHaveLength(0);
  });

  it("returns undefined when the container resource does not resolve", async () => {
    const { lookup } = containerRepos({ complete: true, records: [] });
    const enumerator = new RepoScopeContainerEnumerator(emptyRepos(), lookup);
    expect(await enumerator.enumerate(ref)).toBeUndefined();
  });
});

// ── RepoContainerParkReader (SS-11.7 park dedup source of truth) ──────────────

describe("RepoContainerParkReader", () => {
  const SCOPE = { owner: "alice", name: "dup" };

  function parkEvent(id: string, scopeKey: Record<string, string>): AuditLogEntry {
    return {
      id,
      type: "sync-execution",
      actor: "system",
      status: "failure",
      timestamp: T0,
      details: formatAmbiguousContainerDetails({
        resourcePairRef: PAIR,
        sourceAppId: SOURCE_APP,
        sourceScopeKey: scopeKey,
        candidateNativeIds: ["42", "43"],
      }),
    };
  }

  function auditReturning(events: readonly AuditLogEntry[]): ContainerParkAuditReader {
    return { querySyncEvents: (): Promise<AuditLogEntry[]> => Promise.resolve([...events]) };
  }

  it("returns the open park's event id for a matching (pair, scope key) with no covering active link", async () => {
    const reader = new RepoContainerParkReader(
      auditReturning([parkEvent("evt-1", SCOPE)]),
      new FakeScopeLinkStore(),
    );
    expect(await reader.findOpenContainerPark(PAIR, SCOPE)).toBe("evt-1");
    // A different scope key / pair does not match.
    expect(await reader.findOpenContainerPark(PAIR, { owner: "x", name: "y" })).toBeUndefined();
  });

  it("treats a park as RESOLVED (not open) once an active ScopeLink covers its scope", async () => {
    const links = new FakeScopeLinkStore();
    // An active link now covers the source container the park was recorded for.
    await links.establish({
      id: "link-1",
      scopeCorrespondenceId: "corr-1",
      appAId: SOURCE_APP,
      appAScopeKey: SCOPE,
      appBId: TARGET_APP,
      appBScopeKey: { id: "42" },
      resourcePairRef: PAIR,
      establishedBy: "manual",
      status: "active",
      createdAt: T0,
    });
    const reader = new RepoContainerParkReader(auditReturning([parkEvent("evt-1", SCOPE)]), links);
    expect(await reader.findOpenContainerPark(PAIR, SCOPE)).toBeUndefined();
  });

  it("ignores non-container-park failure events", async () => {
    const nonContainer: AuditLogEntry = {
      id: "evt-x",
      type: "sync-execution",
      actor: "system",
      status: "failure",
      timestamp: T0,
      details: "ambiguous identity match: 2 candidates [a, b]",
    };
    const reader = new RepoContainerParkReader(
      auditReturning([nonContainer]),
      new FakeScopeLinkStore(),
    );
    expect(await reader.findOpenContainerPark(PAIR, SCOPE)).toBeUndefined();
  });
});
