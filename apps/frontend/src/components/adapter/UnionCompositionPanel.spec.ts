import type { ComposeAdapterEndpointPreviewResponse } from "@mediator/contracts";
import type { PostMergePaginationConventionValue } from "@mediator/domain";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../../testing/render";
import UnionCompositionPanel from "./UnionCompositionPanel.vue";
import type { LinkDedupAvailability } from "./union-model";

type UnionAnalysis = NonNullable<ComposeAdapterEndpointPreviewResponse["union"]>;

function analysis(overrides: Partial<UnionAnalysis> = {}): UnionAnalysis {
  return {
    unserviceableFilters: ["status"],
    unconfiguredSortParameters: ["sortBy"],
    unconfiguredPaginationParameters: ["page", "pageSize"],
    dedupConflictPrecedence: "executionOrder-then-bindingId",
    largeCollectionRisk: { flagged: true, mitigation: "cacheTtl", cacheTtlConfigured: false },
    ...overrides,
  };
}

function mountPanel(props: {
  analysis?: UnionAnalysis | null;
  pagination?: PostMergePaginationConventionValue | null;
  paginationConfirmed?: boolean;
  linkDedupAvailability?: LinkDedupAvailability;
  readonly?: boolean;
}) {
  return mount(UnionCompositionPanel, {
    props: {
      analysis: props.analysis ?? analysis(),
      dedup: null,
      filters: [],
      sorts: [],
      pagination: props.pagination ?? null,
      paginationConfirmed: props.paginationConfirmed ?? false,
      linkDedupAvailability: props.linkDedupAvailability ?? { kind: "server-enforced" },
      dedupKeyFieldOptions: ["id", "email"],
      contributingExecutionOrders: [0, 1],
      cacheTtlConfigured: false,
      readonly: props.readonly ?? false,
    },
    global: testGlobalOptions(),
  });
}

describe("UnionCompositionPanel (CU-2)", () => {
  it("states the consequence of an unconfigured filter parameter (CU-2.1)", () => {
    const wrapper = mountPanel({});
    const consequence = wrapper.get('[data-testid="union-filter-consequence-status"]');
    expect(consequence.text()).toContain("rejected");
    expect(wrapper.find('[data-testid="union-filter-unconfigured-status"]').exists()).toBe(true);
  });

  it("renders the pagination heuristic as unconfirmed until confirmed (CU-2.2)", async () => {
    const wrapper = mountPanel({
      pagination: { convention: "offset", offsetParamRef: "skip", sizeParamRef: "take" },
      paginationConfirmed: false,
    });
    expect(wrapper.find('[data-testid="union-pagination-unconfirmed"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="union-pagination-confirmed"]').exists()).toBe(false);

    await wrapper.get('[data-testid="union-pagination-confirm"]').trigger("click");
    expect(wrapper.find('[data-testid="union-pagination-unconfirmed"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="union-pagination-confirmed"]').exists()).toBe(true);
  });

  it("renders an unconfigured sort parameter as unconfirmed (CU-2.2)", () => {
    const wrapper = mountPanel({});
    expect(wrapper.find('[data-testid="union-sort-unconfirmed-sortBy"]').exists()).toBe(true);
  });

  it("disables link-based dedup and names the missing nativeIdRef contributors (CU-2.3)", () => {
    const wrapper = mountPanel({
      linkDedupAvailability: {
        kind: "unavailable",
        missingContributors: ["backend-2 · tasks"],
      },
    });
    const radio = wrapper.get('[data-testid="union-dedup-record-link"]');
    expect(radio.attributes("disabled")).toBeDefined();
    const reason = wrapper.get('[data-testid="union-dedup-record-link-reason"]');
    expect(reason.text()).toContain("nativeIdRef");
    expect(reason.text()).toContain("backend-2 · tasks");
  });

  it("offers link-based dedup when every contributor's nativeIdRef is confirmed (CU-2.3)", () => {
    const wrapper = mountPanel({ linkDedupAvailability: { kind: "available" } });
    expect(
      wrapper.get('[data-testid="union-dedup-record-link"]').attributes("disabled"),
    ).toBeUndefined();
    expect(wrapper.find('[data-testid="union-dedup-record-link-reason"]').exists()).toBe(false);
  });

  it("flags the union-size risk and names cacheTtl as the mitigation (CU-2.5)", () => {
    const wrapper = mountPanel({});
    const risk = wrapper.get('[data-testid="union-size-risk"]');
    expect(risk.text()).toContain("cacheTtl");
    expect(risk.text()).toContain("fails");
  });

  it("renders read-only for a viewer — no editors (CU-2.6 / OA-2)", () => {
    const wrapper = mountPanel({
      pagination: { convention: "offset", offsetParamRef: "skip", sizeParamRef: "take" },
      readonly: true,
    });
    expect(wrapper.find('[data-testid="union-filter-field-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="union-pagination-confirm"]').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="union-dedup"]').find("fieldset").attributes("disabled"),
    ).toBeDefined();
  });
});
