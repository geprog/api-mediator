import type {
  AdapterEndpointStateDto,
  ComposeAdapterEndpointPreviewResponse,
} from "@mediator/contracts";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../../testing/render";
import CompositionForm from "./CompositionForm.vue";

function binding(
  overrides: Partial<AdapterEndpointStateDto["bindings"][number]> = {},
): AdapterEndpointStateDto["bindings"][number] {
  return {
    id: "b1",
    backendAppId: "backend-1",
    backendOperationId: "op-1",
    role: "primary",
    status: "proposed",
    health: { ok: true },
    ...overrides,
  };
}

function endpoint(overrides: Partial<AdapterEndpointStateDto> = {}): AdapterEndpointStateDto {
  return {
    id: "ep-1",
    consumerAppId: "consumer-1",
    consumerOperationId: "getWidgets",
    status: "composition-required",
    aggregationStrategy: null,
    strictness: null,
    cacheTtl: null,
    union: null,
    bindings: [binding(), binding({ id: "b2", backendAppId: "backend-2", role: "primary" })],
    compositionRequired: { proposedBindingIds: ["b2"], previousConfigurationServing: true },
    ...overrides,
  };
}

function mountForm(props: {
  endpoint?: AdapterEndpointStateDto;
  preview?: ComposeAdapterEndpointPreviewResponse | null;
  writeOperation?: boolean;
  readonly?: boolean;
}) {
  return mount(CompositionForm, {
    props: {
      endpoint: props.endpoint ?? endpoint(),
      preview: props.preview ?? null,
      readonly: props.readonly ?? false,
      pending: false,
      rejection: null,
      ...(props.writeOperation !== undefined ? { writeOperation: props.writeOperation } : {}),
    },
    global: testGlobalOptions(),
  });
}

function optionValues(wrapper: ReturnType<typeof mountForm>, testId: string): string[] {
  return wrapper
    .get(`[data-testid="${testId}"]`)
    .findAll("option")
    .map((option) => (option.element as HTMLOptionElement).value);
}

describe("CompositionForm (CU-1)", () => {
  it("offers exactly a strategy's valid roles per binding (CU-1.2)", async () => {
    const wrapper = mountForm({});
    await wrapper.get('[data-testid="composition-strategy"]').setValue("fanout-merge");
    expect(optionValues(wrapper, "composition-role-b1")).toStrictEqual(["primary", "supplement"]);

    await wrapper.get('[data-testid="composition-strategy"]').setValue("collection-union");
    expect(optionValues(wrapper, "composition-role-b1")).toStrictEqual(["supplement"]);

    await wrapper.get('[data-testid="composition-strategy"]').setValue("fanout-first-success");
    expect(optionValues(wrapper, "composition-role-b1")).toStrictEqual(["primary", "fallback"]);
  });

  it("offers only single, with the reason, for a write operation (CU-1.6)", () => {
    const wrapper = mountForm({ writeOperation: true });
    expect(optionValues(wrapper, "composition-strategy")).toStrictEqual(["single"]);
    expect(wrapper.find('[data-testid="composition-write-single"]').exists()).toBe(true);
  });

  it("flags a fanout-first-success order tie before submission and disables submit (CU-1.3)", async () => {
    const wrapper = mountForm({});
    await wrapper.get('[data-testid="composition-strategy"]').setValue("fanout-first-success");
    // Both bindings default to order 0 → a tie.
    expect(wrapper.find('[data-testid="composition-order-tie"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="composition-submit"]').attributes("disabled")).toBeDefined();

    // Give them distinct orders → the tie clears.
    await wrapper.get('[data-testid="composition-order-b1"]').setValue("1");
    await wrapper.get('[data-testid="composition-order-b2"]').setValue("2");
    expect(wrapper.find('[data-testid="composition-order-tie"]').exists()).toBe(false);
  });

  it("offers a chained binding the upstream binding's consumer-shape response fields (CU-1.4)", async () => {
    const preview: ComposeAdapterEndpointPreviewResponse = {
      endpointId: "ep-1",
      supplementAnalysis: {
        applicable: true,
        entries: [
          {
            kind: "supplement",
            bindingId: "b1",
            suppliedConsumerResponseFields: ["id", "profile.email"],
            allSuppliedFieldsOptional: true,
            loadBearing: false,
          },
        ],
      },
      coverage: { perBinding: [], unmappedByAllBackends: [] },
      validation: { ok: true },
    };
    const wrapper = mountForm({ preview });
    await wrapper.get('[data-testid="composition-strategy"]').setValue("fanout-merge");
    // b2 depends on b1 (the upstream with supplied consumer-shape fields).
    await wrapper.get('[data-testid="composition-depends-b2"]').setValue("b1");
    await wrapper.get('[data-testid="composition-chain-add-b2"]').trigger("click");

    const options = optionValues(wrapper, "composition-chain-source-b2-0");
    // The source options are the upstream binding's consumer-shape fields (plus the "choose" blank).
    expect(options).toContain("id");
    expect(options).toContain("profile.email");
    // Never a backend-native field — only what the preview reports as consumer-shape.
    expect(options).not.toContain("backend_native_id");
  });

  it("surfaces the load-bearing supplement analysis and input-coverage acknowledgement (CU-1.5)", async () => {
    const preview: ComposeAdapterEndpointPreviewResponse = {
      endpointId: "ep-1",
      supplementAnalysis: {
        applicable: true,
        entries: [
          {
            kind: "supplement",
            bindingId: "b2",
            suppliedConsumerResponseFields: ["entitlement"],
            allSuppliedFieldsOptional: false,
            loadBearing: true,
          },
        ],
      },
      coverage: {
        perBinding: [],
        unmappedByAllBackends: [
          { kind: "parameter", name: "locale", required: false },
          { kind: "body-field", name: "note", required: true },
        ],
      },
      validation: { ok: true },
    };
    const wrapper = mountForm({ preview });
    await wrapper.get('[data-testid="composition-strategy"]').setValue("fanout-merge");

    expect(wrapper.find('[data-testid="composition-supplement-loadbearing-b2"]').exists()).toBe(
      true,
    );
    // A required unmapped input is a blocking finding; an optional one needs explicit acknowledgement.
    expect(wrapper.find('[data-testid="composition-coverage-required"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="composition-ack-parameter-locale"]').exists()).toBe(true);
    // The required unmapped input blocks submit.
    expect(wrapper.get('[data-testid="composition-submit"]').attributes("disabled")).toBeDefined();
  });

  it("emits the built request on submit (AP-2)", async () => {
    const wrapper = mountForm({});
    await wrapper.get('[data-testid="composition-submit"]').trigger("click");
    const submitted = wrapper.emitted("submit");
    expect(submitted).toBeTruthy();
    const [request] = submitted?.[0] as [{ aggregationStrategy: string; bindings: unknown[] }];
    expect(request.aggregationStrategy).toBe("single");
    expect(request.bindings).toHaveLength(2);
  });

  it("surfaces a server rejection's exact rule violations (AP-2.2)", () => {
    const wrapper = mountForm({});
    const rejected = mount(CompositionForm, {
      props: {
        endpoint: endpoint(),
        preview: null,
        readonly: false,
        pending: false,
        rejection: {
          message: "Composition is invalid.",
          issues: [
            {
              path: "bindings.0.role",
              message: "role 'supplement' is invalid for strategy 'single'",
            },
          ],
        },
      },
      global: testGlobalOptions(),
    });
    expect(rejected.get('[data-testid="composition-rejection"]').text()).toContain(
      "role 'supplement' is invalid for strategy 'single'",
    );
    wrapper.unmount();
    rejected.unmount();
  });

  it("renders read-only for a viewer — no mutation controls (CU-1.7 / OA-2)", () => {
    const wrapper = mountForm({ readonly: true });
    expect(wrapper.find('[data-testid="composition-submit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="composition-readonly"]').exists()).toBe(true);
    expect(
      wrapper.get('[data-testid="composition-strategy"]').attributes("disabled"),
    ).toBeDefined();
  });
});
