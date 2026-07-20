import type { ScopeCorrespondenceDto } from "@mediator/contracts";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../../testing/render";
import ScopeIdentityKeyPanel from "./ScopeIdentityKeyPanel.vue";

function correspondence(overrides: Partial<ScopeCorrespondenceDto> = {}): ScopeCorrespondenceDto {
  return {
    id: "corr-1",
    resourcePairRef: "pair-issues-tasks",
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: "app-vikunja", resourceRef: "projects" },
    confirmedBy: null,
    confirmedAt: null,
    ...overrides,
  };
}

function mountPanel(
  value: ScopeCorrespondenceDto | null,
  props: Partial<{ readonly: boolean; pending: boolean; errorMessage: string | null }> = {},
) {
  return mount(ScopeIdentityKeyPanel, {
    props: {
      correspondence: value,
      readonly: props.readonly ?? false,
      pending: props.pending ?? false,
      errorMessage: props.errorMessage ?? null,
    },
    global: testGlobalOptions(),
  });
}

describe("ScopeIdentityKeyPanel (SS-15.4)", () => {
  it("pre-selects the derived candidate pairing (derive-then-correct) without auto-confirming", () => {
    const wrapper = mountPanel(correspondence());

    const target = wrapper.get<HTMLInputElement>('[data-testid="scope-identity-target-name"]');
    expect(target.element.value).toBe("title");
    expect(wrapper.get('[data-testid="scope-identity-pairing-name"]').text()).toContain("name");
    // Unconfirmed until the operator acts.
    expect(wrapper.find('[data-testid="scope-identity-unconfirmed"]').exists()).toBe(true);
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("confirms the value-preserving pairing → emits the confirm request for the pair", async () => {
    const wrapper = mountPanel(correspondence());

    await wrapper.get('[data-testid="scope-identity-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([
      [
        {
          resourcePairRef: "pair-issues-tasks",
          scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
        },
      ],
    ]);
  });

  it("lets the operator correct the target field before confirming (derive-then-correct)", async () => {
    const wrapper = mountPanel(correspondence());

    await wrapper.get('[data-testid="scope-identity-target-name"]').setValue("display_title");
    await wrapper.get('[data-testid="scope-identity-confirm"]').trigger("click");

    expect(wrapper.emitted("confirm")).toEqual([
      [
        {
          resourcePairRef: "pair-issues-tasks",
          scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "display_title" }],
        },
      ],
    ]);
  });

  it("flags a value-altering pairing as ineligible (server enforces the rename-only rule)", () => {
    const wrapper = mountPanel(
      correspondence({
        scopeIdentityKey: [
          { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "coerce" } },
        ],
      }),
    );
    expect(wrapper.find('[data-testid="scope-identity-nonrename-name"]').exists()).toBe(true);
  });

  it("surfaces the value-preserving lock error from the server", () => {
    const wrapper = mountPanel(correspondence(), {
      errorMessage: "a scope identity key pairing must be value-preserving (rename)",
    });
    expect(wrapper.get('[data-testid="scope-identity-error"]').text()).toContain(
      "value-preserving",
    );
  });

  it("shows a confirmed tag when the correspondence is already confirmed", () => {
    const wrapper = mountPanel(
      correspondence({ confirmedBy: "ops", confirmedAt: "2026-07-19T00:00:00.000Z" }),
    );
    expect(wrapper.find('[data-testid="scope-identity-confirmed"]').exists()).toBe(true);
  });

  it("renders an empty state when the pair has no correspondence yet", () => {
    const wrapper = mountPanel(null);
    expect(wrapper.find('[data-testid="scope-identity-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="scope-identity-confirm"]').exists()).toBe(false);
  });

  it("is read-only for a viewer — no confirm control, disabled target input (OA-2)", () => {
    const wrapper = mountPanel(correspondence(), { readonly: true });
    expect(wrapper.find('[data-testid="scope-identity-confirm"]').exists()).toBe(false);
    const target = wrapper.get('[data-testid="scope-identity-target-name"]')
      .element as HTMLInputElement;
    expect(target.disabled).toBe(true);
  });
});
