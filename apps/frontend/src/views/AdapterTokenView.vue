<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

import AdapterTokenPanel from "../components/adapter/AdapterTokenPanel.vue";
import { useAppList } from "../composables/useApps.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * CU-3 — the adapter-token screen for a consumer app. The panel
 * ({@link AdapterTokenPanel}) owns the once-only token lifecycle; this view only
 * resolves the app's display name and the viewer/operator gate (OA-2).
 */
const route = useRoute();
const auth = useAuthStore();

const appId = computed<string>(() => {
  const raw = route.params["appId"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});
const readonly = computed<boolean>(() => !auth.isOperator);

const appsQuery = useAppList();
const appName = computed<string | undefined>(
  () => appsQuery.data.value?.apps.find((app) => app.id === appId.value)?.name,
);
</script>

<template>
  <main class="adapter-token">
    <RouterLink to="/adapter">← All adapter endpoints</RouterLink>
    <AdapterTokenPanel
      :consumer-app-id="appId"
      :readonly="readonly"
      v-bind="appName !== undefined ? { consumerAppName: appName } : {}"
    />
  </main>
</template>

<style scoped>
.adapter-token {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
