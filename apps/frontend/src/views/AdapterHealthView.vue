<script setup lang="ts">
import type { AdapterHealthResponse } from "@mediator/contracts";
import Message from "primevue/message";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import EndpointHealthPanel from "../components/adapter/EndpointHealthPanel.vue";
import {
  useAdapterEndpoints,
  useAdapterHealth,
  useAdapterRequests,
} from "../composables/useAdapterEndpoints.js";

/**
 * CU-4 — the endpoint-health view. It wires the AP-1 read state, the AP-5.3 health
 * read, and a bounded AP-5.1 request-history read into {@link EndpointHealthPanel},
 * which derives the operation states, the per-endpoint counts, and surfaces any
 * `mediator-transform-error` prominently. Viewer-allowed reads (OA-2); metadata only.
 */
const EMPTY_HEALTH: AdapterHealthResponse = {
  compositionRequired: [],
  unhealthyBindings: [],
  transformErrors: [],
};

const stateQuery = useAdapterEndpoints();
const healthQuery = useAdapterHealth();
const requestsQuery = useAdapterRequests(() => ({ limit: 200 }));

const endpoints = computed(() => stateQuery.data.value?.endpoints ?? []);
const notYetMapped = computed(() => stateQuery.data.value?.notYetMapped ?? []);
const health = computed<AdapterHealthResponse>(() => healthQuery.data.value ?? EMPTY_HEALTH);
const requests = computed(() => requestsQuery.data.value?.requests ?? []);

const isPending = computed<boolean>(
  () => stateQuery.isPending.value || healthQuery.isPending.value,
);
const errorMessage = computed<string | null>(
  () => stateQuery.error.value?.message ?? healthQuery.error.value?.message ?? null,
);
</script>

<template>
  <main class="adapter-health">
    <header class="adapter-health__header">
      <h1>Adapter health</h1>
      <RouterLink to="/adapter" data-testid="nav-adapter-endpoints">← All endpoints</RouterLink>
    </header>

    <p v-if="isPending" data-testid="adapter-health-loading">Loading adapter health…</p>

    <Message v-else-if="errorMessage !== null" severity="error" data-testid="adapter-health-error">
      Could not load adapter health: {{ errorMessage }}
    </Message>

    <EndpointHealthPanel
      v-else
      :endpoints="endpoints"
      :not-yet-mapped="notYetMapped"
      :health="health"
      :requests="requests"
    />
  </main>
</template>

<style scoped>
.adapter-health {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.adapter-health__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
</style>
