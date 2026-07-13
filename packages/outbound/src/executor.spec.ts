import type { AuditLogEntry, IrRefTarget, OperationMapping } from "@mediator/domain";
import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import type { JsonRecord } from "@mediator/transform";
import { TransformError } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import {
  OutboundCallExecutor,
  type CredentialAccess,
  type OutboundCall,
  type OutboundCallCommon,
} from "./executor.js";
import { computeWriteIdempotencyKey } from "./idempotency.js";
import { AppLoadGovernor } from "./load-governor.js";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "./protocol-client.js";
import { FakeSyncEventStore } from "./sync-event-store.js";

/**
 * OC-1 / OC-2 / OC-3 / OC-4 / OC-5 — the Outbound Call Executor over a fake
 * `ProtocolClient` (no network) + fake `CredentialAccess` + `FakeSyncEventStore`.
 * Deterministic: injected clock + trace context.
 */

const NOW = new Date("2026-07-13T00:00:00.000Z");
const TRACE = { traceId: "trace-abc", spanId: "span-def" };
const SECRET_APIKEY = "SUPER-SECRET-APIKEY";
const LIVE_PAYLOAD_VALUE = "123-45-6789";
const NATIVE_ID_REF: IrRefTarget = { kind: "field", path: "id" };

// ── Fakes ─────────────────────────────────────────────────────────────────────

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
  readonly #mode: "invoked" | "no-credential" | "refresh-failure";
  readonly #secret: UsableCredentialSecret;

  public constructor(
    mode: "invoked" | "no-credential" | "refresh-failure",
    secret: UsableCredentialSecret = { type: "apiKey", apiKey: SECRET_APIKEY },
  ) {
    this.#mode = mode;
    this.#secret = secret;
  }

  public async withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>> {
    this.calls.push(appId);
    if (this.#mode === "no-credential") {
      return { outcome: "no-credential" };
    }
    if (this.#mode === "refresh-failure") {
      return { outcome: "credential-refresh-failure", reason: "token revoked" };
    }
    const value = await fn({
      credentialId: "cred-1",
      type: "apiKey",
      scopes: [],
      secret: this.#secret,
    });
    return { outcome: "invoked", value };
  }
}

// ── Builders ───────────────────────────────────────────────────────────────────

function common(overrides: Partial<OutboundCallCommon> = {}): OutboundCallCommon {
  return {
    targetAppId: "app-B",
    baseUrl: "https://api.test",
    targetResourceNativeIdRef: NATIVE_ID_REF,
    relatedRuleId: "rule-1",
    recordLinkId: "link-1",
    operation: { method: "POST", pathTemplate: "/customers", parameterLocations: {} },
    operationMapping: {
      id: "op-1",
      mappingId: "map-1",
      sourceOperationRef: "src.list",
      targetOperationRef: "tgt.create",
      action: "create",
    },
    sourceNativeId: "src-1",
    ...overrides,
  };
}

function createCall(payload: JsonRecord = { ssn: LIVE_PAYLOAD_VALUE }): OutboundCall {
  return {
    ...common(),
    action: "create",
    payload,
    priorReconciledState: { kind: "none" },
  };
}

function updateCall(): OutboundCall {
  const operationMapping: OperationMapping = {
    id: "op-2",
    mappingId: "map-1",
    sourceOperationRef: "src.get",
    targetOperationRef: "tgt.update",
    action: "update",
    targetIdParamRef: "idParam",
  };
  return {
    ...common({
      operation: {
        method: "PUT",
        pathTemplate: "/customers/{id}",
        parameterLocations: { idParam: { name: "id", in: "path" } },
      },
      operationMapping,
    }),
    action: "update",
    payload: { name: "Ada" },
    priorReconciledState: { kind: "reconciled", fieldHashes: { name: "h1" } },
    targetNativeId: "tgt-77",
  };
}

function deleteCall(): OutboundCall {
  const operationMapping: OperationMapping = {
    id: "op-3",
    mappingId: "map-1",
    sourceOperationRef: "src.get",
    targetOperationRef: "tgt.delete",
    action: "delete",
    targetIdParamRef: "idParam",
  };
  return {
    ...common({
      operation: {
        method: "DELETE",
        pathTemplate: "/customers/{id}",
        parameterLocations: { idParam: { name: "id", in: "path" } },
      },
      operationMapping,
    }),
    action: "delete",
    targetNativeId: "tgt-77",
  };
}

const OK_CREATE: (request: OutboundRequest) => OutboundResponse = () => ({
  status: 201,
  headers: {},
  body: { id: "tgt-new-1", name: "Ada" },
});

function makeExecutor(
  protocol: ProtocolClient,
  credentials: CredentialAccess,
  store: FakeSyncEventStore,
  governor = new AppLoadGovernor({ now: () => 0 }),
): OutboundCallExecutor {
  return new OutboundCallExecutor(protocol, credentials, store, governor, {
    now: () => NOW,
    readTraceContext: () => TRACE,
  });
}

// ── OC-1: authenticated REST call for a mapped operation ────────────────────────

describe("OC-1 REST Protocol Client", () => {
  it("create: issues POST with the transformed payload and captures the new native id via nativeIdRef", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const credentials = new FakeCredentialAccess("invoked");
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, credentials, store);

    const result = await executor.execute(createCall({ name: "Ada" }));

    expect(protocol.requests).toHaveLength(1);
    expect(protocol.requests[0]?.method).toBe("POST");
    expect(protocol.requests[0]?.url).toBe("https://api.test/customers");
    expect(protocol.requests[0]?.body).toStrictEqual({ name: "Ada" });
    // The credential was obtained for the TARGET app (least privilege).
    expect(credentials.calls).toStrictEqual(["app-B"]);
    // OC-1 crit 3: the new native id is read from the response and returned (RL-2 deferred).
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.writtenRepresentation.createdNativeId).toBe("tgt-new-1");
      expect(result.writtenRepresentation.body).toStrictEqual({ id: "tgt-new-1", name: "Ada" });
    }
  });

  it("update: fills the target op's id parameter from the PROVIDED native id via targetIdParamRef", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 200, headers: {}, body: {} }));
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    await executor.execute(updateCall());

    // The provided target native id (OC does not read RecordLink) filled the path param.
    expect(protocol.requests[0]?.method).toBe("PUT");
    expect(protocol.requests[0]?.url).toBe("https://api.test/customers/tgt-77");
  });

  it("delete: fills the id parameter and sends no body", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 204, headers: {}, body: undefined }));
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    await executor.execute(deleteCall());

    expect(protocol.requests[0]?.method).toBe("DELETE");
    expect(protocol.requests[0]?.url).toBe("https://api.test/customers/tgt-77");
    expect(protocol.requests[0]?.body).toBeUndefined();
  });

  it("applies the credential inside the withCredential scope and passes the key through the target's idempotency header (OC-2 crit 6)", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const call = createCall({ name: "Ada" });
    const withHeader: OutboundCall = {
      ...call,
      operation: { ...call.operation, idempotencyKeyHeader: "idempotency-key" },
    };
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.execute(withHeader);

    const request = protocol.requests[0];
    expect(request?.headers["authorization"]).toBe(`Bearer ${SECRET_APIKEY}`);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(request?.headers["idempotency-key"]).toBe(result.idempotencyKey);
    }
  });

  it("a public/no-auth app: the call is made unauthenticated (no Authorization header)", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("no-credential"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));

    expect(result.outcome).toBe("success");
    expect(protocol.requests).toHaveLength(1);
    expect(protocol.requests[0]?.headers["authorization"]).toBeUndefined();
  });
});

// ── OC-2: idempotency dedup within a bounded lookback ───────────────────────────

describe("OC-2 dedup within a bounded lookback", () => {
  it("skips a write whose key already SUCCEEDED within the window (no second call)", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const first = await executor.execute(createCall({ name: "Ada" }));
    expect(first.outcome).toBe("success");
    const second = await executor.execute(createCall({ name: "Ada" }));

    expect(second.outcome).toBe("skipped-duplicate");
    // Only the first delivery actually called the target.
    expect(protocol.requests).toHaveLength(1);
    // No second SyncEvent for the duplicate.
    expect(store.all()).toHaveLength(1);
  });

  it("a prior FAILURE with the same key does NOT dedupe — the retry proceeds (supersession)", async () => {
    let calls = 0;
    const protocol = new FakeProtocolClient(() => {
      calls += 1;
      return calls === 1
        ? { status: 503, headers: {}, body: undefined } // first attempt fails
        : { status: 201, headers: {}, body: { id: "tgt-new-1" } }; // retry succeeds
    });
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const first = await executor.execute(createCall({ name: "Ada" }));
    expect(first.outcome).toBe("failure");
    const retry = await executor.execute(createCall({ name: "Ada" }));

    // The failed attempt did not suppress the retry (dedup is success-scoped).
    expect(retry.outcome).toBe("success");
    expect(protocol.requests).toHaveLength(2);
  });

  it("respects the bounded lookback window: a success older than the window does not dedupe", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = new OutboundCallExecutor(
      protocol,
      new FakeCredentialAccess("invoked"),
      store,
      new AppLoadGovernor({ now: () => 0 }),
      { now: () => NOW, readTraceContext: () => TRACE, lookbackWindowMs: 1_000 },
    );

    // Seed an old SUCCESS for this exact key, outside the 1s window.
    const key = computeWriteIdempotencyKey({
      mappingId: "map-1",
      sourceNativeId: "src-1",
      payload: { name: "Ada" },
      priorReconciledState: { kind: "none" },
    });
    const oldEntry: AuditLogEntry = {
      id: "old",
      type: "sync-execution",
      actor: "system",
      status: "success",
      idempotencyKey: key,
      timestamp: new Date(NOW.getTime() - 10_000),
    };
    await store.record(oldEntry);

    const result = await executor.execute(createCall({ name: "Ada" }));
    // The old success is outside the lookback → not a duplicate; the write proceeds.
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.idempotencyKey).toBe(key);
    }
    expect(protocol.requests).toHaveLength(1);
  });
});

// ── OC-3: load discipline (throttle) ────────────────────────────────────────────

describe("OC-3 load discipline", () => {
  it("returns `throttled` (no call, no event) when the governor defers the call", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const governor = new AppLoadGovernor({ now: () => 0 });
    governor.penalize("app-B", 5_000); // an active Retry-After back-off
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store, governor);

    const result = await executor.execute(createCall({ name: "Ada" }));

    expect(result).toStrictEqual({ outcome: "throttled", retryAfterMs: 5_000 });
    expect(protocol.requests).toHaveLength(0); // never hit the app
    expect(store.all()).toHaveLength(0); // a throttle is not a resolved call
  });

  it("honors a 429 Retry-After: returns throttled and backs the app off (no failure event)", async () => {
    const protocol = new FakeProtocolClient(() => ({
      status: 429,
      headers: { "retry-after": "2" },
      body: undefined,
    }));
    const store = new FakeSyncEventStore();
    const governor = new AppLoadGovernor({ now: () => 0 });
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store, governor);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result).toStrictEqual({ outcome: "throttled", retryAfterMs: 2_000 });
    expect(store.all()).toHaveLength(0);
    // The app is now backed off — a subsequent acquire is deferred.
    const next = governor.tryAcquire("app-B", undefined);
    expect(next.granted).toBe(false);
  });
});

// ── OC-4: failure routing ───────────────────────────────────────────────────────

describe("OC-4 failure routing", () => {
  it("5xx → retryable failure with one failure SyncEvent", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 502, headers: {}, body: undefined }));
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result).toMatchObject({ outcome: "failure", disposition: "retryable" });
    expect(store.all().map((e) => e.status)).toStrictEqual(["failure"]);
  });

  it("4xx → permanent failure (no useful retry)", async () => {
    const protocol = new FakeProtocolClient(() => ({ status: 400, headers: {}, body: undefined }));
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result).toMatchObject({ outcome: "failure", disposition: "permanent" });
  });

  it("a transport error → retryable failure (recorded, never a silent success)", async () => {
    const protocol = new FakeProtocolClient(() => {
      throw new Error("ECONNRESET");
    });
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result).toMatchObject({ outcome: "failure", disposition: "retryable" });
    expect(store.all()).toHaveLength(1);
  });

  it("a credential-refresh failure (CD-2) → permanent failure, routed through the failure path", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("refresh-failure"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result).toMatchObject({ outcome: "failure", disposition: "permanent" });
    expect(protocol.requests).toHaveLength(0); // never called with a stale token
    expect(store.all().map((e) => e.status)).toStrictEqual(["failure"]);
  });

  it("a transform error (TX-5) routed via recordTransformFailure → permanent failure, one event, no idempotency key", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.recordTransformFailure(
      {
        targetAppId: "app-B",
        mappingId: "map-1",
        sourceNativeId: "src-1",
        relatedRuleId: "rule-1",
      },
      new TransformError("missing-input", "field 'x' absent"),
    );

    expect(result).toMatchObject({ outcome: "failure", disposition: "permanent" });
    if (result.outcome === "failure") {
      expect(result.idempotencyKey).toBeUndefined();
    }
    expect(protocol.requests).toHaveLength(0);
    const [event] = store.all();
    expect(event?.status).toBe("failure");
    expect(event?.details).toContain("missing-input");
  });
});

// ── OC-5: exactly one SyncEvent per call, with the right fields + no secrets ─────

describe("OC-5 SyncEvent recording", () => {
  it("records exactly one sync-execution event with the SD-4 fields + trace correlation", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    const result = await executor.execute(createCall({ name: "Ada" }));
    expect(result.outcome).toBe("success");

    const events = store.all();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("sync-execution");
    expect(event?.status).toBe("success");
    expect(event?.relatedRuleId).toBe("rule-1");
    expect(event?.recordLinkId).toBe("link-1");
    expect(event?.sourceNativeId).toBe("src-1");
    expect(event?.relatedMappingId).toBe("map-1");
    expect(event?.idempotencyKey).toBeDefined();
    expect(event?.payloadHash).toBeDefined();
    expect(event?.traceId).toBe("trace-abc");
    expect(event?.spanId).toBe("span-def");
  });

  it("never puts a credential or a live payload value on the SyncEvent (security)", async () => {
    const protocol = new FakeProtocolClient(OK_CREATE);
    const store = new FakeSyncEventStore();
    const executor = makeExecutor(protocol, new FakeCredentialAccess("invoked"), store);

    await executor.execute(createCall({ ssn: LIVE_PAYLOAD_VALUE }));

    const serialized = JSON.stringify(store.all());
    expect(serialized).not.toContain(SECRET_APIKEY);
    expect(serialized).not.toContain(LIVE_PAYLOAD_VALUE);
    // The payload hash is present (metadata) but the raw value is not.
    expect(store.all()[0]?.payloadHash).toBeDefined();
  });
});
