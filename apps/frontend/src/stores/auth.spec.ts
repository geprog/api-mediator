import type { SessionResponse } from "@mediator/contracts";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyForbidden, notifyUnauthenticated, setAuthHeader } from "../api/auth-header";
import { ApiError } from "../api/errors";
import { getSession } from "../api/session";
import { useAuthStore } from "./auth";

vi.mock("../api/session", () => ({ getSession: vi.fn() }));

const getSessionMock = vi.mocked(getSession);

beforeEach(() => {
  vi.clearAllMocks();
  setAuthHeader(null);
  setActivePinia(createPinia());
});

function session(role: SessionResponse["role"], identity = role): SessionResponse {
  return { identity, role };
}

describe("useAuthStore.logIn", () => {
  it("resolves an operator session and exposes mutate rights", async () => {
    getSessionMock.mockResolvedValue(session("operator"));
    const auth = useAuthStore();

    const ok = await auth.logIn("operator", "pw");

    expect(ok).toBe(true);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.role).toBe("operator");
    expect(auth.isOperator).toBe(true);
    expect(auth.identity).toBe("operator");
  });

  it("resolves a viewer session as read-only (not operator)", async () => {
    getSessionMock.mockResolvedValue(session("viewer"));
    const auth = useAuthStore();

    await auth.logIn("viewer", "pw");

    expect(auth.role).toBe("viewer");
    expect(auth.isOperator).toBe(false);
  });

  it("reports invalid credentials on a 401 and stays unauthenticated", async () => {
    getSessionMock.mockRejectedValue(
      new ApiError({ statusCode: 401, error: "Unauthorized", message: "no identity" }),
    );
    const auth = useAuthStore();

    const ok = await auth.logIn("operator", "wrong");

    expect(ok).toBe(false);
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.loginError).toBe("Invalid username or password.");
  });
});

describe("useAuthStore transport reactions", () => {
  it("logs out on a mid-session 401", async () => {
    getSessionMock.mockResolvedValue(session("operator"));
    const auth = useAuthStore();
    await auth.logIn("operator", "pw");
    expect(auth.isAuthenticated).toBe(true);

    notifyUnauthenticated();

    expect(auth.isAuthenticated).toBe(false);
  });

  it("downgrades to read-only on a 403", async () => {
    getSessionMock.mockResolvedValue(session("operator"));
    const auth = useAuthStore();
    await auth.logIn("operator", "pw");

    notifyForbidden();

    expect(auth.forcedReadOnly).toBe(true);
    expect(auth.isOperator).toBe(false);
    expect(auth.role).toBe("viewer");
  });
});
