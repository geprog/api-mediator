import Aura from "@primeuix/themes/aura";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";

/**
 * Frontend composition root: create the app, install Pinia (purely-local UI
 * state), vue-router (navigation), `@tanstack/vue-query` (server state — the app
 * list, specs, IR, and bindings, plus the registration/confirm/exclusion
 * mutations), and PrimeVue (UI kit), then mount.
 *
 * PrimeVue 4 uses a styled-mode design-token theme (`@primeuix/themes`) that is
 * generated at runtime — no external CSS/CDN, so it works fully offline.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Operator data is small and low-churn at Phase-1 scale; refetch on demand
      // (and on mutation-driven invalidation) rather than aggressively.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(VueQueryPlugin, { queryClient });
app.use(PrimeVue, { theme: { preset: Aura } });

app.mount("#app");
