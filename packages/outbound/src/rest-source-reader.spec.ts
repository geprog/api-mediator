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
  it("offset pagination: pages until an EMPTY page (a short non-empty page is NOT the end)", async () => {
    const governor = new AppLoadGovernor();
    // Page at offset 2 returns 1 record (a short, non-empty page) — the read must NOT
    // stop there; only the empty page at offset 3 ends it.
    const protocol = new FakeProtocolClient((req) => {
      if (req.url.includes("offset=3")) return { status: 200, headers: {}, body: { items: [] } };
      if (req.url.includes("offset=2"))
        return { status: 200, headers: {}, body: { items: [{ id: "3" }] } };
      return { status: 200, headers: {}, body: { items: [{ id: "1" }, { id: "2" }] } };
    });
    const b = binding({
      pagination: { kind: "offset", offsetParam: "offset", limitParam: "limit", pageSize: 2 },
    });
    const r = reader(b, protocol, governor);

    const page1 = await r.readCollectionPage("rule-1", undefined);
    expect(page1.ok && page1.records.map((x) => x.nativeId)).toStrictEqual(["1", "2"]);
    expect(page1.ok && page1.next).toStrictEqual({ done: false, continuation: "2" });

    // The short page (1 record) advances offset by the ACTUAL count (2 + 1 = 3), NOT by
    // pageSize, and is NOT treated as done.
    const page2 = await r.readCollectionPage("rule-1", "2");
    expect(page2.ok && page2.records.map((x) => x.nativeId)).toStrictEqual(["3"]);
    expect(page2.ok && page2.next).toStrictEqual({ done: false, continuation: "3" });
    expect(protocol.requests[1]?.url).toContain("offset=2");
    expect(protocol.requests[1]?.url).toContain("limit=2");

    const page3 = await r.readCollectionPage("rule-1", "3");
    expect(page3.ok && page3.records).toStrictEqual([]);
    expect(page3.ok && page3.next).toStrictEqual({ done: true });
  });

  it("clamped pages (server returns fewer than the requested pageSize) enumerate ALL records with no truncation or skip", async () => {
    const governor = new AppLoadGovernor();
    // The rule requests pageSize=100, but the server CLAMPS every full page to 50 records
    // — the real-Vikunja `per_page` cap. 120 records total: 50 + 50 + 20, then empty.
    const all = Array.from({ length: 120 }, (_v, i) => ({ id: String(i) }));
    const protocol = new FakeProtocolClient((req) => {
      const match = /offset=(\d+)/.exec(req.url);
      const offset = match?.[1] !== undefined ? Number(match[1]) : 0;
      // A "full" page is clamped to 50; the tail (100..119) is 20; past the end is empty.
      return { status: 200, headers: {}, body: { items: all.slice(offset, offset + 50) } };
    });
    const b = binding({
      pagination: { kind: "offset", offsetParam: "offset", limitParam: "limit", pageSize: 100 },
    });
    const r = reader(b, protocol, governor);

    // Drive the paging loop exactly as the Poller does, following the reader's own token.
    const collected: string[] = [];
    let continuation: string | undefined;
    for (let guard = 0; guard < 1000; guard += 1) {
      const page = await r.readCollectionPage("rule-1", continuation);
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      collected.push(...page.records.map((x) => x.nativeId));
      if (page.next.done) break;
      continuation = page.next.continuation;
    }

    // Every record enumerated exactly once (no truncation at page 1, no skip of 50..99),
    // and the loop terminated on the empty page.
    expect(collected).toEqual(all.map((x) => x.id));
    expect(new Set(collected).size).toBe(120);
    // Offsets requested: 0, 50, 100 (full/clamped pages), then 120 = 100 + the ACTUAL 20
    // returned (NOT 100 + pageSize 100) — the empty terminator. Advancing by pageSize
    // would have jumped to offset 200 and skipped records 120..199 had they existed.
    expect(protocol.requests.map((req) => /offset=(\d+)/.exec(req.url)?.[1])).toEqual([
      "0",
      "50",
      "100",
      "120",
    ]);
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

describe("RestSourceReader — SS-4.5 backstop: an unfilled scope path parameter is never sent", () => {
  it("aborts a collection read whose path still carries a literal {owner}/{repo} (no request, no false-empty page)", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [] },
    }));
    // A scoped Gitea poll whose confirmed constants were (hypothetically) not substituted:
    // the source read has NO record-id template, so `{owner}`/`{repo}` are genuinely-unfilled
    // scope params — the reader must refuse rather than fetch `/repos/{owner}/{repo}/issues`.
    const outcome = await reader(
      binding({ path: "/repos/{owner}/{repo}/issues" }),
      protocol,
      governor,
    ).readCollectionPage("rule-1", undefined);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain("{owner}");
    }
    // The literal `{owner}` never went on the wire — an empty page would be misread as mass deletion.
    expect(protocol.requests).toHaveLength(0);
  });

  it("aborts a delta read with an unfilled scope param too", async () => {
    const governor = new AppLoadGovernor();
    const protocol = new FakeProtocolClient(() => ({
      status: 200,
      headers: {},
      body: { items: [] },
    }));
    const outcome = await reader(
      binding({
        path: "/repos/{owner}/{repo}/issues",
        delta: { cursorParam: "since", nextCursorPath: "since" },
      }),
      protocol,
      governor,
    ).readDelta("rule-1", "c1");

    expect(outcome.ok).toBe(false);
    expect(protocol.requests).toHaveLength(0);
  });
});
