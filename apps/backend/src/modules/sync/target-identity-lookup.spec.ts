import type { WithCredentialResult } from "@mediator/credentials";
import {
  AppLoadGovernor,
  type CredentialAccess,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
  type RestSourceReadBinding,
} from "@mediator/outbound";
import type {
  FetchAllRequest,
  FilteredReadRequest,
  TargetReadBinding,
} from "@mediator/sync-engine";
import { describe, expect, it } from "vitest";

import {
  RestTargetIdentityLookup,
  type ResolvedTargetCollectionRead,
  type TargetCollectionReadResolver,
} from "./target-identity-lookup.js";

/**
 * Fail-closed coverage for the target identity filtered read (SHOULD-FIX #3): a confirmed
 * `targetLookupParamRef` that is NOT a query-location parameter must never be sent as an
 * ignored query param over an otherwise-unfiltered read — which would return the target's
 * unfiltered first record and mis-route a single-record match RL-4 cannot catch. The read
 * must refuse (throw) BEFORE issuing any request.
 */

const WIRE: RestSourceReadBinding = {
  sourceAppId: "app-b",
  baseUrl: "https://app-b.test",
  method: "GET",
  path: "/widgets",
  nativeIdPath: "id",
  pagination: { kind: "single-page" },
};

const BINDING: TargetReadBinding = { collectionReadOperationId: "listWidgets", nativeIdPath: "id" };

const REQUEST: FilteredReadRequest = {
  targetAppId: "app-b",
  binding: BINDING,
  lookupParamRef: "widgets/listWidgets#code",
  value: "W-100",
};

class RecordingProtocol implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];
  public constructor(private readonly body: OutboundResponse["body"]) {}
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    return Promise.resolve({ status: 200, headers: {}, body: this.body });
  }
}

const NO_CREDENTIAL: CredentialAccess = {
  withCredential: <T>(): Promise<WithCredentialResult<T>> =>
    Promise.resolve({ outcome: "no-credential" }),
};

function resolverWith(location: "query" | "path"): TargetCollectionReadResolver {
  const resolved: ResolvedTargetCollectionRead = {
    binding: WIRE,
    parameters: [{ name: "code", location, required: false, type: "string" }],
  };
  return { resolve: (): Promise<ResolvedTargetCollectionRead> => Promise.resolve(resolved) };
}

function lookupOf(
  resolver: TargetCollectionReadResolver,
  protocol: ProtocolClient,
): RestTargetIdentityLookup {
  return new RestTargetIdentityLookup(resolver, protocol, NO_CREDENTIAL, new AppLoadGovernor(), {
    applyCredential: (headers) => ({ ...headers }),
  });
}

describe("RestTargetIdentityLookup.filteredRead — fail closed on a non-query filter param", () => {
  it("refuses (throws) and issues NO request when the lookup param is not query-located", async () => {
    const protocol = new RecordingProtocol([{ id: "b1", code: "W-100" }]);
    const lookup = lookupOf(resolverWith("path"), protocol);

    await expect(lookup.filteredRead(REQUEST)).rejects.toThrow(
      /does not resolve to a query parameter/,
    );
    // The critical assertion: no unfiltered read was issued (which would mis-match).
    expect(protocol.requests).toHaveLength(0);
  });

  it("issues the filtered read (query param) when the lookup param IS query-located", async () => {
    const protocol = new RecordingProtocol([{ id: "b1", code: "W-100" }]);
    const lookup = lookupOf(resolverWith("query"), protocol);

    const matches = await lookup.filteredRead(REQUEST);

    expect(protocol.requests).toHaveLength(1);
    expect(protocol.requests[0]?.url).toContain("code=W-100");
    expect(matches).toStrictEqual([{ nativeId: "b1", record: { id: "b1", code: "W-100" } }]);
  });
});

/**
 * SS-14.1 — a scoped identity lookup fills the target collection read's **container** path
 * parameter from the resolved `ScopeLink`, so it searches **only within** that container.
 * Proven container-local: two projects each hold a task titled "Bug", and a scoped read for
 * project 42 returns **only** project 42's task — never project 99's (no cross-match).
 */
const TASK_BINDING: TargetReadBinding = {
  collectionReadOperationId: "listTasks",
  nativeIdPath: "id",
};

/** Returns each project's own tasks, keyed off the container the URL addresses. */
class ContainerProtocol implements ProtocolClient {
  public readonly urls: string[] = [];
  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.urls.push(request.url);
    const body = request.url.includes("/projects/42/")
      ? [{ id: "t42", title: "Bug" }]
      : request.url.includes("/projects/99/")
        ? [{ id: "t99", title: "Bug" }]
        : [];
    return Promise.resolve({ status: 200, headers: {}, body });
  }
}

/** Models `RepoTargetCollectionReadResolver`: fills `/projects/{id}/tasks` from the containerScope. */
class ContainerResolver implements TargetCollectionReadResolver {
  public lastContainerScope: ReadonlyMap<string, string> | undefined = undefined;
  public resolve(
    targetAppId: string,
    _binding: TargetReadBinding,
    containerScope?: ReadonlyMap<string, string>,
  ): Promise<ResolvedTargetCollectionRead | undefined> {
    this.lastContainerScope = containerScope;
    const id = containerScope?.get("id");
    if (id === undefined) {
      // SS-14.1 fail-closed: an unfilled container param → the binding does not resolve.
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      binding: {
        sourceAppId: targetAppId,
        baseUrl: "https://app-b.test",
        method: "GET",
        path: `/projects/${id}/tasks`,
        nativeIdPath: "id",
        pagination: { kind: "single-page" },
      },
      parameters: [{ name: "title", location: "query", required: false, type: "string" }],
    });
  }
}

describe("RestTargetIdentityLookup — SS-14.1 container-scoped read", () => {
  it("filteredRead fills the container path from the ScopeLink and matches ONLY within it", async () => {
    const protocol = new ContainerProtocol();
    const resolver = new ContainerResolver();
    const lookup = lookupOf(resolver, protocol);

    const matches = await lookup.filteredRead({
      targetAppId: "app-b",
      binding: TASK_BINDING,
      lookupParamRef: "tasks/listTasks#title",
      value: "Bug",
      containerScope: new Map([["id", "42"]]),
    });

    // Searched ONLY within project 42 — never a global read, never project 99's "Bug".
    expect(resolver.lastContainerScope).toStrictEqual(new Map([["id", "42"]]));
    expect(protocol.urls[0]).toContain("/projects/42/tasks");
    expect(matches).toStrictEqual([{ nativeId: "t42", record: { id: "t42", title: "Bug" } }]);
  });

  it("fetch-and-match enumerates ONLY the resolved container, never globally", async () => {
    const protocol = new ContainerProtocol();
    const lookup = lookupOf(new ContainerResolver(), protocol);

    const request: FetchAllRequest = {
      targetAppId: "app-b",
      binding: TASK_BINDING,
      containerScope: new Map([["id", "99"]]),
    };
    const result = await lookup.fetchAll(request);

    expect(protocol.urls[0]).toContain("/projects/99/tasks");
    expect(result).toStrictEqual({
      complete: true,
      records: [{ nativeId: "t99", record: { id: "t99", title: "Bug" } }],
    });
  });

  it("fail-closed: a scoped read with NO resolved container issues no request", async () => {
    const protocol = new ContainerProtocol();
    const lookup = lookupOf(new ContainerResolver(), protocol);

    // fetch-and-match: an unresolved binding aborts (never a fabricated empty "no match").
    const result = await lookup.fetchAll({ targetAppId: "app-b", binding: TASK_BINDING });
    expect(result).toStrictEqual({ complete: false });

    // filtered-read: refuses (throws) rather than an unscoped global read.
    await expect(
      lookup.filteredRead({
        targetAppId: "app-b",
        binding: TASK_BINDING,
        lookupParamRef: "tasks/listTasks#title",
        value: "Bug",
      }),
    ).rejects.toThrow(/did not resolve/);
    expect(protocol.urls).toHaveLength(0);
  });
});
