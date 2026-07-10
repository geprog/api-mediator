import type { RegisterAppResponse } from "@mediator/contracts";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerApp } from "../../api/apps";
import { ApiError } from "../../api/errors";
import { previewParse } from "../../api/specs";
import { testGlobalOptions } from "../../testing/render";
import RegistrationForm from "./RegistrationForm.vue";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("vue-router", () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock("../../api/apps", () => ({
  registerApp: vi.fn(),
  listApps: vi.fn(),
  getAppSpecs: vi.fn(),
}));

vi.mock("../../api/specs", () => ({
  previewParse: vi.fn(),
  getSpecIr: vi.fn(),
  updateAnalysisExclusions: vi.fn(),
}));

const registerAppMock = vi.mocked(registerApp);
const previewParseMock = vi.mocked(previewParse);

const openApiDoc: Record<string, unknown> = {
  openapi: "3.0.0",
  info: { title: "Demo", version: "1.0.0" },
  paths: {},
};

function successResponse(appId: string): RegisterAppResponse {
  return {
    app: {
      id: appId,
      name: "Demo",
      status: "active",
      capabilities: {
        supportsPolling: false,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 30000,
      },
      createdAt: "2026-07-10T00:00:00.000Z",
    },
    specs: [],
  };
}

async function uploadSpec(
  wrapper: VueWrapper,
  index: number,
  document: Record<string, unknown>,
): Promise<void> {
  const file = new File([JSON.stringify(document)], "spec.json", { type: "application/json" });
  const input = wrapper.get(`[data-testid="spec-file-${String(index)}"]`);
  Object.defineProperty(input.element, "files", { value: [file], configurable: true });
  await input.trigger("change");
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  previewParseMock.mockResolvedValue({
    ir: [],
    resourceGroups: [{ resourceRef: "issues", name: "issues", operationCount: 2 }],
  });
});

describe("RegistrationForm (AR-1 / AR-3)", () => {
  it("renders the core fields", () => {
    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    expect(wrapper.find('[data-testid="registration-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="reg-name"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="reg-base-url"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="spec-file-0"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="spec-role-0"]').exists()).toBe(true);
  });

  it("does not offer adapterToken as a credential type", async () => {
    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    await wrapper.get('[data-testid="reg-credential-enable"]').setValue(true);

    const options = wrapper
      .get('[data-testid="reg-credential-type"]')
      .findAll("option")
      .map((option) => option.attributes("value"));
    expect(options).toEqual(["apiKey", "basicAuth", "oauth2", "custom"]);
    expect(options).not.toContain("adapterToken");
  });

  it("enforces baseUrl-required-when-PROVIDER client-side before calling the API", async () => {
    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    await wrapper.get('[data-testid="reg-name"]').setValue("Gitea");
    // Default role is PROVIDER; leave baseUrl empty.
    await wrapper.get('[data-testid="registration-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.find('[data-testid="reg-base-url-error"]').exists()).toBe(true);
    expect(registerAppMock).not.toHaveBeenCalled();
  });

  it("preview-parses an uploaded spec, populates the exclusion selector, and submits the right request", async () => {
    registerAppMock.mockResolvedValue(successResponse("app-42"));

    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    await wrapper.get('[data-testid="reg-name"]').setValue("Demo");
    await wrapper.get('[data-testid="spec-role-0"]').setValue("CONSUMER");
    await uploadSpec(wrapper, 0, openApiDoc);

    // Preview parse populated the exclusion selector.
    expect(previewParseMock.mock.calls[0]?.[0]).toEqual({ document: openApiDoc });
    expect(wrapper.find('[data-testid="spec-group-0-issues"]').exists()).toBe(true);

    // Exclude the previewed resource group.
    await wrapper.get('[data-testid="spec-exclude-0-issues"]').setValue(true);

    await wrapper.get('[data-testid="registration-form"]').trigger("submit");
    await flushPromises();

    expect(registerAppMock).toHaveBeenCalledTimes(1);
    // vue-query passes a mutation-context second arg; assert on the request only.
    expect(registerAppMock.mock.calls[0]?.[0]).toEqual({
      name: "Demo",
      specs: [{ role: "CONSUMER", document: openApiDoc, analysisExclusions: ["issues"] }],
    });
    // On success it navigates to the created app.
    expect(pushMock).toHaveBeenCalledWith({ name: "app-detail", params: { id: "app-42" } });
  });

  it("renders server-side ErrorResponse.issues on a 400 without losing input", async () => {
    registerAppMock.mockRejectedValue(
      new ApiError({
        statusCode: 400,
        error: "Bad Request",
        message: "Validation failed",
        issues: [{ path: "name", message: "An app named 'Demo' already exists." }],
      }),
    );

    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    await wrapper.get('[data-testid="reg-name"]').setValue("Demo");
    await wrapper.get('[data-testid="spec-role-0"]').setValue("CONSUMER");
    await uploadSpec(wrapper, 0, openApiDoc);

    await wrapper.get('[data-testid="registration-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="reg-issues"]').text()).toContain(
      "An app named 'Demo' already exists.",
    );
    // Input is preserved.
    const nameEl = wrapper.get('[data-testid="reg-name"]').element;
    expect(nameEl instanceof HTMLInputElement && nameEl.value).toBe("Demo");
  });

  it("keeps credential material write-only: password inputs, secret never rendered, but sent", async () => {
    registerAppMock.mockResolvedValue(successResponse("app-7"));
    const secret = "super-secret-api-key";

    const wrapper = mount(RegistrationForm, { global: testGlobalOptions() });
    await wrapper.get('[data-testid="reg-name"]').setValue("Demo");
    await wrapper.get('[data-testid="spec-role-0"]').setValue("CONSUMER");
    await uploadSpec(wrapper, 0, openApiDoc);

    await wrapper.get('[data-testid="reg-credential-enable"]').setValue(true);
    const apiKeyInput = wrapper.get('[data-testid="reg-credential-apikey"]');
    expect(apiKeyInput.attributes("type")).toBe("password");
    await apiKeyInput.setValue(secret);

    // The secret is never rendered as visible text anywhere in the form.
    expect(wrapper.text()).not.toContain(secret);

    await wrapper.get('[data-testid="registration-form"]').trigger("submit");
    await flushPromises();

    // It is sent write-only in the request…
    expect(registerAppMock.mock.calls[0]?.[0]).toEqual({
      name: "Demo",
      specs: [{ role: "CONSUMER", document: openApiDoc }],
      credential: { secret: { type: "apiKey", apiKey: secret } },
    });
  });
});
