import Aura from "@primeuix/themes/aura";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { RouterLinkStub, type GlobalMountOptions } from "@vue/test-utils";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";

/**
 * Shared mount configuration for the frontend component tests: a retry-disabled
 * `@tanstack/vue-query` client, Pinia, PrimeVue, and a `RouterLink` stub. Tests
 * call `mount(Component, { global: testGlobalOptions() })` directly (so the
 * wrapper keeps the component's concrete type). The API modules are mocked
 * per-test, so nothing touches the network. Kept out of the production build —
 * only `main.ts`'s import graph is bundled.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function testGlobalOptions(
  queryClient: QueryClient = createTestQueryClient(),
): GlobalMountOptions {
  return {
    plugins: [
      createPinia(),
      [VueQueryPlugin, { queryClient }],
      [PrimeVue, { theme: { preset: Aura } }],
    ],
    stubs: {
      // Router-free component tests render links as plain anchors; components that
      // read the route mock `vue-router` instead.
      RouterLink: RouterLinkStub,
    },
  };
}
