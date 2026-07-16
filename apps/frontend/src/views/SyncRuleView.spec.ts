import type {
  EnableSyncRuleResponse,
  SessionRole,
  SyncRuleResourcePairDto,
  SyncRuleStatusDto,
} from "@mediator/contracts";
import { flushPromises, mount, RouterLinkStub } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureSyncRule, enableSyncRule, listSyncRules } from "../api/sync";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import SyncRuleView from "./SyncRuleView.vue";

vi.mock("vue-router", async () => {
  const { RouterLinkStub: stub } = await import("@vue/test-utils");
  return {
    useRoute: () => ({ params: { id: "rule-1" } }),
    useRouter: () => ({ push: vi.fn() }),
    RouterLink: stub,
  };
});

vi.mock("../api/sync", () => ({
  listSyncRules: vi.fn(),
  listSyncEvents: vi.fn(),
  configureSyncRule: vi.fn(),
  enableSyncRule: vi.fn(),
  disableSyncRule: vi.fn(),
}));

const listSyncRulesMock = vi.mocked(listSyncRules);
const enableSyncRuleMock = vi.mocked(enableSyncRule);
const configureSyncRuleMock = vi.mocked(configureSyncRule);

const PAIR: SyncRuleResourcePairDto = {
  source: { appId: "app-gitea", appName: "Gitea", resourceRef: "issues" },
  target: { appId: "app-vikunja", appName: "Vikunja", resourceRef: "tasks" },
};

function rule(overrides: Partial<SyncRuleStatusDto> = {}): SyncRuleStatusDto {
  return {
    id: "rule-1",
    approvedMappingId: "mapping-1",
    status: "disabled",
    backfillStatus: null,
    backfillMode: null,
    deletePropagation: "ignore",
    targetDriftCheck: "none",
    pollIntervalOverride: null,
    pollOperationRef: "issues.list",
    lastRunAt: null,
    lastEventAt: null,
    resourcePairRef: "pair-issues-tasks",
    resourcePair: PAIR,
    stillNeeds: [],
    pollerLag: { lastRunAt: null, expectedIntervalMs: null, lagMs: null, stuck: false },
    ...overrides,
  };
}

async function mountView(rules: SyncRuleStatusDto[], role: SessionRole) {
  listSyncRulesMock.mockResolvedValue({ rules });
  const wrapper = mount(SyncRuleView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SyncRuleView — SU-1 enablement gate", () => {
  it("renders the checklist from stillNeeds and disables enable until satisfied (SU-1.1)", async () => {
    const wrapper = await mountView(
      [
        rule({
          stillNeeds: [
            { kind: "identity-key", issue: "missing", confirmedCount: 0 },
            { kind: "poll-operation-ref" },
          ],
        }),
      ],
      "operator",
    );
    expect(wrapper.find('[data-testid="checklist-item-identity-key"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="checklist-item-poll-operation-ref"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="enablement-ready"]').exists()).toBe(false);
    const enableButton = wrapper.get('[data-testid="enable-button"]');
    expect(enableButton.attributes("disabled")).toBeDefined();
  });

  it("never preselects a backfill mode; enable stays disabled until a choice is made (SU-1.2)", async () => {
    const wrapper = await mountView([rule()], "operator");
    // No radio is checked on render.
    for (const testid of ["backfill-link-only", "backfill-push", "backfill-skip"]) {
      const radio = wrapper.get(`[data-testid="${testid}"]`).element as HTMLInputElement;
      expect(radio.checked).toBe(false);
    }
    // Gate satisfied, but no choice yet → enable disabled.
    expect(wrapper.get('[data-testid="enable-button"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="backfill-link-only"]').setValue(true);
    expect(wrapper.get('[data-testid="enable-button"]').attributes("disabled")).toBeUndefined();
  });

  it("enables with the chosen backfill mode via SA-1 and reflects not-yet-polling (SU-1.5)", async () => {
    const accepted: EnableSyncRuleResponse = {
      outcome: "accepted",
      backfillRequired: true,
      degradations: [],
    };
    enableSyncRuleMock.mockResolvedValue(accepted);
    const wrapper = await mountView([rule()], "operator");

    await wrapper.get('[data-testid="backfill-link-only"]').setValue(true);
    await wrapper.get('[data-testid="enable-button"]').trigger("click");
    await flushPromises();

    expect(enableSyncRuleMock).toHaveBeenCalledWith("rule-1", {
      action: "backfill",
      backfillMode: "link-only",
    });
    const outcome = wrapper.get('[data-testid="enable-outcome"]').text();
    expect(outcome).toContain("not polling yet");
  });

  it("shows an enabled+running-backfill rule as not yet polling (SU-1.5 / BE-3)", async () => {
    const wrapper = await mountView(
      [rule({ status: "enabled", backfillStatus: "running" })],
      "operator",
    );
    expect(wrapper.get('[data-testid="rule-polling-state"]').text()).toContain("not yet polling");
    expect(wrapper.find('[data-testid="disable-button"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="enable-button"]').exists()).toBe(false);
  });

  it("prevents push on both directions of a bidirectional pair (SU-1.2)", async () => {
    const forward = rule({ id: "rule-1" });
    const reverse = rule({ id: "rule-2", backfillMode: "push" });
    const wrapper = await mountView([forward, reverse], "operator");

    const pushRadio = wrapper.get('[data-testid="backfill-push"]').element as HTMLInputElement;
    expect(pushRadio.disabled).toBe(true);
    expect(wrapper.find('[data-testid="push-blocked-note"]').exists()).toBe(true);
  });

  it("states the neither-lookup-path degradation and permits enable only with skip (SU-1.3)", async () => {
    const wrapper = await mountView(
      [rule({ stillNeeds: [{ kind: "identity-lookup-path" }] })],
      "operator",
    );
    expect(wrapper.find('[data-testid="enablement-degradation-lookup"]').exists()).toBe(true);
    // link-only / push are disabled; only skip clears the degradation.
    expect(
      (wrapper.get('[data-testid="backfill-link-only"]').element as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (wrapper.get('[data-testid="backfill-push"]').element as HTMLInputElement).disabled,
    ).toBe(true);

    await wrapper.get('[data-testid="backfill-skip"]').setValue(true);
    expect(wrapper.get('[data-testid="enable-button"]').attributes("disabled")).toBeUndefined();
  });

  it("states one-way source-of-truth semantics and offers the targetDriftCheck opt-in (SU-1.4)", async () => {
    configureSyncRuleMock.mockResolvedValue(rule({ targetDriftCheck: "read-before-write" }));
    const wrapper = await mountView([rule()], "operator");

    expect(wrapper.find('[data-testid="enablement-oneway"]').exists()).toBe(true);
    await wrapper.get('[data-testid="target-drift-check"]').setValue(true);
    await flushPromises();
    expect(configureSyncRuleMock).toHaveBeenCalledWith("rule-1", {
      targetDriftCheck: "read-before-write",
    });
  });

  it("renders read-only for a viewer — no enable/disable/config controls (SU-1.6)", async () => {
    const wrapper = await mountView([rule()], "viewer");
    expect(wrapper.find('[data-testid="rule-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="enable-button"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="backfill-choice"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="target-drift-check"]').exists()).toBe(false);
  });
});

describe("SyncRuleView — SU-5 binding-ref blockers", () => {
  it("lists an unconfirmed required ref as a blocker linking to the binding panel (SU-5.1)", async () => {
    const wrapper = await mountView(
      [
        rule({
          stillNeeds: [
            { kind: "binding-ref", ref: "nativeIdRef", side: "target", usedFor: "native-id" },
          ],
        }),
      ],
      "operator",
    );
    expect(
      wrapper.find('[data-testid="checklist-item-binding-ref:target:nativeIdRef"]').exists(),
    ).toBe(true);
    const links = wrapper.findAllComponents(RouterLinkStub);
    expect(links.some((link) => link.props("to") === "/apps/app-vikunja")).toBe(true);
    // Enable is blocked while a required ref is unconfirmed.
    expect(wrapper.get('[data-testid="enable-button"]').attributes("disabled")).toBeDefined();
  });

  it("shows changeTimestampRef as a degradation, never a checklist blocker (SU-5.2)", async () => {
    const wrapper = await mountView(
      [
        rule({
          stillNeeds: [
            { kind: "binding-ref", ref: "deltaCursorRef", side: "source", usedFor: "delta-cursor" },
          ],
        }),
      ],
      "operator",
    );
    // The change-timestamp degradation note is present...
    expect(wrapper.find('[data-testid="enablement-degradation-timestamp"]').exists()).toBe(true);
    // ...and no checklist blocker is ever a changeTimestampRef (structurally excluded).
    expect(wrapper.html()).not.toContain("checklist-item-binding-ref:source:changeTimestampRef");
    expect(wrapper.html()).not.toContain("checklist-item-binding-ref:target:changeTimestampRef");
  });
});

describe("SyncRuleView — SS-6 scope-binding blockers", () => {
  it("lists an unconfirmed scope binding as a blocker naming the parameter+resource, linked to the binding panel (SS-6.1)", async () => {
    const wrapper = await mountView(
      [
        rule({
          stillNeeds: [
            {
              kind: "scope-binding",
              parameterName: "owner",
              side: "source",
              resourceRef: "issues",
            },
          ],
        }),
      ],
      "operator",
    );

    const item = wrapper.find('[data-testid="checklist-item-scope-binding:source:owner"]');
    expect(item.exists()).toBe(true);
    expect(item.text()).toContain("owner");
    expect(item.text()).toContain("issues");
    // Deep-links to the source side's app (SA-2 carries the app id), reaching RB-3.
    const links = wrapper.findAllComponents(RouterLinkStub);
    expect(links.some((link) => link.props("to") === "/apps/app-gitea")).toBe(true);
    // SU-1 gate: enable stays disabled while any scope binding is unconfirmed.
    expect(wrapper.get('[data-testid="enable-button"]').attributes("disabled")).toBeDefined();
  });

  it("renders the scope-binding blocker read-only for a viewer — no supply control on this panel (SS-6.4)", async () => {
    const wrapper = await mountView(
      [
        rule({
          stillNeeds: [
            {
              kind: "scope-binding",
              parameterName: "owner",
              side: "source",
              resourceRef: "issues",
            },
          ],
        }),
      ],
      "viewer",
    );

    expect(wrapper.find('[data-testid="checklist-item-scope-binding:source:owner"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="rule-readonly"]').exists()).toBe(true);
    // The value is entered on the RB-3 binding panel — never here.
    expect(wrapper.find('[data-testid="scope-input-owner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="enable-button"]').exists()).toBe(false);
  });
});
