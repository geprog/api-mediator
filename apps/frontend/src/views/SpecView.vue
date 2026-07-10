<script setup lang="ts">
import Message from "primevue/message";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

import IrViewer from "../components/IrViewer.vue";
import BindingPanel from "../components/resource-bindings/BindingPanel.vue";
import AnalysisExclusionsEditor from "../components/specs/AnalysisExclusionsEditor.vue";
import { useSpecIr } from "../composables/useSpecs.js";

/**
 * Spec view (SI-3 + RB-3): the spec's IR viewer, its `ResourceBinding`
 * confirmation panel, and — when reached from an app (`?app=`) — an
 * `analysisExclusions` editor. The IR query is owned here and shared with the
 * viewer and the binding panel's correction pickers (one fetch).
 */
const route = useRoute();
const specId = computed<string>(() => {
  const raw = route.params["id"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});
const appId = computed<string | null>(() => {
  const raw = route.query["app"];
  if (typeof raw === "string" && raw !== "") {
    return raw;
  }
  return null;
});

const irQuery = useSpecIr(specId);
const ir = computed(() => irQuery.data.value?.ir ?? []);
</script>

<template>
  <main class="spec-view">
    <RouterLink v-if="appId !== null" :to="`/apps/${appId}`">← Back to app</RouterLink>
    <RouterLink v-else to="/apps">← All apps</RouterLink>

    <h1>Spec</h1>
    <p class="spec-view__id">
      <code>{{ specId }}</code>
    </p>

    <p v-if="irQuery.isPending.value" data-testid="spec-loading">Loading IR…</p>

    <Message v-else-if="irQuery.isError.value" severity="error" data-testid="spec-error">
      Could not load the spec IR: {{ irQuery.error.value?.message }}
    </Message>

    <template v-else>
      <AnalysisExclusionsEditor v-if="appId !== null" :spec-id="specId" :app-id="appId" :ir="ir" />

      <section class="spec-view__section">
        <h2>Intermediate representation</h2>
        <IrViewer :ir="ir" />
      </section>

      <section class="spec-view__section">
        <BindingPanel :spec-id="specId" :ir="ir" />
      </section>
    </template>
  </main>
</template>

<style scoped>
.spec-view {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.spec-view__id {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}
</style>
