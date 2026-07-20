import type {
  CreateScopeLinkResponse,
  ParkedContainerLinkDto,
  ScopeLinkCandidateContextResponse,
  SessionRole,
} from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createScopeLink,
  getScopeLinkCandidateContext,
  listParkedContainerLinks,
  unlinkScopeLink,
} from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ContainerLinkingView from "./ContainerLinkingView.vue";

vi.mock("../api/sync", () => ({
  listParkedContainerLinks: vi.fn(),
  getScopeLinkCandidateContext: vi.fn(),
  createScopeLink: vi.fn(),
  unlinkScopeLink: vi.fn(),
}));

const listMock = vi.mocked(listParkedContainerLinks);
const contextMock = vi.mocked(getScopeLinkCandidateContext);
const createMock = vi.mocked(createScopeLink);
const unlinkMock = vi.mocked(unlinkScopeLink);

function parked(overrides: Partial<ParkedContainerLinkDto> = {}): ParkedContainerLinkDto {
  return {
    syncEventId: "sev-1",
    resourcePairRef: "pair-issues-tasks",
    sourceAppId: "app-gitea",
    sourceScopeKey: { owner: "alice", name: "phoenix" },
    candidateTargetNativeIds: ["42", "77"],
    observedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

const context: ScopeLinkCandidateContextResponse = {
  resourcePairRef: "pair-issues-tasks",
  targetAppId: "app-vikunja",
  targetScopeKeyComponent: "id",
};

const createdLink: CreateScopeLinkResponse = {
  link: {
    id: "slink-1",
    scopeCorrespondenceId: "corr-1",
    appAId: "app-gitea",
    appAScopeKey: { owner: "alice", name: "phoenix" },
    appBId: "app-vikunja",
    appBScopeKey: { id: "42" },
    resourcePairRef: "pair-issues-tasks",
    establishedBy: "manual",
    status: "active",
    createdAt: "2026-07-19T00:00:00.000Z",
  },
};

async function mountView(role: SessionRole) {
  const wrapper = mount(ContainerLinkingView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ContainerLinkingView — SS-15.5", () => {
  it("lists each parked container with its candidate target containers (ambiguous)", async () => {
    listMock.mockResolvedValue({ parked: [parked()] });
    const wrapper = await mountView("operator");

    const entry = wrapper.get('[data-testid="parked-sev-1"]');
    expect(entry.text()).toContain("owner=alice");
    expect(entry.text()).toContain("ambiguous");
    expect(wrapper.find('[data-testid="container-candidate-sev-1-42"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="container-candidate-sev-1-77"]').exists()).toBe(true);
  });

  it("marks an unresolvable parked scope (no candidates) distinctly", async () => {
    listMock.mockResolvedValue({
      parked: [parked({ syncEventId: "sev-2", candidateTargetNativeIds: [] })],
    });
    const wrapper = await mountView("operator");

    expect(wrapper.get('[data-testid="parked-sev-2"]').text()).toContain("unresolved");
    expect(wrapper.find('[data-testid="container-no-candidates-sev-2"]').exists()).toBe(true);
  });

  it("links the chosen candidate via SS-11.6 (native id wrapped into the target scope key) and drops it from the queue", async () => {
    listMock.mockResolvedValueOnce({ parked: [parked()] }).mockResolvedValue({ parked: [] });
    contextMock.mockResolvedValue(context);
    createMock.mockResolvedValue(createdLink);
    const wrapper = await mountView("operator");

    await wrapper.get('[data-testid="container-candidate-sev-1-42"]').setValue(true);
    await wrapper.get('[data-testid="container-link-button-sev-1"]').trigger("click");
    await flushPromises();

    expect(createMock).toHaveBeenCalledWith({
      resourcePairRef: "pair-issues-tasks",
      sourceAppId: "app-gitea",
      sourceScopeKey: { owner: "alice", name: "phoenix" },
      targetAppId: "app-vikunja",
      targetScopeKey: { id: "42" },
    });
    // The queue refetched (invalidated) and the parked scope is gone (it replays).
    expect(wrapper.find('[data-testid="parked-sev-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="parked-empty"]').exists()).toBe(true);
  });

  it("unlinks a session-established ScopeLink via SS-11.6", async () => {
    listMock.mockResolvedValue({ parked: [parked()] });
    contextMock.mockResolvedValue(context);
    createMock.mockResolvedValue(createdLink);
    unlinkMock.mockResolvedValue({ id: "slink-1", unlinked: true });
    const wrapper = await mountView("operator");

    await wrapper.get('[data-testid="container-candidate-sev-1-42"]').setValue(true);
    await wrapper.get('[data-testid="container-link-button-sev-1"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="container-unlink-button-slink-1"]').trigger("click");
    await flushPromises();

    expect(unlinkMock).toHaveBeenCalledWith("slink-1");
    expect(wrapper.find('[data-testid="container-session-link-slink-1"]').exists()).toBe(false);
  });

  it("surfaces an error when the pair has no resolvable target linking context", async () => {
    listMock.mockResolvedValue({ parked: [parked()] });
    contextMock.mockResolvedValue({
      resourcePairRef: "pair-issues-tasks",
      targetAppId: null,
      targetScopeKeyComponent: null,
    });
    const wrapper = await mountView("operator");

    await wrapper.get('[data-testid="container-candidate-sev-1-42"]').setValue(true);
    await wrapper.get('[data-testid="container-link-button-sev-1"]').trigger("click");
    await flushPromises();

    expect(createMock).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="container-action-error"]').text()).toContain("Cannot link");
  });

  it("renders read-only for a viewer — no link/unlink controls (OA-2)", async () => {
    listMock.mockResolvedValue({ parked: [parked()] });
    const wrapper = await mountView("viewer");

    expect(wrapper.find('[data-testid="container-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="container-link-button-sev-1"]').exists()).toBe(false);
    const candidate = wrapper.get('[data-testid="container-candidate-sev-1-42"]')
      .element as HTMLInputElement;
    expect(candidate.disabled).toBe(true);
  });
});
