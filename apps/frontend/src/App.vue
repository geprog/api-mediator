<script setup lang="ts">
import { watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import AppNav from "./components/AppNav.vue";
import { useAuthStore } from "./stores/auth.js";

// Resolving the store here initializes it at mount, so its transport-level 401/403
// handlers are registered before any API call fires.
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

// A mid-session 401 (e.g. a background query) ends the session without a
// navigation; send the operator to the login screen.
watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (!authenticated && route.name !== "login") {
      void router.push({ name: "login" });
    }
  },
);
</script>

<template>
  <AppNav />
  <RouterView />
</template>

<style>
:root {
  color-scheme: light dark;
}

body {
  margin: 0;
  font-family:
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    sans-serif;
}
</style>
