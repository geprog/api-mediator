import Aura from "@primeuix/themes/aura";
import { createPinia } from "pinia";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";

/**
 * Frontend composition root: create the app, install Pinia (client state),
 * vue-router (navigation) and PrimeVue (UI kit), then mount.
 *
 * PrimeVue 4 uses a styled-mode design-token theme (`@primeuix/themes`) that is
 * generated at runtime — no external CSS/CDN, so it works fully offline.
 */
const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(PrimeVue, { theme: { preset: Aura } });

app.mount("#app");
