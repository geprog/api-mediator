<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import Tag from "primevue/tag";
import { computed, onMounted } from "vue";

import type { HealthResponse } from "../api/health";
import { useHealthStore } from "../stores/health";

type TagSeverity = "success" | "danger" | "secondary";

const health = useHealthStore();

// Each computed re-reads `health.state` into a local `const` so the
// discriminated-union narrowing is sound (a bare property-access chain is not
// narrowable) while staying reactive.
const isLoading = computed<boolean>(() => health.state.status === "loading");

const errorMessage = computed<string | null>(() => {
  const state = health.state;
  return state.status === "error" ? state.message : null;
});

const loaded = computed<HealthResponse | null>(() => {
  const state = health.state;
  return state.status === "loaded" ? state.response : null;
});

const overallSeverity = computed<TagSeverity>(() => {
  const response = loaded.value;
  if (response === null) return "secondary";
  return response.status === "ok" ? "success" : "danger";
});

const dbSeverity = computed<TagSeverity>(() => {
  const response = loaded.value;
  if (response === null) return "secondary";
  return response.db === "up" ? "success" : "danger";
});

function refresh(): void {
  void health.refresh();
}

onMounted((): void => {
  void health.refresh();
});
</script>

<template>
  <main class="health-page">
    <Card class="health-card">
      <template #title>Backend health</template>
      <template #subtitle>Operator API — <code>GET /health</code></template>
      <template #content>
        <p v-if="isLoading" data-testid="health-loading">Checking the backend…</p>
        <p v-else-if="errorMessage !== null" data-testid="health-error">
          Could not reach the backend: {{ errorMessage }}
        </p>
        <div v-else-if="loaded !== null" data-testid="health-loaded" class="health-readout">
          <p>
            Overall:
            <Tag :severity="overallSeverity" :value="loaded.status" data-testid="health-status" />
          </p>
          <p>
            Database:
            <Tag :severity="dbSeverity" :value="loaded.db" data-testid="health-db" />
          </p>
        </div>
        <p v-else data-testid="health-idle">Backend health has not been checked yet.</p>
      </template>
      <template #footer>
        <Button label="Refresh" data-testid="health-refresh" @click="refresh" />
      </template>
    </Card>
  </main>
</template>

<style scoped>
.health-page {
  display: flex;
  justify-content: center;
  padding: 3rem 1rem;
}

.health-card {
  width: min(28rem, 100%);
}

.health-readout p {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
