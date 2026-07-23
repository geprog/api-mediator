import type { ProposalShortlistDto } from "@mediator/contracts";
import type { NoCounterpartResource } from "@mediator/domain";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeResourcePair } from "../../api/mapping-proposals";
import { testGlobalOptions } from "../../testing/render";
import NoCounterpartPanel from "./NoCounterpartPanel.vue";

vi.mock("../../api/mapping-proposals", () => ({
  analyzeResourcePair: vi.fn(),
  approveMappingProposal: vi.fn(),
  confirmIdentityKey: vi.fn(),
  getMappingProposalDetail: vi.fn(),
  listMappingProposals: vi.fn(),
  recordProposalItemDecision: vi.fn(),
}));

const analyzeMock = vi.mocked(analyzeResourcePair);

const SOURCE_SPEC = "spec-source";
const TARGET_SPEC = "spec-target";

const shortlist: ProposalShortlistDto = {
  noCounterpartResources: [{ specId: SOURCE_SPEC, resourceRef: "webhooks" }],
  analysisFailedPairs: [
    {
      sourceResource: "labels",
      targetResource: "tags",
      confidence: 0.5,
      rationale: "detail call failed",
    },
  ],
};

const exclusions: NoCounterpartResource[] = [{ specId: SOURCE_SPEC, resourceRef: "audit" }];

function mountPanel(readonly = false, shortlistValue: ProposalShortlistDto | null = shortlist) {
  return mount(NoCounterpartPanel, {
    props: {
      proposalId: "prop-1",
      sourceSpecId: SOURCE_SPEC,
      targetSpecId: TARGET_SPEC,
      shortlist: shortlistValue,
      analysisExclusions: exclusions,
      readonly,
    },
    global: testGlobalOptions(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  analyzeMock.mockResolvedValue({
    outcome: "attached",
    attachedItemCount: 2,
    shortlist: { noCounterpartResources: [], analysisFailedPairs: [] },
  });
});

describe("NoCounterpartPanel (RU-3)", () => {
  it("keeps no-counterpart (with escape hatch) distinct from excluded (no action)", () => {
    const wrapper = mountPanel();

    // No-counterpart carries the analyze-anyway escape hatch.
    expect(wrapper.find('[data-testid="no-counterpart-webhooks"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="no-counterpart-analyze-webhooks"]').exists()).toBe(true);

    // Excluded is listed separately with NO analyze action.
    expect(wrapper.find('[data-testid="excluded-audit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="no-counterpart-analyze-audit"]').exists()).toBe(false);
  });

  it("shows analysis-failed pairs as needing attention", () => {
    const wrapper = mountPanel();
    expect(wrapper.find('[data-testid="analysis-failed-labels"]').exists()).toBe(true);
  });

  it("triggers RA-5 for the chosen counterpart in the proposal direction", async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="no-counterpart-input-webhooks"]').setValue("events");
    await wrapper.get('[data-testid="no-counterpart-analyze-webhooks"]').trigger("click");
    await flushPromises();

    // webhooks is on the source spec → it is the source side, events the target.
    expect(analyzeMock).toHaveBeenCalledWith("prop-1", {
      sourceResourceRef: "webhooks",
      targetResourceRef: "events",
    });
  });

  it("is read-only for a viewer (no escape-hatch action)", () => {
    const wrapper = mountPanel(true);
    expect(wrapper.find('[data-testid="no-counterpart-analyze-webhooks"]').exists()).toBe(false);
    // The resource is still shown.
    expect(wrapper.find('[data-testid="no-counterpart-webhooks"]').exists()).toBe(true);
  });

  it("marks the shortlist unavailable on a failed proposal", () => {
    const wrapper = mountPanel(false, null);
    expect(wrapper.find('[data-testid="no-counterpart-unavailable"]').exists()).toBe(true);
    // Exclusions still render (they are not part of the shortlist).
    expect(wrapper.find('[data-testid="excluded-audit"]').exists()).toBe(true);
  });

  /**
   * SL-9.4 — an excluded resource is listed **as excluded**, in its own group, and
   * carries no "analyze anyway" action even for an operator: re-inclusion (removing it
   * from `analysisExclusions`) is the only way to analyze it, so the operator's declared
   * scope stays the single source of truth rather than being overridable from the review
   * screen.
   */
  it("offers an operator no way to analyze an excluded resource (SL-9.4)", () => {
    const wrapper = mountPanel(false);

    // The excluded resource lives in the excluded group, tagged `excluded` — NOT in the
    // no-counterpart group, so it never reads as "the shortlist found nothing".
    const excludedGroup = wrapper.get('[data-testid="excluded-group"]');
    expect(excludedGroup.find('[data-testid="excluded-audit"]').exists()).toBe(true);
    expect(excludedGroup.text()).toContain("excluded");
    expect(wrapper.get('[data-testid="no-counterpart-group"]').text()).not.toContain("audit");

    // No escape hatch of any kind for it: no analyze button, no counterpart input.
    expect(wrapper.find('[data-testid="no-counterpart-analyze-audit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="no-counterpart-input-audit"]').exists()).toBe(false);
    expect(excludedGroup.findAll("button")).toHaveLength(0);
    expect(excludedGroup.findAll("input")).toHaveLength(0);

    // ...and the panel says why re-inclusion is the only path.
    expect(excludedGroup.text()).toContain("analyze anyway");
  });
});
