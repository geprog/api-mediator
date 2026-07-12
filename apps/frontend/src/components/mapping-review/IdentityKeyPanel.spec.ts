import type { MappingProposalItemDto } from "@mediator/contracts";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../../testing/render";
import IdentityKeyPanel from "./IdentityKeyPanel.vue";

function fieldItem(overrides: Partial<MappingProposalItemDto> = {}): MappingProposalItemDto {
  return {
    id: "item-1",
    proposalId: "prop-1",
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "id" } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: "ref" } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.95,
    reviewRequired: false,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "id maps to ref",
    reviewState: "accepted",
    ...overrides,
  };
}

function mountPanel(
  items: MappingProposalItemDto[],
  props: Partial<{ readonly: boolean; pending: boolean; errorMessage: string | null }> = {},
) {
  return mount(IdentityKeyPanel, {
    props: {
      items,
      readonly: props.readonly ?? false,
      pending: props.pending ?? false,
      errorMessage: props.errorMessage ?? null,
    },
    global: testGlobalOptions(),
  });
}

describe("IdentityKeyPanel (RU-4 crit 1-3)", () => {
  it("pre-selects the identityCandidate but does not auto-confirm", () => {
    const items = [
      fieldItem({ id: "a" }),
      fieldItem({ id: "b", identityCandidate: true, targetLookupParamRef: "taskRef" }),
    ];
    const wrapper = mountPanel(items);

    const suggested = wrapper.get<HTMLInputElement>('[data-testid="identity-candidate-b"]');
    expect(suggested.element.checked).toBe(true);
    expect(wrapper.find('[data-testid="identity-suggested-b"]').exists()).toBe(true);
    // The lookup parameter is pre-filled from the suggestion.
    const lookup = wrapper.get<HTMLInputElement>('[data-testid="identity-lookup-param"]');
    expect(lookup.element.value).toBe("taskRef");
    // Nothing confirmed until the operator acts.
    expect(wrapper.emitted("confirm")).toBeUndefined();
    // The consequence is stated: confirming also approves.
    expect(wrapper.get('[data-testid="identity-consequence"]').text()).toContain("also approves");
  });

  it("emits an explicit confirmation with the selected item + lookup param", async () => {
    const items = [
      fieldItem({ id: "b", identityCandidate: true, targetLookupParamRef: "taskRef" }),
    ];
    const wrapper = mountPanel(items);

    await wrapper.get('[data-testid="identity-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([
      [{ itemId: "b", targetLookupParamRef: "taskRef" }],
    ]);
  });

  it("surfaces the rename-only / shared-pairing lock error from the server", () => {
    const items = [fieldItem({ id: "a" })];
    const wrapper = mountPanel(items, {
      errorMessage: "identity key must be a value-preserving (rename) pairing",
    });
    expect(wrapper.get('[data-testid="identity-error"]').text()).toContain("rename");
  });

  it("flags a non-rename candidate as ineligible (server enforces)", () => {
    const items = [fieldItem({ id: "a", transformSuggestion: { transform: "coerce" } })];
    const wrapper = mountPanel(items);
    expect(wrapper.find('[data-testid="identity-nonrename-a"]').exists()).toBe(true);
  });

  it("is read-only for a viewer (no confirm control)", () => {
    const items = [fieldItem({ id: "b", identityCandidate: true })];
    const wrapper = mountPanel(items, { readonly: true });
    expect(wrapper.find('[data-testid="identity-confirm"]').exists()).toBe(false);
  });
});
