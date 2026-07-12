import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/errors";
import { getSession } from "../api/session";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import LoginView from "./LoginView.vue";

const hoisted = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: hoisted.push }),
}));

vi.mock("../api/session", () => ({ getSession: vi.fn() }));

const getSessionMock = vi.mocked(getSession);

beforeEach(() => {
  vi.clearAllMocks();
});

async function submitLogin() {
  const wrapper = mount(LoginView, { global: testGlobalOptions() });
  await wrapper.get('[data-testid="login-username"]').setValue("operator");
  await wrapper.get('[data-testid="login-password"]').setValue("pw");
  await wrapper.get('[data-testid="login-form"]').trigger("submit");
  await flushPromises();
  return wrapper;
}

describe("LoginView", () => {
  it("logs in and navigates to the redirect target on success", async () => {
    getSessionMock.mockResolvedValue({ identity: "operator", role: "operator" });

    await submitLogin();

    expect(getSessionMock).toHaveBeenCalledOnce();
    expect(hoisted.push).toHaveBeenCalledWith("/proposals");
    expect(useAuthStore().isOperator).toBe(true);
  });

  it("shows an error and does not navigate on a 401", async () => {
    getSessionMock.mockRejectedValue(
      new ApiError({ statusCode: 401, error: "Unauthorized", message: "no identity" }),
    );

    const wrapper = await submitLogin();

    expect(wrapper.get('[data-testid="login-error"]').text()).toContain(
      "Invalid username or password.",
    );
    expect(hoisted.push).not.toHaveBeenCalled();
  });
});
