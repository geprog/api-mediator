import type {
  ResourceBindingDto,
  ResourceBindingsResponse,
  SessionRole,
} from "@mediator/contracts";
import type { Ir } from "@mediator/domain";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getResourceBindings, updateResourceBinding } from "../../api/resource-bindings";
import { useAuthStore } from "../../stores/auth";
import { testGlobalOptions } from "../../testing/render";
import BindingPanel from "./BindingPanel.vue";

/** First binding of a fixture, guarded so tests never use a non-null assertion. */
function firstBinding(response: ResourceBindingsResponse): ResourceBindingDto {
  const binding = response.bindings[0];
  if (binding === undefined) {
    throw new Error("fixture is missing a binding");
  }
  return binding;
}

vi.mock("../../api/resource-bindings", () => ({
  getResourceBindings: vi.fn(),
  updateResourceBinding: vi.fn(),
}));

const getBindingsMock = vi.mocked(getResourceBindings);
const updateBindingMock = vi.mocked(updateResourceBinding);

const SPEC_ID = "spec-1";
const BINDING_ID = "binding-1";

const ir: Ir = [
  {
    resourceRef: "issues",
    name: "issues",
    operations: [
      {
        operationId: "issueList",
        method: "get",
        path: "/issues",
        parameters: [{ name: "page", location: "query", required: false }],
        responseSchema: {
          name: "Issue",
          fields: [{ name: "id", type: "integer", required: true }],
        },
      },
    ],
    schemas: [
      {
        name: "Issue",
        fields: [
          { name: "id", type: "integer", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    ],
    crossResourceRefs: [],
  },
];

/** Builds a bindings response; the three states are chosen per ref kind. */
function bindingsFixture(overrides: { collectionConfirmed?: boolean }): ResourceBindingsResponse {
  return {
    bindings: [
      {
        id: BINDING_ID,
        apiSpecId: SPEC_ID,
        resourceRef: "issues",
        refs: [
          {
            kind: "nativeIdRef",
            applicable: true,
            value: { kind: "field", path: "id" },
            confirmedBy: "operator@example.com",
            confirmedAt: "2026-07-10T00:00:00.000Z",
          },
          {
            kind: "collectionReadRef",
            applicable: true,
            value: { kind: "operation", operationId: "issueList" },
            confirmedBy: overrides.collectionConfirmed === true ? "operator@example.com" : null,
            confirmedAt: overrides.collectionConfirmed === true ? "2026-07-10T00:00:00.000Z" : null,
          },
          {
            kind: "paginationRef",
            applicable: true,
            value: null,
            confirmedBy: null,
            confirmedAt: null,
          },
          {
            kind: "deltaCursorRef",
            applicable: false,
            value: null,
            confirmedBy: null,
            confirmedAt: null,
          },
          {
            kind: "deltaDeletionRef",
            applicable: false,
            value: null,
            confirmedBy: null,
            confirmedAt: null,
          },
          {
            kind: "changeTimestampRef",
            applicable: false,
            value: null,
            confirmedBy: null,
            confirmedAt: null,
          },
        ],
        scopeBindings: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BindingPanel (RB-3)", () => {
  it("distinguishes confirmed / unconfirmed / not-applicable refs", async () => {
    getBindingsMock.mockResolvedValue(bindingsFixture({}));

    const wrapper = mount(BindingPanel, {
      props: { specId: SPEC_ID, ir },
      global: testGlobalOptions(),
    });
    await flushPromises();

    // Confirmed ref.
    expect(wrapper.get('[data-testid="ref-state-nativeIdRef"]').text()).toContain("confirmed");
    // Unconfirmed ref (the Phase-4 rule-enablement signal).
    expect(wrapper.get('[data-testid="ref-state-collectionReadRef"]').text()).toContain(
      "unconfirmed",
    );
    // Not-applicable ref is rendered non-actionable (no confirm/correct buttons).
    expect(wrapper.get('[data-testid="ref-state-changeTimestampRef"]').text()).toContain(
      "not-applicable",
    );
    expect(wrapper.find('[data-testid="ref-na-changeTimestampRef"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ref-confirm-changeTimestampRef"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ref-correct-changeTimestampRef"]').exists()).toBe(false);
  });

  it("confirms a ref with a PATCH carrying just the refKind", async () => {
    getBindingsMock.mockResolvedValue(bindingsFixture({}));
    updateBindingMock.mockResolvedValue(
      firstBinding(bindingsFixture({ collectionConfirmed: true })),
    );

    const wrapper = mount(BindingPanel, {
      props: { specId: SPEC_ID, ir },
      global: testGlobalOptions(),
    });
    await flushPromises();

    await wrapper.get('[data-testid="ref-confirm-collectionReadRef"]').trigger("click");
    await flushPromises();

    expect(updateBindingMock).toHaveBeenCalledWith(BINDING_ID, { refKind: "collectionReadRef" });
  });

  it("corrects a ref to a different IR field and PATCHes the new value", async () => {
    getBindingsMock.mockResolvedValue(bindingsFixture({}));
    updateBindingMock.mockResolvedValue(firstBinding(bindingsFixture({})));

    const wrapper = mount(BindingPanel, {
      props: { specId: SPEC_ID, ir },
      global: testGlobalOptions(),
    });
    await flushPromises();

    await wrapper.get('[data-testid="ref-correct-nativeIdRef"]').trigger("click");
    // Default target kind for nativeIdRef is "field"; pick the `title` field.
    await wrapper.get('[data-testid="ref-target-select-nativeIdRef"]').setValue("field:title");
    await wrapper.get('[data-testid="ref-save-nativeIdRef"]').trigger("click");
    await flushPromises();

    expect(updateBindingMock).toHaveBeenCalledWith(BINDING_ID, {
      refKind: "nativeIdRef",
      value: { kind: "field", path: "title" },
    });
  });

  it("reflects the new confirmed state after the mutation", async () => {
    getBindingsMock
      .mockResolvedValueOnce(bindingsFixture({}))
      .mockResolvedValue(bindingsFixture({ collectionConfirmed: true }));
    updateBindingMock.mockResolvedValue(
      firstBinding(bindingsFixture({ collectionConfirmed: true })),
    );

    const wrapper = mount(BindingPanel, {
      props: { specId: SPEC_ID, ir },
      global: testGlobalOptions(),
    });
    await flushPromises();
    expect(wrapper.get('[data-testid="ref-state-collectionReadRef"]').text()).toContain(
      "unconfirmed",
    );

    await wrapper.get('[data-testid="ref-confirm-collectionReadRef"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="ref-state-collectionReadRef"]').text()).toContain(
      "confirmed",
    );
  });
});

/** A bindings response whose `issues` resource carries a single `owner` scope constant. */
function scopeFixture(overrides: { confirmed?: boolean }): ResourceBindingsResponse {
  const confirmed = overrides.confirmed === true;
  return {
    bindings: [
      {
        id: BINDING_ID,
        apiSpecId: SPEC_ID,
        resourceRef: "issues",
        refs: [],
        scopeBindings: [
          {
            parameterName: "owner",
            kind: "constant",
            value: confirmed ? "alice" : "",
            confirmedBy: confirmed ? "operator@example.com" : null,
            confirmedAt: confirmed ? "2026-07-10T00:00:00.000Z" : null,
          },
        ],
      },
    ],
  };
}

/** Mounts the panel and authenticates the given role (the scope section is role-gated). */
function mountPanel(role: SessionRole) {
  const wrapper = mount(BindingPanel, {
    props: { specId: SPEC_ID, ir },
    global: testGlobalOptions(),
  });
  useAuthStore().$patch({ state: { status: "authenticated", identity: role, role } });
  return wrapper;
}

describe("BindingPanel — SS-6 scope-binding supply", () => {
  it("renders a value input + unconfirmed indicator for a constant scope entry (SS-6.2)", async () => {
    getBindingsMock.mockResolvedValue(scopeFixture({}));
    const wrapper = mountPanel("operator");
    await flushPromises();

    expect(wrapper.find('[data-testid="scope-bindings-issues"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="scope-state-owner"]').text()).toContain("unconfirmed");
    // A value to TYPE IN — an input, not a confirm/correct ref picker.
    expect(wrapper.find('[data-testid="scope-input-owner"]').exists()).toBe(true);
  });

  it("supplies a value and confirms via a scope PATCH { parameterName, value } (SS-6.2)", async () => {
    getBindingsMock.mockResolvedValue(scopeFixture({}));
    updateBindingMock.mockResolvedValue(firstBinding(scopeFixture({ confirmed: true })));
    const wrapper = mountPanel("operator");
    await flushPromises();

    await wrapper.get('[data-testid="scope-input-owner"]').setValue("alice");
    await wrapper.get('[data-testid="scope-confirm-owner"]').trigger("click");
    await flushPromises();

    expect(updateBindingMock).toHaveBeenCalledWith(BINDING_ID, {
      parameterName: "owner",
      value: "alice",
    });
  });

  it("disables supply+confirm while the value is empty (SS-3.3 reflected)", async () => {
    getBindingsMock.mockResolvedValue(scopeFixture({}));
    const wrapper = mountPanel("operator");
    await flushPromises();

    expect(wrapper.get('[data-testid="scope-confirm-owner"]').attributes("disabled")).toBeDefined();
    await wrapper.get('[data-testid="scope-input-owner"]').setValue("alice");
    expect(
      wrapper.get('[data-testid="scope-confirm-owner"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("reflects the confirmed state after supply+confirm (SS-6.3 refresh)", async () => {
    getBindingsMock
      .mockResolvedValueOnce(scopeFixture({}))
      .mockResolvedValue(scopeFixture({ confirmed: true }));
    updateBindingMock.mockResolvedValue(firstBinding(scopeFixture({ confirmed: true })));
    const wrapper = mountPanel("operator");
    await flushPromises();
    expect(wrapper.get('[data-testid="scope-state-owner"]').text()).toContain("unconfirmed");

    await wrapper.get('[data-testid="scope-input-owner"]').setValue("alice");
    await wrapper.get('[data-testid="scope-confirm-owner"]').trigger("click");
    await flushPromises();

    // The mutation invalidated the bindings query; the panel now shows the entry confirmed.
    expect(wrapper.get('[data-testid="scope-state-owner"]').text()).toContain("confirmed");
  });

  it("renders read-only for a viewer — no input or confirm control (SS-6.4)", async () => {
    getBindingsMock.mockResolvedValue(scopeFixture({ confirmed: true }));
    const wrapper = mountPanel("viewer");
    await flushPromises();

    expect(wrapper.find('[data-testid="scope-input-owner"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="scope-confirm-owner"]').exists()).toBe(false);
    // The confirmed constant is operator config, shown as entered (SS-6.5) — never a secret.
    expect(wrapper.get('[data-testid="scope-readonly-owner"]').text()).toContain("alice");
  });
});
