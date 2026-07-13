import type {
  ParkedConflictDto,
  ResolveParkedConflictResponse,
  SessionRole,
} from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listParkedConflicts, resolveParkedConflict } from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ConflictResolutionView from "./ConflictResolutionView.vue";

vi.mock("../api/sync", () => ({
  listParkedConflicts: vi.fn(),
  resolveParkedConflict: vi.fn(),
}));

const listMock = vi.mocked(listParkedConflicts);
const resolveMock = vi.mocked(resolveParkedConflict);

function conflict(overrides: Partial<ParkedConflictDto> = {}): ParkedConflictDto {
  return {
    id: "c-1",
    recordLinkId: "link-1",
    syncRuleId: "rule-1",
    mappingId: "mapping-1",
    kind: "manual-resolve",
    side: "A",
    fieldPath: "title",
    sourceObservedHash: "h-src",
    targetObservedHash: "h-tgt",
    status: "open",
    resolutionChoice: null,
    resolvedBy: null,
    resolvedAt: null,
    sourceNativeId: "42",
    details: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

async function mountView(conflicts: ParkedConflictDto[], role: SessionRole) {
  listMock.mockResolvedValue({ conflicts });
  const wrapper = mount(ConflictResolutionView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConflictResolutionView — SU-3", () => {
  it("renders the three conflict kinds visibly distinct (SU-3.1)", async () => {
    const wrapper = await mountView(
      [
        conflict({ id: "c-field", kind: "manual-resolve" }),
        conflict({ id: "c-withheld", kind: "withheld" }),
        conflict({ id: "c-delete", kind: "drifted-delete", fieldPath: null }),
      ],
      "operator",
    );
    expect(wrapper.get('[data-testid="conflict-kind-c-field"]').text()).toContain("field conflict");
    expect(wrapper.get('[data-testid="conflict-kind-c-withheld"]').text()).toContain(
      "no action needed",
    );
    expect(wrapper.get('[data-testid="conflict-kind-c-delete"]').text()).toContain(
      "drifted delete",
    );
    // Field conflict → source/target buttons; delete → propagate/sever buttons.
    expect(wrapper.find('[data-testid="resolve-source-wins-c-field"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="resolve-propagate-c-delete"]').exists()).toBe(true);
  });

  it("labels an auto-LWW withheld row as no action needed and offers no decision (SU-3 note)", async () => {
    const wrapper = await mountView([conflict({ id: "c-withheld", kind: "withheld" })], "operator");
    expect(wrapper.find('[data-testid="conflict-no-action-c-withheld"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="resolve-source-wins-c-withheld"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="resolve-target-wins-c-withheld"]').exists()).toBe(false);
  });

  it("resolves a field conflict by side and reflects the pipeline re-run (SU-3.2)", async () => {
    const response: ResolveParkedConflictResponse = {
      id: "c-1",
      outcome: "enqueued",
      resolution: "source-wins",
      conflict: conflict(),
    };
    resolveMock.mockResolvedValue(response);
    const wrapper = await mountView([conflict()], "operator");

    await wrapper.get('[data-testid="resolve-source-wins-c-1"]').trigger("click");
    await flushPromises();

    expect(resolveMock).toHaveBeenCalledWith("c-1", { resolution: "source-wins" });
    expect(wrapper.get('[data-testid="resolve-outcome"]').text()).toContain(
      "re-runs through the normal pipeline",
    );
  });

  it("offers exactly propagate / sever for a drifted delete and calls SA-4 (SU-3.3)", async () => {
    const applied: ResolveParkedConflictResponse = {
      id: "c-delete",
      outcome: "applied",
      resolution: "sever",
      conflict: conflict({ id: "c-delete", kind: "drifted-delete", status: "resolved" }),
    };
    resolveMock.mockResolvedValue(applied);
    listMock
      .mockResolvedValueOnce({
        conflicts: [conflict({ id: "c-delete", kind: "drifted-delete", fieldPath: null })],
      })
      .mockResolvedValue({ conflicts: [] });
    const wrapper = mount(ConflictResolutionView, { global: testGlobalOptions() });
    useAuthStore().$patch({ state: { status: "authenticated", identity: "op", role: "operator" } });
    await flushPromises();

    // Exactly the two CF-7 outcomes are offered.
    expect(wrapper.find('[data-testid="resolve-propagate-c-delete"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="resolve-sever-c-delete"]').exists()).toBe(true);

    await wrapper.get('[data-testid="resolve-sever-c-delete"]').trigger("click");
    await flushPromises();

    expect(resolveMock).toHaveBeenCalledWith("c-delete", { resolution: "sever" });
    expect(wrapper.get('[data-testid="resolve-outcome"]').text()).toContain("severed");
    // Resolved item leaves the queue (SU-3.5).
    expect(wrapper.find('[data-testid="conflict-c-delete"]').exists()).toBe(false);
  });

  it("renders read-only for a viewer — no resolution controls (SU-3.4)", async () => {
    const wrapper = await mountView(
      [conflict(), conflict({ id: "c-delete", kind: "drifted-delete", fieldPath: null })],
      "viewer",
    );
    expect(wrapper.find('[data-testid="conflict-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="resolve-source-wins-c-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="resolve-propagate-c-delete"]').exists()).toBe(false);
  });
});
