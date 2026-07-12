import { appListResponseSchema } from "@mediator/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAuthEventHandlers, setAuthHeader } from "./auth-header";
import { apiRequest } from "./client";

/**
 * The client's auth integration (OA-1/OA-2): it attaches the in-memory Basic
 * header to every request, and folds a 401/403 back to the store's handlers.
 */

interface FetchInit {
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly body?: string;
}

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn<(input: string, init?: FetchInit) => Promise<unknown>>(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthHeader(null);
  registerAuthEventHandlers({ onUnauthenticated: () => {}, onForbidden: () => {} });
});

describe("apiRequest auth", () => {
  it("sends the Authorization header when a credential is set", async () => {
    const fetchMock = stubFetch(200, { apps: [] });
    setAuthHeader("Basic operator-token");

    await apiRequest("/api/apps", { method: "GET" }, appListResponseSchema);

    expect(fetchMock.mock.calls[0]?.[1]?.headers?.["authorization"]).toBe("Basic operator-token");
  });

  it("sends no Authorization header when logged out", async () => {
    const fetchMock = stubFetch(200, { apps: [] });

    await apiRequest("/api/apps", { method: "GET" }, appListResponseSchema);

    expect(fetchMock.mock.calls[0]?.[1]?.headers?.["authorization"]).toBeUndefined();
  });

  it("notifies the unauthenticated handler on a 401", async () => {
    stubFetch(401, { statusCode: 401, error: "Unauthorized", message: "no identity" });
    const onUnauthenticated = vi.fn();
    const onForbidden = vi.fn();
    registerAuthEventHandlers({ onUnauthenticated, onForbidden });

    await expect(
      apiRequest("/api/apps", { method: "GET" }, appListResponseSchema),
    ).rejects.toBeDefined();

    expect(onUnauthenticated).toHaveBeenCalledOnce();
    expect(onForbidden).not.toHaveBeenCalled();
  });

  it("notifies the forbidden handler on a 403", async () => {
    stubFetch(403, { statusCode: 403, error: "Forbidden", message: "operator only" });
    const onUnauthenticated = vi.fn();
    const onForbidden = vi.fn();
    registerAuthEventHandlers({ onUnauthenticated, onForbidden });

    await expect(
      apiRequest("/api/apps", { method: "POST", body: {} }, appListResponseSchema),
    ).rejects.toBeDefined();

    expect(onForbidden).toHaveBeenCalledOnce();
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });
});
