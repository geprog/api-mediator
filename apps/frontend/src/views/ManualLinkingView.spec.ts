import type { AmbiguousMatchDto, CreateRecordLinkResponse, SessionRole } from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRecordLink, listAmbiguousMatches, unlinkRecord } from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ManualLinkingView from "./ManualLinkingView.vue";

vi.mock("../api/sync", () => ({
  listAmbiguousMatches: vi.fn(),
  createRecordLink: vi.fn(),
  unlinkRecord: vi.fn(),
}));

const listMock = vi.mocked(listAmbiguousMatches);
const createMock = vi.mocked(createRecordLink);
const unlinkMock = vi.mocked(unlinkRecord);

function match(overrides: Partial<AmbiguousMatchDto> = {}): AmbiguousMatchDto {
  return {
    syncEventId: "ev-1",
    ruleId: "rule-1",
    sourceAppId: "app-gitea",
    sourceNativeId: "42",
    candidateTargetNativeIds: ["100", "200"],
    observedAt: "2026-07-11T00:00:00.000Z",
    details: "ambiguous identity match: 2 candidates [100, 200]",
    ...overrides,
  };
}

const createdLink: CreateRecordLinkResponse = {
  link: {
    id: "link-1",
    appAId: "app-gitea",
    appANativeId: "42",
    appBId: "app-vikunja",
    appBNativeId: "100",
    resourcePairRef: "pair-issues-tasks",
    establishedBy: "manual",
    status: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
  },
};

async function mountView(role: SessionRole) {
  const wrapper = mount(ManualLinkingView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ManualLinkingView — SU-2", () => {
  it("lists each unresolved record with its candidate target ids (SU-2.1)", async () => {
    listMock.mockResolvedValue({ matches: [match()] });
    const wrapper = await mountView("operator");

    const entry = wrapper.get('[data-testid="ambiguous-ev-1"]');
    expect(entry.text()).toContain("42");
    expect(wrapper.find('[data-testid="candidate-ev-1-100"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="candidate-ev-1-200"]').exists()).toBe(true);
  });

  it("links the chosen target via SA-3 and drops the record from the queue (SU-2.2)", async () => {
    listMock.mockResolvedValueOnce({ matches: [match()] }).mockResolvedValue({ matches: [] });
    createMock.mockResolvedValue(createdLink);
    const wrapper = await mountView("operator");

    await wrapper.get('[data-testid="candidate-ev-1-100"]').setValue(true);
    await wrapper.get('[data-testid="link-button-ev-1"]').trigger("click");
    await flushPromises();

    expect(createMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      sourceNativeId: "42",
      targetNativeId: "100",
    });
    // The queue refetched (invalidated) and the record is gone.
    expect(wrapper.find('[data-testid="ambiguous-ev-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ambiguous-empty"]').exists()).toBe(true);
  });

  it("unlinks a session-established link via SA-3 (SU-2.3)", async () => {
    listMock.mockResolvedValue({ matches: [match()] });
    createMock.mockResolvedValue(createdLink);
    unlinkMock.mockResolvedValue({ id: "link-1", unlinked: true });
    const wrapper = await mountView("operator");

    await wrapper.get('[data-testid="candidate-ev-1-100"]').setValue(true);
    await wrapper.get('[data-testid="link-button-ev-1"]').trigger("click");
    await flushPromises();

    await wrapper.get('[data-testid="unlink-button-link-1"]').trigger("click");
    await flushPromises();

    expect(unlinkMock).toHaveBeenCalledWith("link-1");
    expect(wrapper.find('[data-testid="session-link-link-1"]').exists()).toBe(false);
  });

  it("renders read-only for a viewer — no link/unlink controls (SU-2.4)", async () => {
    listMock.mockResolvedValue({ matches: [match()] });
    const wrapper = await mountView("viewer");

    expect(wrapper.find('[data-testid="manual-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="link-button-ev-1"]').exists()).toBe(false);
    const candidate = wrapper.get('[data-testid="candidate-ev-1-100"]').element as HTMLInputElement;
    expect(candidate.disabled).toBe(true);
  });
});
