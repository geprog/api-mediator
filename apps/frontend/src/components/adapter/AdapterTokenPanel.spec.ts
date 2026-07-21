import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { issueAdapterToken, rotateAdapterToken } from "../../api/adapter-token";
import { testGlobalOptions } from "../../testing/render";
import AdapterTokenPanel from "./AdapterTokenPanel.vue";

vi.mock("../../api/adapter-token", () => ({
  issueAdapterToken: vi.fn(),
  rotateAdapterToken: vi.fn(),
  cutoverAdapterToken: vi.fn(),
}));

const issueMock = vi.mocked(issueAdapterToken);
const rotateMock = vi.mocked(rotateAdapterToken);

const APP_ID = "consumer-1";
const RAW_TOKEN = "amt.00000000-0000-4000-8000-000000000001.deadbeefsecret";

function mountPanel(readonly = false) {
  return mount(AdapterTokenPanel, {
    props: { consumerAppId: APP_ID, readonly },
    global: testGlobalOptions(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  issueMock.mockResolvedValue({
    credentialId: "cred-1",
    token: RAW_TOKEN,
    rotated: false,
    issuedAt: "2026-07-21T00:00:00.000Z",
  });
  rotateMock.mockResolvedValue({
    credentialId: "cred-2",
    token: "amt.00000000-0000-4000-8000-000000000001.rotatedsecret",
    rotated: true,
    issuedAt: "2026-07-21T01:00:00.000Z",
  });
});

describe("AdapterTokenPanel (CU-3)", () => {
  it("shows the raw token exactly once, with the cannot-retrieve-again statement (CU-3.1)", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="token-issue"]').trigger("click");
    await flushPromises();

    expect(issueMock).toHaveBeenCalledWith(APP_ID);
    expect(wrapper.get('[data-testid="token-value"]').text()).toBe(RAW_TOKEN);
    expect(wrapper.get('[data-testid="token-once-warning"]').text()).toContain(
      "cannot be retrieved again",
    );
    expect(wrapper.find('[data-testid="token-copy"]').exists()).toBe(true);
  });

  it("never shows the raw token again after a remount (CU-3.2)", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="token-issue"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="token-value"]').exists()).toBe(true);
    wrapper.unmount();

    // A fresh mount (reload / navigate-away / reopen) re-derives nothing — the raw token
    // lived only in transient component state, so it is gone.
    const reopened = mountPanel();
    expect(reopened.find('[data-testid="token-value"]').exists()).toBe(false);
    expect(reopened.text()).not.toContain(RAW_TOKEN);
  });

  it("states the overlap window on rotation and offers confirm-cutover (CU-3.3)", async () => {
    const wrapper = mountPanel();
    // Issue first so the Rotate control appears.
    await wrapper.get('[data-testid="token-issue"]').trigger("click");
    await flushPromises();
    await wrapper.get('[data-testid="token-rotate"]').trigger("click");
    await flushPromises();

    expect(rotateMock).toHaveBeenCalledWith(APP_ID);
    expect(wrapper.get('[data-testid="token-overlap-note"]').text()).toContain(
      "previous token stays valid",
    );
    expect(wrapper.find('[data-testid="token-cutover"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="token-overlap-active"]').exists()).toBe(true);
  });

  it("shows the consumer handoff — base URL note + auth scheme (CU-3.4)", () => {
    const wrapper = mountPanel();
    expect(wrapper.get('[data-testid="token-auth-scheme"]').text()).toContain("Bearer");
    expect(wrapper.find('[data-testid="token-handoff"]').exists()).toBe(true);
  });

  it("renders read-only for a viewer — no controls and no token value ever (CU-3.5 / OA-2)", () => {
    const wrapper = mountPanel(true);
    expect(wrapper.find('[data-testid="token-issue"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="token-rotate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="token-value"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="token-readonly"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain(RAW_TOKEN);
  });
});
