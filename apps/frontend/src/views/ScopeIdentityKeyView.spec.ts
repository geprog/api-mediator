import type {
  ConfirmScopeIdentityKeyResponse,
  ScopeCorrespondenceDto,
  ScopeIdentityKeyDerivationResponse,
  SessionRole,
} from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmScopeIdentityKey, deriveScopeIdentityKey } from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ScopeIdentityKeyView from "./ScopeIdentityKeyView.vue";

vi.mock("vue-router", async () => {
  const { RouterLinkStub: stub } = await import("@vue/test-utils");
  return {
    useRoute: () => ({ query: { pair: "pair-issues-tasks" } }),
    useRouter: () => ({ push: vi.fn() }),
    RouterLink: stub,
  };
});

vi.mock("../api/sync", () => ({
  deriveScopeIdentityKey: vi.fn(),
  confirmScopeIdentityKey: vi.fn(),
}));

const deriveMock = vi.mocked(deriveScopeIdentityKey);
const confirmMock = vi.mocked(confirmScopeIdentityKey);

const correspondence: ScopeCorrespondenceDto = {
  id: "corr-1",
  resourcePairRef: "pair-issues-tasks",
  scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
  targetContainerRef: { appId: "app-vikunja", resourceRef: "projects" },
  confirmedBy: null,
  confirmedAt: null,
};

const derivation: ScopeIdentityKeyDerivationResponse = {
  resourcePairRef: "pair-issues-tasks",
  correspondence,
};

const confirmed: ConfirmScopeIdentityKeyResponse = {
  correspondence: {
    ...correspondence,
    confirmedBy: "ops",
    confirmedAt: "2026-07-19T00:00:00.000Z",
  },
};

async function mountView(role: SessionRole) {
  const wrapper = mount(ScopeIdentityKeyView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ScopeIdentityKeyView — SS-15.4", () => {
  it("loads the pair's candidate and confirms it via the API", async () => {
    deriveMock.mockResolvedValue(derivation);
    confirmMock.mockResolvedValue(confirmed);
    const wrapper = await mountView("operator");

    expect(deriveMock).toHaveBeenCalledWith("pair-issues-tasks");
    expect(wrapper.find('[data-testid="scope-identity-panel"]').exists()).toBe(true);

    await wrapper.get('[data-testid="scope-identity-confirm"]').trigger("click");
    await flushPromises();

    expect(confirmMock).toHaveBeenCalledWith({
      resourcePairRef: "pair-issues-tasks",
      scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    });
    expect(wrapper.find('[data-testid="scope-identity-confirmed-outcome"]').exists()).toBe(true);
  });

  it("renders read-only for a viewer — banner shown, no confirm control (OA-2)", async () => {
    deriveMock.mockResolvedValue(derivation);
    const wrapper = await mountView("viewer");

    expect(wrapper.find('[data-testid="scope-identity-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="scope-identity-confirm"]').exists()).toBe(false);
  });
});
