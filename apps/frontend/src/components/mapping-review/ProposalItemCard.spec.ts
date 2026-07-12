import type { MappingProposalItemDto } from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../api/errors";
import { recordProposalItemDecision } from "../../api/mapping-proposals";
import { testGlobalOptions } from "../../testing/render";
import ProposalItemCard from "./ProposalItemCard.vue";

vi.mock("../../api/mapping-proposals", () => ({
  analyzeResourcePair: vi.fn(),
  approveMappingProposal: vi.fn(),
  confirmIdentityKey: vi.fn(),
  getMappingProposalDetail: vi.fn(),
  listMappingProposals: vi.fn(),
  recordProposalItemDecision: vi.fn(),
}));

const decisionMock = vi.mocked(recordProposalItemDecision);

const PROPOSAL_ID = "prop-1";

function fieldItem(overrides: Partial<MappingProposalItemDto> = {}): MappingProposalItemDto {
  return {
    id: "item-1",
    proposalId: PROPOSAL_ID,
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "title" } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: "name" } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.82,
    reviewRequired: false,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "title maps to name",
    reviewState: "pending",
    ...overrides,
  };
}

function mountCard(item: MappingProposalItemDto, readonly = false) {
  return mount(ProposalItemCard, {
    props: { item, proposalId: PROPOSAL_ID, readonly },
    global: testGlobalOptions(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  decisionMock.mockResolvedValue({ item: fieldItem({ reviewState: "accepted" }) });
});

describe("ProposalItemCard (RU-1/RU-2)", () => {
  it("renders kind, refs, confidence and rationale", () => {
    const wrapper = mountCard(fieldItem());
    expect(wrapper.get('[data-testid="item-kind"]').text()).toContain("field");
    expect(wrapper.get('[data-testid="item-confidence"]').text()).toContain("82%");
    expect(wrapper.get('[data-testid="item-rationale"]').text()).toContain("title maps to name");
    expect(wrapper.text()).toContain("issues · field title");
    expect(wrapper.text()).toContain("tasks · field name");
  });

  it("gives an unmapped item the accept-unmapped / supply-a-target choice", () => {
    const wrapper = mountCard(
      fieldItem({ unmapped: true, targetRef: undefined, transformSuggestion: undefined }),
    );
    expect(wrapper.find('[data-testid="item-unmapped"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="item-accept-unmapped"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="item-supply-target"]').exists()).toBe(true);
    // Not the ordinary accept/reject controls.
    expect(wrapper.find('[data-testid="item-accept"]').exists()).toBe(false);
  });

  it("accepts via RA-2", async () => {
    const wrapper = mountCard(fieldItem());
    await wrapper.get('[data-testid="item-accept"]').trigger("click");
    await flushPromises();
    expect(decisionMock).toHaveBeenCalledWith(PROPOSAL_ID, "item-1", { decision: "accept" });
  });

  it("rejects via RA-2 and communicates permanence", async () => {
    const wrapper = mountCard(fieldItem());
    await wrapper.get('[data-testid="item-reject"]').trigger("click");
    await flushPromises();
    expect(decisionMock).toHaveBeenCalledWith(PROPOSAL_ID, "item-1", { decision: "reject" });

    const rejected = mountCard(fieldItem({ reviewState: "rejected" }));
    expect(rejected.find('[data-testid="item-rejected-permanent"]').exists()).toBe(true);
  });

  it("records an ambiguous alternative as an edit to that target (RU-2 crit 2)", async () => {
    const wrapper = mountCard(
      fieldItem({
        ambiguousAlternatives: [
          {
            targetRef: { resourceRef: "tasks", target: { kind: "field", path: "label" } },
            confidence: 0.4,
          },
        ],
      }),
    );
    await wrapper.get('[data-testid="item-alternative-0"]').trigger("click");
    await flushPromises();
    expect(decisionMock).toHaveBeenCalledWith(PROPOSAL_ID, "item-1", {
      decision: "edit",
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "label" } },
    });
  });

  it("submits a target-path/transform edit via RA-2", async () => {
    const wrapper = mountCard(fieldItem());
    await wrapper.get('[data-testid="item-edit"]').trigger("click");
    await wrapper.get('[data-testid="item-edit-path"]').setValue("displayName");
    await wrapper.get('[data-testid="item-save-edit"]').trigger("click");
    await flushPromises();
    expect(decisionMock).toHaveBeenCalledWith(PROPOSAL_ID, "item-1", {
      decision: "edit",
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "displayName" } },
      transform: { transform: "rename" },
    });
  });

  it("shows a server edit-validation error without losing entered input (RU-2 crit 3)", async () => {
    decisionMock.mockRejectedValue(
      new ApiError({ statusCode: 400, error: "Bad Request", message: "unresolvable target ref" }),
    );
    const wrapper = mountCard(fieldItem());
    await wrapper.get('[data-testid="item-edit"]').trigger("click");
    await wrapper.get('[data-testid="item-edit-path"]').setValue("nope");
    await wrapper.get('[data-testid="item-save-edit"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="item-edit-error"]').text()).toContain(
      "unresolvable target ref",
    );
    // The form stays open with the entered value intact.
    const input = wrapper.get<HTMLInputElement>('[data-testid="item-edit-path"]').element;
    expect(input.value).toBe("nope");
  });

  it("renders read-only for a viewer (no mutation controls)", () => {
    const wrapper = mountCard(fieldItem(), true);
    expect(wrapper.find('[data-testid="item-accept"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="item-edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="item-reject"]').exists()).toBe(false);
    // The information is still rendered.
    expect(wrapper.get('[data-testid="item-kind"]').text()).toContain("field");
  });
});
