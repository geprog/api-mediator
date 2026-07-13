<script setup lang="ts">
import type { SyncRuleStatusDto } from "@mediator/contracts";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { blockingRequirements, derivePollingState } from "../components/sync/enablement-model.js";
import { useSyncRules } from "../composables/useSyncRules.js";

/**
 * The sync hub (SU-1 list): every `SyncRule` with its status, derived polling state
 * (an enabled+backfilling rule reads as **not yet polling**, BE-3), and how many gate
 * blockers remain, each row linking to its enablement panel. Links across to the
 * manual-linking, conflict-resolution, and parked-write screens. Reads only (SA-2) —
 * no credential material.
 */
const rulesQuery = useSyncRules();
const rules = computed<SyncRuleStatusDto[]>(() => rulesQuery.data.value?.rules ?? []);

function pollingLabel(rule: SyncRuleStatusDto): string {
  switch (derivePollingState(rule)) {
    case "disabled":
      return "disabled";
    case "backfill-running":
      return "backfill running (not polling)";
    case "polling":
      return "polling";
  }
  return "disabled";
}

function blockerCount(rule: SyncRuleStatusDto): number {
  return blockingRequirements(rule.stillNeeds).length;
}
</script>

<template>
  <main class="sync-rules">
    <header class="sync-rules__header">
      <h1>Sync rules</h1>
      <nav class="sync-rules__nav" aria-label="Sync tools">
        <RouterLink to="/sync/manual-links" data-testid="nav-manual-links">
          Manual linking
        </RouterLink>
        <RouterLink to="/sync/conflicts" data-testid="nav-conflicts">Conflicts</RouterLink>
        <RouterLink to="/sync/dead-letter" data-testid="nav-dead-letter">Parked writes</RouterLink>
      </nav>
    </header>

    <p v-if="rulesQuery.isPending.value" data-testid="sync-rules-loading">Loading sync rules…</p>

    <Message v-else-if="rulesQuery.isError.value" severity="error" data-testid="sync-rules-error">
      Could not load sync rules: {{ rulesQuery.error.value?.message }}
    </Message>

    <p v-else-if="rules.length === 0" data-testid="sync-rules-empty">
      No sync rules yet — approve a peer-peer mapping to instantiate one.
    </p>

    <DataTable v-else :value="rules" data-key="id" data-testid="sync-rules-table">
      <Column header="Resource pair">
        <template #body="{ data }">
          <RouterLink :to="`/sync/rules/${data.id}`" :data-testid="`sync-rule-link-${data.id}`">
            <template v-if="data.resourcePair !== null">
              {{ data.resourcePair.source.appName }} ({{ data.resourcePair.source.resourceRef }}) →
              {{ data.resourcePair.target.appName }} ({{ data.resourcePair.target.resourceRef }})
            </template>
            <code v-else>{{ data.resourcePairRef }}</code>
          </RouterLink>
        </template>
      </Column>
      <Column header="Status">
        <template #body="{ data }">
          <Tag
            :severity="data.status === 'enabled' ? 'success' : 'secondary'"
            :value="data.status"
          />
        </template>
      </Column>
      <Column header="Polling">
        <template #body="{ data }">
          <Tag
            :severity="pollingLabel(data) === 'polling' ? 'success' : 'warn'"
            :value="pollingLabel(data)"
            :data-testid="`sync-rule-polling-${data.id}`"
          />
        </template>
      </Column>
      <Column header="Gate">
        <template #body="{ data }">
          <Tag
            v-if="blockerCount(data) === 0"
            severity="success"
            value="ready"
            :data-testid="`sync-rule-gate-${data.id}`"
          />
          <Tag
            v-else
            severity="danger"
            :value="`${blockerCount(data)} still needed`"
            :data-testid="`sync-rule-gate-${data.id}`"
          />
        </template>
      </Column>
    </DataTable>
  </main>
</template>

<style scoped>
.sync-rules {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sync-rules__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.sync-rules__nav {
  display: flex;
  gap: 1rem;
}
</style>
