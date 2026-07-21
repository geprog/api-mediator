import type {
  AdapterEndpointStateDto,
  AdapterHealthResponse,
  AdapterRequestDto,
} from "@mediator/contracts";
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import { testGlobalOptions } from "../../testing/render";
import EndpointHealthPanel from "./EndpointHealthPanel.vue";

function activeBinding(): AdapterEndpointStateDto["bindings"][number] {
  return {
    id: "b-1",
    backendAppId: "backend-1",
    backendOperationId: "listThings",
    role: "primary",
    status: "active",
    health: { ok: true },
  };
}

function endpoint(overrides: Partial<AdapterEndpointStateDto>): AdapterEndpointStateDto {
  return {
    id: "ep",
    consumerAppId: "app-1",
    consumerOperationId: "op",
    status: "active",
    aggregationStrategy: "single",
    strictness: "degraded",
    cacheTtl: null,
    union: null,
    bindings: [activeBinding()],
    compositionRequired: null,
    ...overrides,
  };
}

function transformErrorRow(): AdapterRequestDto {
  return {
    id: "err-1",
    outcome: "failure",
    status: "failure",
    cause: "mediator-transform-error",
    degraded: false,
    relatedEndpointId: "ep-served",
    relatedBindingId: null,
    actor: "adapter",
    details: null,
    traceId: "trace-xyz",
    spanId: "span-1",
    timestamp: "2026-07-21T00:00:00.000Z",
  };
}

function mountPanel(
  overrides: {
    endpoints?: AdapterEndpointStateDto[];
    health?: Partial<AdapterHealthResponse>;
    requests?: AdapterRequestDto[];
  } = {},
) {
  const health: AdapterHealthResponse = {
    compositionRequired: [],
    unhealthyBindings: [],
    transformErrors: [],
    ...overrides.health,
  };
  return mount(EndpointHealthPanel, {
    props: {
      endpoints: overrides.endpoints ?? [
        endpoint({ id: "ep-served", consumerOperationId: "getServed", status: "active" }),
        endpoint({
          id: "ep-comp",
          consumerOperationId: "getComposing",
          status: "composition-required",
        }),
        endpoint({ id: "ep-disabled", consumerOperationId: "getOff", status: "disabled" }),
      ],
      notYetMapped: [
        { consumerAppId: "app-1", consumerOperationId: "getUnmapped", reason: "no-endpoint" },
      ],
      health,
      requests: overrides.requests ?? [],
    },
    global: testGlobalOptions(),
  });
}

describe("EndpointHealthPanel (CU-4)", () => {
  it("renders the four consumer-operation states (CU-4.1)", () => {
    const wrapper = mountPanel();
    expect(wrapper.get('[data-testid="health-operation-state-app-1-getServed"]').text()).toBe(
      "served",
    );
    expect(wrapper.get('[data-testid="health-operation-state-app-1-getComposing"]').text()).toBe(
      "composition-required",
    );
    expect(wrapper.get('[data-testid="health-operation-state-app-1-getOff"]').text()).toBe(
      "disabled",
    );
    expect(wrapper.get('[data-testid="health-operation-state-app-1-getUnmapped"]').text()).toBe(
      "not-yet-mapped",
    );
  });

  it("surfaces a mediator-transform-error prominently as a defect to fix (CU-4.4)", () => {
    const wrapper = mountPanel({ health: { transformErrors: [transformErrorRow()] } });
    const block = wrapper.get('[data-testid="health-transform-errors"]');
    expect(block.text()).toContain("defect to fix");
    expect(wrapper.find('[data-testid="health-transform-error-err-1"]').exists()).toBe(true);
  });

  it("shows an unhealthy binding's cause and the live-caller staleness note (CU-4.2)", () => {
    const wrapper = mountPanel({
      health: {
        unhealthyBindings: [
          {
            endpointId: "ep-served",
            bindingId: "b-1",
            backendAppId: "backend-1",
            cause: "mapping-stale",
          },
        ],
      },
    });
    expect(wrapper.get('[data-testid="health-binding-cause-b-1"]').text()).toBe("mapping-stale");
    expect(wrapper.get('[data-testid="health-staleness-note"]').text()).toContain(
      "live caller right now",
    );
  });

  it("shows per-endpoint request/error/degraded counts (CU-4.3)", () => {
    const wrapper = mountPanel({
      requests: [
        {
          id: "r-1",
          outcome: "failure",
          status: "failure",
          cause: "upstream-error",
          degraded: false,
          relatedEndpointId: "ep-served",
          relatedBindingId: null,
          actor: "adapter",
          details: null,
          traceId: null,
          spanId: null,
          timestamp: "2026-07-21T00:00:00.000Z",
        },
      ],
    });
    expect(wrapper.get('[data-testid="health-count-total-ep-served"]').text()).toContain("1");
    expect(wrapper.get('[data-testid="health-count-errors-ep-served"]').text()).toContain("1");
    expect(wrapper.get('[data-testid="health-cause-ep-served-upstream-error"]').text()).toContain(
      "upstream-error",
    );
  });

  it("renders no token, secret, or payload value (CU-4.5)", () => {
    const wrapper = mountPanel({ health: { transformErrors: [transformErrorRow()] } });
    const text = wrapper.text();
    expect(text.toLowerCase()).not.toContain("bearer");
    expect(text.toLowerCase()).not.toContain("password");
    expect(text.toLowerCase()).not.toContain("secret");
  });
});
