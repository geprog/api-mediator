import type {
  ApproveProposalResponse,
  MappingProposalDetailResponse,
  MappingProposalItemDto,
  SessionRole,
} from "@mediator/contracts";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { approveMappingProposal, getMappingProposalDetail } from "../api/mapping-proposals";
import { useAuthStore } from "../stores/auth";
import { testGlobalOptions } from "../testing/render";
import ProposalReviewView from "./ProposalReviewView.vue";

vi.mock("vue-router", async () => {
  const { RouterLinkStub } = await import("@vue/test-utils");
  return {
    useRoute: () => ({ params: { id: "prop-1" } }),
    useRouter: () => ({ push: vi.fn() }),
    RouterLink: RouterLinkStub,
  };
});

vi.mock("../api/mapping-proposals", () => ({
  analyzeResourcePair: vi.fn(),
  approveMappingProposal: vi.fn(),
  confirmIdentityKey: vi.fn(),
  getMappingProposalDetail: vi.fn(),
  listMappingProposals: vi.fn(),
  recordProposalItemDecision: vi.fn(),
}));

const getDetailMock = vi.mocked(getMappingProposalDetail);
const approveMock = vi.mocked(approveMappingProposal);

function field(
  id: string,
  overrides: Partial<MappingProposalItemDto> = {},
): MappingProposalItemDto {
  return {
    id,
    proposalId: "prop-1",
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: id } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: id } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    reviewRequired: false,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "r",
    reviewState: "accepted",
    ...overrides,
  };
}

function detail(
  overrides: Partial<MappingProposalDetailResponse> = {},
): MappingProposalDetailResponse {
  return {
    proposal: {
      id: "prop-1",
      sourceSpecId: "s",
      targetSpecId: "t",
      status: "pending",
      generatedBy: { providerId: "ollama", model: "gemma", promptVersion: "v1" },
      createdAt: "2026-07-11T00:00:00.000Z",
    },
    items: [field("risky", { reviewRequired: true, confidenceScore: 0.2 }), field("safe")],
    shortlist: { noCounterpartResources: [], analysisFailedPairs: [] },
    analysisExclusions: [],
    ...overrides,
  };
}

async function mountReview(detailValue: MappingProposalDetailResponse, role: SessionRole) {
  getDetailMock.mockResolvedValue(detailValue);
  const wrapper = mount(ProposalReviewView, { global: testGlobalOptions() });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProposalReviewView (RU-1/RU-4)", () => {
  it("renders items in the API's confidence order (no re-sort)", async () => {
    const wrapper = await mountReview(detail(), "operator");
    const ids = wrapper
      .findAll('[data-testid^="item-card-"]')
      .map((node) => node.attributes("data-testid"));
    expect(ids).toEqual(["item-card-risky", "item-card-safe"]);
  });

  it("renders a failed proposal as needs-attention, not an empty list", async () => {
    const wrapper = await mountReview(
      detail({ proposal: { ...detail().proposal, status: "failed" }, items: [], shortlist: null }),
      "operator",
    );
    expect(wrapper.find('[data-testid="review-failed"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="item-card-"]')).toHaveLength(0);
  });

  it("shows the identity-key panel for a peer-peer proposal", async () => {
    const wrapper = await mountReview(detail(), "operator");
    expect(wrapper.find('[data-testid="identity-panel"]').exists()).toBe(true);
  });

  it("hides the identity-key panel for a consumer-provider proposal", async () => {
    const parameter = field("param", {
      kind: "parameter",
      targetRef: {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "op", parameter: "q" },
      },
    });
    const phased = field("body", { phase: "request" });
    const wrapper = await mountReview(detail({ items: [phased, parameter] }), "operator");
    expect(wrapper.find('[data-testid="identity-panel"]').exists()).toBe(false);
  });

  it("reflects partially_approved with the identity-key enablement gate (peer-peer, no key)", async () => {
    const response: ApproveProposalResponse = {
      outcome: "partially_approved",
      mapping: { id: "m1", variant: "peer-peer", status: "active" },
    };
    approveMock.mockResolvedValue(response);
    const wrapper = await mountReview(detail(), "operator");

    await wrapper.get('[data-testid="approve-button"]').trigger("click");
    await flushPromises();

    const outcome = wrapper.get('[data-testid="approve-outcome"]').text();
    expect(outcome).toContain("Partially approved");
    expect(outcome).toContain("cannot be enabled until an identity key");
    // Must not imply the mapping is live — it states the opposite (RU-4 crit 6).
    expect(outcome).toContain("Nothing is running yet");
  });

  it("reflects an approved consumer-provider mapping as instantiated-disabled", async () => {
    const response: ApproveProposalResponse = {
      outcome: "approved",
      mapping: { id: "m2", variant: "consumer-provider", status: "active" },
    };
    approveMock.mockResolvedValue(response);
    const parameter = field("param", {
      kind: "parameter",
      targetRef: {
        resourceRef: "tasks",
        target: { kind: "parameter", operationId: "op", parameter: "q" },
      },
    });
    const wrapper = await mountReview(
      detail({ items: [field("body", { phase: "request" }), parameter] }),
      "operator",
    );

    await wrapper.get('[data-testid="approve-button"]').trigger("click");
    await flushPromises();

    const outcome = wrapper.get('[data-testid="approve-outcome"]').text();
    expect(outcome).toContain("Approved");
    expect(outcome).toContain("nothing is running yet");
  });

  it("renders read-only for a viewer (no approve, no item controls)", async () => {
    const wrapper = await mountReview(detail(), "viewer");
    expect(wrapper.find('[data-testid="review-readonly"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="review-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="item-accept"]').exists()).toBe(false);
  });
});
