import type { OutboundLoadLimits } from "@mediator/domain";
import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import { describe, expect, it } from "vitest";

import type { CredentialAccess, CredentialApplier } from "./executor.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import {
  RestSourceReader,
  type RestSourceBindingResolver,
  type RestSourceReadBinding,
} from "./rest-source-reader.js";

/**
 * Unit tests for {@link RestSourceReader} (SP-2.4): source reads obey the **same OC-3
 * per-app ceilings as writes** (a slot is reserved on the shared `AppLoadGovernor`,
 * released after, and a `429`/`Retry-After` penalizes the app), page to exhaustion, and
 * **abort** (never a silently-empty page) on any transport/HTTP/parse fault — so a
 * truncated read can never masquerade as an empty collection (SP-4). Driven by a fake
 * `ProtocolClient` (no network) + a real `AppLoadGovernor`.
 */

const APP = "app-source";
const APPLY_CREDENTIAL: CredentialApplier = (headers) => ({
  ...headers,
  authorization: "Bearer test-token",
});

class FakeProtocolClient implements ProtocolClient {
  public readonly requests: OutboundRequest[] = [];
  readonly #responder: (request: OutboundRequest) => OutboundResponse;

  public constructor(responder: (request: OutboundRequest) => OutboundResponse) {
    this.#responder = responder;
  }

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    this.requests.push(request);
    try {
      return Promise.resolve(this.#responder(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

class FakeCredentialAccess implements CredentialAccess {
  public readonly calls: string[] = [];
  readonly #mode: "invoked" | "no-credential";

  public constructor(mode: "invoked" | "no-credential" = "invoked") {
    this.#mode = mode;
  }

  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    this.calls.push(appId);
    if (this.#mode === "no-credential") {
      return { outcome: "no-credential" };
    }
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "k" };
    const value = await fn({ credentialId: "c", type: "apiKey", scopes: [], secret });
    return { outcome: "invoked", value };
  }
}

function binding(overrides: Partial<RestSourceReadBinding> = {}): RestSourceReadBinding {
  return {
    sourceAppId: APP,
    baseUrl: "https://api.test",
    method: "GET",
    path: "/customers",
    nativeIdPath: "id",
    recordsPath: "items",
    pagination: { kind: "single-page" },
    ...overrides,
  };
}

class FixedBindingResolver implements RestSourceBindingResolver {
  public constructor(private readonly value: RestSourceReadBinding | undefined) {}
  public resolve(): Promise<RestSourceReadBinding | undefined> {
    return Promise.resolve(this.value);
  }
}

function reader(
  b: RestSourceReadBinding,
  protocol: ProtocolClient,
  governor: AppLoadGovernor,
  credentials: CredentialAccess = new FakeCredentialAccess(),
  now: () => Date = () => new Date("2026-07-13T12:00:00.000Z"),
): RestSourceReader {
  return new RestSourceReader(new FixedBindingResolver(b), protocol, credentials, governor, {
    applyCredential: APPLY_CREDENTIAL,
    now,
  });
}

const RATE_LIMITED: OutboundLoadLimits = {
  maxConcurrentRequests: 5,
  maxRequestsPerWindow: 1,
  rateWindowMs: 10_000,
};

describe("RestSourceReader — SP-2.4 reads obey OC-3", () => {
  it("reserves and RELEASES a governor slot per read (in-flight back to 0)", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [] },
    }));
    const r = reader(
      binding({
        limits: { maxConcurrentRequests: 1, maxRequestsPerWindow: 100, rateWindowMs: 10_000 },
      }),
      protocol,
      governor,
    );

    await r.readCollectionPage("rule-1", undefined);
    await r.readCollectionPage("rule-1", undefined);

    // Both calls went through (slot released between them) and nothing is left in flight.
    expect(protocol.requests).toHaveLength(2);
    expect(governor.inFlight(APP)).toBe(0);
  });

  it("aborts (never bypasses the governor) when the per-app rate ceiling is hit", async () => {
    const governor = new AppLoadGovernor({ now: () => 0 });
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [] },
    }));
    const r = reader(binding({ limits: RATE_LIMITED }), protocol, governor);

    const first = await r.readCollectionPage("rule-1", undefined);
    const second = await r.readCollectionPage("rule-1", undefined);

    expect(first.ok).toBe(true);
    // The second read is denied by the rate ceiling → abort (no HTTP call made for it).
    expect(second.ok).toBe(false);
    expect(protocol.requests).toHaveLength(1);
  });

  it("honors a 429/Retry-After: penalizes the app and aborts (does not re-hammer)", async () => {
    const governor = new AppLoadGovernor({ now: () => 0 });
    const protocol = new FakeProtocolClient(() => ({
      status: 429,
      headers: { "retry-after": "30" },
      body: undefined,
    }));
    const r = reader(binding(), protocol, governor);

    const first = await r.readCollectionPage("rule-1", undefined);
    expect(first.ok).toBe(false);
    // The next read is deferred by the active back-off — the app is not re-hammered.
    const second = await r.readCollectionPage("rule-1", undefined);
    expect(second.ok).toBe(false);
    expect(protocol.requests).toHaveLength(1);
  });

  it("applies the credential inside withCredential; falls back to unauthenticated on no-credential", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient((req) => {
      expect(req.headers.authorization).toBe("Bearer test-token");
      return { status: 200, headers: {}, body: { items: [] } };
    });
    const creds = new FakeCredentialAccess("invoked");
    await reader(binding(), protocol, governor, creds).readCollectionPage("rule-1", undefined);
    expect(creds.calls).toStrictEqual([APP]);

    const publicProtocol = new FakeProtocolClient((req) => {
      expect(req.headers.authorization).toBeUndefined();
      return { status: 200, headers: {}, body: { items: [] } };
    });
    const r = reader(
      binding(),
      publicProtocol,
      new AppLoadGovernor(),
      new FakeCredentialAccess("no-credential"),
    );
    const outcome = await r.readCollectionPage("rule-1", undefined);
    expect(outcome.ok).toBe(true);
  });
});

describe("RestSourceReader — SP-2 pagination + native-id extraction", () => {
  it("offset pagination: full page → more; short page → done; offset param in the URL", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient((req) => {
      const items = req.url.includes("offset=2") ? [{ id: "3" }] : [{ id: "1" }, { id: "2" }];
      return { status: 200, headers: {}, body: { items } };
    });
    const b = binding({
      pagination: { kind: "offset", offsetParam: "offset", limitParam: "limit", pageSize: 2 },
    });
    const r = reader(b, protocol, governor);

    const page1 = await r.readCollectionPage("rule-1", undefined);
    expect(page1.ok && page1.records.map((x) => x.nativeId)).toStrictEqual(["1", "2"]);
    expect(page1.ok && page1.next).toStrictEqual({ done: false, continuation: "2" });

    const page2 = await r.readCollectionPage("rule-1", "2");
    expect(page2.ok && page2.records.map((x) => x.nativeId)).toStrictEqual(["3"]);
    expect(page2.ok && page2.next).toStrictEqual({ done: true });
    expect(protocol.requests[1]?.url).toContain("offset=2");
    expect(protocol.requests[1]?.url).toContain("limit=2");
  });

  it("extracts native ids; a record missing its native id ABORTS (never a false-empty page)", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [{ id: "1" }, { name: "no-id" }] },
    }));
    const outcome = await reader(binding(), protocol, governor).readCollectionPage(
      "rule-1",
      undefined,
    );
    expect(outcome.ok).toBe(false);
  });

  it("a body whose records path is not an array ABORTS (SP-4 — not an empty page)", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: null },
    }));
    const outcome = await reader(binding(), protocol, governor).readCollectionPage(
      "rule-1",
      undefined,
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("RestSourceReader — SP-2/SP-3 delta + abort", () => {
  it("parses changed records, a deleted-ids list, and the next cursor", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [{ id: "1" }], removed: ["9", "8"], cursor: "c2" },
    }));
    const b = binding({
      delta: {
        cursorParam: "since",
        nextCursorPath: "cursor",
        deletion: { kind: "deleted-ids-list", path: "removed" },
      },
    });
    const outcome = await reader(b, protocol, governor).readDelta("rule-1", "c1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.records.map((x) => x.nativeId)).toStrictEqual(["1"]);
      expect(outcome.deletedNativeIds).toStrictEqual(["9", "8"]);
      expect(outcome.nextCursor).toBe("c2");
    }
  });

  it("marker-field deletion: splits changed vs deleted records by the marker", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: {
        items: [
          { id: "1", deleted: false },
          { id: "2", deleted: true },
        ],
        cursor: "c2",
      },
    }));
    const b = binding({
      delta: {
        cursorParam: "since",
        nextCursorPath: "cursor",
        deletion: { kind: "marker-field", markerPath: "deleted", deletedWhenEquals: true },
      },
    });
    const outcome = await reader(b, protocol, governor).readDelta("rule-1", "c1");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.records.map((x) => x.nativeId)).toStrictEqual(["1"]);
      expect(outcome.deletedNativeIds).toStrictEqual(["2"]);
    }
  });

  it("a transport throw and a 5xx both abort the read", async () => {
    const governor = new AppLoadGovernor();
    const thrower = new FakeProtocolClient(() => {
      throw new Error("ECONNRESET");
    });
    const throwOutcome = await reader(binding(), thrower, governor).readCollectionPage(
      "rule-1",
      undefined,
    );
    expect(throwOutcome.ok).toBe(false);

    const fiveHundred = new FakeProtocolClient(() => ({
      status: 503,
      headers: {},
      body: undefined,
    }));
    const httpOutcome = await reader(
      binding(),
      fiveHundred,
      new AppLoadGovernor(),
    ).readCollectionPage("rule-1", undefined);
    expect(httpOutcome.ok).toBe(false);
  });
});
