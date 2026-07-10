<script setup lang="ts">
import type { RegisteredAppDto } from "@mediator/contracts";
import type { AppCapabilities } from "@mediator/domain";
import Button from "primevue/button";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { useAppList } from "../composables/useApps.js";

/**
 * App list (AR-2 criterion 1): every registered app with its id, name, status,
 * baseUrl, capabilities, and createdAt — unpaginated at Phase-1 scale. Rows link
 * to the app detail page. Spec roles are shown on the detail page (the list DTO
 * carries app metadata only). No credential material appears (AR-2 criterion 5).
 */
const appsQuery = useAppList();
const apps = computed<RegisteredAppDto[]>(() => appsQuery.data.value?.apps ?? []);

function enabledCapabilities(capabilities: AppCapabilities): string[] {
  const enabled: string[] = [];
  if (capabilities.supportsPolling) enabled.push("polling");
  if (capabilities.supportsDeltaQuery) enabled.push("delta");
  if (capabilities.supportsChangeTimestamps) enabled.push("timestamps");
  return enabled;
}
</script>

<template>
  <main class="app-list">
    <header class="app-list__header">
      <h1>Registered apps</h1>
      <RouterLink to="/apps/new">
        <Button label="Register app" data-testid="app-list-register" />
      </RouterLink>
    </header>

    <p v-if="appsQuery.isPending.value" data-testid="app-list-loading">Loading apps…</p>

    <Message v-else-if="appsQuery.isError.value" severity="error" data-testid="app-list-error">
      Could not load apps: {{ appsQuery.error.value?.message }}
    </Message>

    <p v-else-if="apps.length === 0" data-testid="app-list-empty">No apps registered yet.</p>

    <DataTable v-else :value="apps" data-key="id" data-testid="app-list-table">
      <Column field="name" header="Name">
        <template #body="{ data }">
          <RouterLink :to="`/apps/${data.id}`" :data-testid="`app-link-${data.id}`">
            {{ data.name }}
          </RouterLink>
        </template>
      </Column>
      <Column field="status" header="Status">
        <template #body="{ data }">
          <Tag
            :severity="data.status === 'active' ? 'success' : 'secondary'"
            :value="data.status"
          />
        </template>
      </Column>
      <Column field="baseUrl" header="Base URL">
        <template #body="{ data }">
          <code v-if="data.baseUrl">{{ data.baseUrl }}</code>
          <span v-else class="app-list__muted">—</span>
        </template>
      </Column>
      <Column header="Capabilities">
        <template #body="{ data }">
          <template v-if="enabledCapabilities(data.capabilities).length > 0">
            <Tag
              v-for="capability in enabledCapabilities(data.capabilities)"
              :key="capability"
              severity="info"
              :value="capability"
              class="app-list__cap"
            />
          </template>
          <span v-else class="app-list__muted">none</span>
        </template>
      </Column>
      <Column field="createdAt" header="Created">
        <template #body="{ data }">
          <span>{{ data.createdAt }}</span>
        </template>
      </Column>
    </DataTable>
  </main>
</template>

<style scoped>
.app-list {
  padding: 1.5rem;
}

.app-list__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.app-list__muted {
  color: var(--p-text-muted-color, #64748b);
}

.app-list__cap {
  margin-right: 0.25rem;
}
</style>
