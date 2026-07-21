import type { DecryptedCredential, WithCredentialResult } from "@mediator/credentials";
import type { IrOperation } from "@mediator/domain";
import {
  AppLoadGovernor,
  type CredentialAccess,
  type OutboundResponse,
  type ProtocolClient,
} from "@mediator/outbound";
import { describe, expect, it } from "vitest";

import { AdapterBackendCaller, type BackendCallInput } from "./backend-call.js";
import type { MappedBackendRequest } from "./request-mapping.js";

/**
 * WR-5.3 — a backend-call failure is recorded in the write-outcome store only when the
 * request actually reached the backend, so `AdapterBackendCaller` must attribute a throw
 * correctly: a transport failure *after* dispatch (the write may have applied) carries
 * `reachedBackend: true`, but a throw from `withCredential`'s own pre-send work
 * (envelope load / decryption / OAuth refresh / pre-send audit) reached no backend and is
 * `reachedBackend: false`, so a keyed retry re-evaluates rather than replaying a pinned
 * transient failure.
 */

const operation: IrOperation = {
  operationId: "createTask",
  method: "post",
  path: "/tasks",
  parameters: [],
};

const mapped: MappedBackendRequest = {
  pathParams: {},
  queryParams: [],
  headerParams: [],
  body: { title: "x" },
};

const input: BackendCallInput = {
  targetAppId: "backend-app",
  baseUrl: "https://backend.example",
  operation,
  mapped,
};

const credential: DecryptedCredential = {
  credentialId: "c1",
  type: "oauth2",
  scopes: [],
  secret: { type: "oauth2", accessToken: "t" },
};

const okResponse: OutboundResponse = { status: 200, headers: {}, body: {} };

function caller(protocol: ProtocolClient, credentials: CredentialAccess): AdapterBackendCaller {
  return new AdapterBackendCaller(protocol, credentials, new AppLoadGovernor(), {
    applyCredential: (headers) => ({ ...headers }),
  });
}

describe("AdapterBackendCaller — reachedBackend attribution (WR-5.3)", () => {
  it("labels a pre-send credential throw reachedBackend:false (never dispatched)", async () => {
    let sendCalls = 0;
    const protocol: ProtocolClient = {
      send: () => {
        sendCalls += 1;
        return Promise.resolve(okResponse);
      },
    };
    const credentials: CredentialAccess = {
      // Throws while resolving the credential — before `fn` (protocol.send) is invoked.
      withCredential<T>(): Promise<WithCredentialResult<T>> {
        throw new Error("envelope decryption failed");
      },
    };

    const result = await caller(protocol, credentials).call(input);

    expect(sendCalls).toBe(0);
    if (result.ok || result.kind !== "upstream-error") {
      throw new Error("expected an upstream-error");
    }
    expect(result.reachedBackend).toBe(false);
    expect(result.detail).toContain("before dispatch");
  });

  it("labels a transport throw during an authenticated send reachedBackend:true", async () => {
    const protocol: ProtocolClient = {
      send: () => Promise.reject(new Error("ECONNRESET")),
    };
    const credentials: CredentialAccess = {
      async withCredential<T>(
        _appId: string,
        fn: (credential: DecryptedCredential) => Promise<T>,
      ): Promise<WithCredentialResult<T>> {
        // The real store invokes `fn` inside its scope; here `fn` (protocol.send) throws.
        const value = await fn(credential);
        return { outcome: "invoked", value };
      },
    };

    const result = await caller(protocol, credentials).call(input);

    if (result.ok || result.kind !== "upstream-error") {
      throw new Error("expected an upstream-error");
    }
    expect(result.reachedBackend).toBe(true);
    expect(result.detail).toContain("transport failure");
  });

  it("labels a transport throw on the no-credential (public) send reachedBackend:true", async () => {
    const protocol: ProtocolClient = {
      send: () => Promise.reject(new Error("ETIMEDOUT")),
    };
    const credentials: CredentialAccess = {
      withCredential<T>(): Promise<WithCredentialResult<T>> {
        return Promise.resolve({ outcome: "no-credential" });
      },
    };

    const result = await caller(protocol, credentials).call(input);

    if (result.ok || result.kind !== "upstream-error") {
      throw new Error("expected an upstream-error");
    }
    expect(result.reachedBackend).toBe(true);
  });
});
