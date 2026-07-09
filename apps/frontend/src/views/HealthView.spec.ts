import Aura from "@primeuix/themes/aura";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import HealthView from "./HealthView.vue";

/**
 * DOM-only component tests for the health page. `fetch` is stubbed, so no
 * backend or database is involved: this proves the frontend unit-test pipeline
 * (happy-dom + @vue/test-utils + Pinia + PrimeVue) end to end.
 */

interface FetchStubResult {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

function stubFetch(result: FetchStubResult | Error): void {
  if (result instanceof Error) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(result)),
    );
    return;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(result)),
  );
}

async function mountHealthView(): Promise<VueWrapper> {
  const wrapper = mount(HealthView, {
    global: {
      plugins: [createPinia(), [PrimeVue, { theme: { preset: Aura } }]],
    },
  });
  // `onMounted` kicks off the probe; wait for the promise chain to settle.
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HealthView", () => {
  it("renders the healthy state when the backend reports db: up", async () => {
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", db: "up" }) });

    const wrapper = await mountHealthView();

    const loaded = wrapper.get('[data-testid="health-loaded"]');
    expect(loaded.text()).toContain("ok");
    expect(wrapper.get('[data-testid="health-db"]').text()).toContain("up");
    expect(wrapper.find('[data-testid="health-error"]').exists()).toBe(false);
  });

  it("renders the down state when the backend returns 503 db: down", async () => {
    stubFetch({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ status: "error", db: "down" }),
    });

    const wrapper = await mountHealthView();

    const loaded = wrapper.get('[data-testid="health-loaded"]');
    expect(loaded.text()).toContain("error");
    expect(wrapper.get('[data-testid="health-db"]').text()).toContain("down");
    expect(wrapper.find('[data-testid="health-error"]').exists()).toBe(false);
  });

  it("renders the error state when the backend is unreachable", async () => {
    stubFetch(new Error("connection refused"));

    const wrapper = await mountHealthView();

    const error = wrapper.get('[data-testid="health-error"]');
    expect(error.text()).toContain("connection refused");
    expect(wrapper.find('[data-testid="health-loaded"]').exists()).toBe(false);
  });

  it("re-probes the backend when Refresh is clicked", async () => {
    stubFetch({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ status: "error", db: "down" }),
    });

    const wrapper = await mountHealthView();
    expect(wrapper.get('[data-testid="health-db"]').text()).toContain("down");

    // Next probe reports a recovered database.
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ status: "ok", db: "up" }) });
    await wrapper.get('[data-testid="health-refresh"]').trigger("click");
    await flushPromises();

    expect(wrapper.get('[data-testid="health-db"]').text()).toContain("up");
  });
});
