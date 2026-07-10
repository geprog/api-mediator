<script setup lang="ts">
import type { AppSpecsResponse, RegisteredAppDto } from "@mediator/contracts";
import Card from "primevue/card";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";

import { useAppList } from "../composables/useApps.js";
import { useAppSpecs } from "../composables/useSpecs.js";

/**
 * App detail (AR-2): the app's metadata plus its specs (id, role, version,
 * contentHash, status, exclusions, createdAt), each linking to the spec's IR +
 * bindings view. The app metadata is read from the (cached) app-list query; the
 * spec metadata omits `rawDocument` (AR-2 criterion 3). No credential material.
 */
const route = useRoute();
const appId = computed<string>(() => {
  const raw = route.params["id"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});

const appsQuery = useAppList();
const specsQuery = useAppSpecs(appId);

const app = computed<RegisteredAppDto | undefined>(() =>
  appsQuery.data.value?.apps.find((candidate) => candidate.id === appId.value),
);
const specs = computed<AppSpecsResponse["specs"]>(() => specsQuery.data.value?.specs ?? []);
</script>

<template>
  <main class="app-detail">
    <RouterLink to="/apps">← All apps</RouterLink>

    <p v-if="appsQuery.isPending.value" data-testid="app-detail-loading">Loading app…</p>

    <Message v-else-if="appsQuery.isError.value" severity="error" data-testid="app-detail-error">
      Could not load app: {{ appsQuery.error.value?.message }}
    </Message>

    <p v-else-if="app === undefined" data-testid="app-detail-missing">
      App {{ appId }} was not found.
    </p>

    <template v-else>
      <Card class="app-detail__card" data-testid="app-detail-card">
        <template #title>
          {{ app.name }}
          <Tag :severity="app.status === 'active' ? 'success' : 'secondary'" :value="app.status" />
        </template>
        <template #content>
          <dl class="app-detail__meta">
            <dt>Id</dt>
            <dd>
              <code>{{ app.id }}</code>
            </dd>
            <dt>Base URL</dt>
            <dd>
              <code v-if="app.baseUrl">{{ app.baseUrl }}</code>
              <span v-else>— (consumer-only; the mediator hosts its endpoint)</span>
            </dd>
            <dt>Capabilities</dt>
            <dd>
              polling: {{ app.capabilities.supportsPolling }}, delta:
              {{ app.capabilities.supportsDeltaQuery }}, timestamps:
              {{ app.capabilities.supportsChangeTimestamps }}, poll interval:
              {{ app.capabilities.defaultPollInterval }} ms
            </dd>
            <dt>Created</dt>
            <dd>{{ app.createdAt }}</dd>
          </dl>
        </template>
      </Card>

      <section class="app-detail__specs">
        <h2>Specs</h2>
        <p v-if="specsQuery.isPending.value" data-testid="app-specs-loading">Loading specs…</p>
        <Message
          v-else-if="specsQuery.isError.value"
          severity="error"
          data-testid="app-specs-error"
        >
          Could not load specs: {{ specsQuery.error.value?.message }}
        </Message>
        <p v-else-if="specs.length === 0" data-testid="app-specs-empty">No specs.</p>
        <DataTable v-else :value="specs" data-key="id" data-testid="app-specs-table">
          <Column field="role" header="Role">
            <template #body="{ data }">
              <Tag severity="info" :value="data.role" />
            </template>
          </Column>
          <Column field="version" header="Version" />
          <Column field="status" header="Status" />
          <Column header="Exclusions">
            <template #body="{ data }">
              <span v-if="data.analysisExclusions.length > 0">
                {{ data.analysisExclusions.join(", ") }}
              </span>
              <span v-else class="app-detail__muted">none</span>
            </template>
          </Column>
          <Column field="contentHash" header="Content hash">
            <template #body="{ data }">
              <code class="app-detail__hash">{{ data.contentHash }}</code>
            </template>
          </Column>
          <Column header="IR & bindings">
            <template #body="{ data }">
              <RouterLink
                :to="`/specs/${data.id}?app=${appId}`"
                :data-testid="`spec-link-${data.id}`"
              >
                View
              </RouterLink>
            </template>
          </Column>
        </DataTable>
      </section>
    </template>
  </main>
</template>

<style scoped>
.app-detail {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.app-detail__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.35rem 1rem;
  margin: 0;
}

.app-detail__meta dt {
  font-weight: 600;
}

.app-detail__meta dd {
  margin: 0;
}

.app-detail__muted {
  color: var(--p-text-muted-color, #64748b);
}

.app-detail__hash {
  font-size: 0.8rem;
  word-break: break-all;
}
</style>
