import type { WithCredentialResult } from "@mediator/credentials";
import {
  AppLoadGovernor,
  type CredentialAccess,
  type OutboundRequest,
  type OutboundResponse,
  type ProtocolClient,
  type RestSourceReadBinding,
} from "@mediator/outbound";
import type { FilteredReadRequest, TargetReadBinding } from "@mediator/sync-engine";
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
