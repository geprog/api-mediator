<script setup lang="ts">
import { RouterView } from "vue-router";

import AppNav from "./components/AppNav.vue";
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
