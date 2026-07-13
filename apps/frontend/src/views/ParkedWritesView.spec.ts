import type { DeadLetterWriteDto, SessionRole } from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listDeadLetterWrites, replayParkedWrite } from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ParkedWritesView from "./ParkedWritesView.vue";

vi.mock("../api/sync", () => ({
  listDeadLetterWrites: vi.fn(),
  replayParkedWrite: vi.fn(),
}));

const listMock = vi.mocked(listDeadLetterWrites);
const replayMock = vi.mocked(replayParkedWrite);

function write(overrides: Partial<DeadLetterWriteDto> = {}): DeadLetterWriteDto {
  return {
    id: "w-1",
    ruleId: "rule-1",
    mappingId: "mapping-1",
    sourceAppId: "app-gitea",
    targetAppId: "app-vikunja",
    resourcePairRef: "pair-issues-tasks",
    sourceNativeId: "42",
    changeKind: "update",
    lastError: "HTTP 503 from target",
    attempts: 5,
    superseded: false,
    parkedAt: "2026-07-11T00:00:00.000Z",
    enqueuedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

async function mountView(writes: DeadLetterWriteDto[], role: SessionRole) {
  listMock.mockResolvedValue({ writes });
  const wrapper = mount(ParkedWritesView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ParkedWritesView — SU-4", () => {
  it("lists parked writes with their record/rule context (SU-4.1)", async () => {
    const wrapper = await mountView([write()], "operator");
    const entry = wrapper.get('[data-testid="dead-letter-w-1"]');
    expect(entry.text()).toContain("42");
    expect(entry.text()).toContain("HTTP 503 from target");
  });

  it("marks a superseded write as needing no action and disables replay (SU-4.3)", async () => {
    const wrapper = await mountView([write({ id: "w-super", superseded: true })], "operator");
    expect(wrapper.find('[data-testid="superseded-w-super"]').exists()).toBe(true);
    const replayButton = wrapper.get('[data-testid="replay-button-w-super"]');
    expect(replayButton.attributes("disabled")).toBeDefined();
  });

  it("replays a parked write via SA-5 and communicates the current-state re-run (SU-4.2)", async () => {
    replayMock.mockResolvedValue({ id: "w-1", outcome: "reactivated" });
    const wrapper = await mountView([write()], "operator");

    await wrapper.get('[data-testid="replay-button-w-1"]').trigger("click");
    await flushPromises();

    expect(replayMock).toHaveBeenCalledWith("w-1");
    expect(wrapper.get('[data-testid="replay-outcome"]').text()).toContain("current state");
  });

  it("renders read-only for a viewer — no replay control (SU-4.4)", async () => {
    const wrapper = await mountView([write()], "viewer");
    expect(wrapper.find('[data-testid="parked-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="replay-button-w-1"]').exists()).toBe(false);
  });
});
