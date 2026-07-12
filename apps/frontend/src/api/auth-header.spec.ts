import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodeBasicAuth,
  getAuthHeader,
  notifyForbidden,
  notifyUnauthenticated,
  registerAuthEventHandlers,
  setAuthHeader,
} from "./auth-header";

afterEach(() => {
  setAuthHeader(null);
});

describe("encodeBasicAuth", () => {
  it("produces an RFC-7617 Basic header (base64 of user:pass)", () => {
    expect(encodeBasicAuth("operator", "pw")).toBe(`Basic ${btoa("operator:pw")}`);
  });

  it("is UTF-8 safe for non-Latin-1 passwords", () => {
    // Should not throw (a raw btoa would on a multibyte character).
    expect(() => encodeBasicAuth("op", "pä€ss")).not.toThrow();
  });
});

describe("auth header slot", () => {
  it("stores and clears the current header", () => {
    expect(getAuthHeader()).toBeNull();
    setAuthHeader("Basic abc");
    expect(getAuthHeader()).toBe("Basic abc");
    setAuthHeader(null);
    expect(getAuthHeader()).toBeNull();
  });
});

describe("auth event handlers", () => {
  it("routes 401/403 notifications to the registered handlers", () => {
    const onUnauthenticated = vi.fn();
    const onForbidden = vi.fn();
    registerAuthEventHandlers({ onUnauthenticated, onForbidden });

    notifyUnauthenticated();
    notifyForbidden();

    expect(onUnauthenticated).toHaveBeenCalledOnce();
    expect(onForbidden).toHaveBeenCalledOnce();
  });
});
