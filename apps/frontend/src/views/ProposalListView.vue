<script setup lang="ts">
import type {
  AppSpecsResponse,
  MappingProposalSummaryDto,
  RegisteredAppDto,
} from "@mediator/contracts";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import type { ProposalListFilter } from "../api/mapping-proposals.js";
import { useAppList } from "../composables/useApps.js";
import { useProposalList } from "../composables/useMappingProposals.js";
import { useAppSpecs } from "../composables/useSpecs.js";

/**
 * The proposal list (RU-1 crit 5). Filters by **app pair** — the operator picks a
 * source app + spec (required) and, optionally, a target app + spec — then lists
 * the matching `MappingProposal`s via RA-1. Rows link to the review screen. Both
 * `viewer` and `operator` may read this (OA-2); no credential material is rendered.
 */
const appsQuery = useAppList();
const apps = computed<RegisteredAppDto[]>(() => appsQuery.data.value?.apps ?? []);

const sourceAppId = ref<string>("");
const targetAppId = ref<string>("");
const sourceSpecId = ref<string>("");
const targetSpecId = ref<string>("");

const sourceSpecsQuery = useAppSpecs(sourceAppId);
const targetSpecsQuery = useAppSpecs(targetAppId);
const sourceSpecs = computed<AppSpecsResponse["specs"]>(
  () => sourceSpecsQuery.data.value?.specs ?? [],
);
const targetSpecs = computed<AppSpecsResponse["specs"]>(
  () => targetSpecsQuery.data.value?.specs ?? [],
);

// Selecting a different app resets the dependent spec choice.
watch(sourceAppId, () => (sourceSpecId.value = ""));
watch(targetAppId, () => (targetSpecId.value = ""));

const filter = computed<ProposalListFilter | null>(() =>
  sourceSpecId.value === ""
    ? null
    : {
        sourceSpecId: sourceSpecId.value,
        ...(targetSpecId.value !== "" ? { targetSpecId: targetSpecId.value } : {}),
      },
);

const proposalsQuery = useProposalList(filter);
const proposals = computed<MappingProposalSummaryDto[]>(
  () => proposalsQuery.data.value?.proposals ?? [],
);

function specLabel(spec: AppSpecsResponse["specs"][number]): string {
  return `${spec.role} · ${spec.version} (${spec.id})`;
}
</script>

<template>
  <main class="proposals">
    <h1>Mapping proposals</h1>

    <Message v-if="appsQuery.isError.value" severity="error" data-testid="proposals-apps-error">
      Could not load apps: {{ appsQuery.error.value?.message }}
    </Message>

    <section class="proposals__filter" data-testid="proposals-filter">
      <div class="proposals__pair">
        <label class="proposals__field">
          Source app
          <select v-model="sourceAppId" data-testid="proposal-list-source-app">
            <option value="">Select an app…</option>
            <option v-for="app in apps" :key="app.id" :value="app.id">{{ app.name }}</option>
          </select>
        </label>
        <label class="proposals__field">
          Source spec
          <select
            v-model="sourceSpecId"
            :disabled="sourceAppId === ''"
            data-testid="proposal-list-source-spec"
          >
            <option value="">Select a spec…</option>
            <option v-for="spec in sourceSpecs" :key="spec.id" :value="spec.id">
              {{ specLabel(spec) }}
            </option>
          </select>
        </label>
      </div>

      <div class="proposals__pair">
        <label class="proposals__field">
          Target app (optional)
          <select v-model="targetAppId" data-testid="proposal-list-target-app">
            <option value="">Any</option>
            <option v-for="app in apps" :key="app.id" :value="app.id">{{ app.name }}</option>
          </select>
        </label>
        <label class="proposals__field">
          Target spec (optional)
          <select
            v-model="targetSpecId"
            :disabled="targetAppId === ''"
            data-testid="proposal-list-target-spec"
          >
            <option value="">Any</option>
            <option v-for="spec in targetSpecs" :key="spec.id" :value="spec.id">
              {{ specLabel(spec) }}
            </option>
          </select>
        </label>
      </div>
    </section>

    <p v-if="filter === null" class="proposals__hint" data-testid="proposals-prompt">
      Choose a source spec to list its proposals.
    </p>

    <template v-else>
      <p v-if="proposalsQuery.isPending.value" data-testid="proposals-loading">
        Loading proposals…
      </p>

      <Message
        v-else-if="proposalsQuery.isError.value"
        severity="error"
        data-testid="proposals-error"
      >
        Could not load proposals: {{ proposalsQuery.error.value?.message }}
      </Message>

      <p v-else-if="proposals.length === 0" data-testid="proposals-empty">
        No proposals for this spec pair.
      </p>

      <DataTable v-else :value="proposals" data-key="id" data-testid="proposal-list-table">
        <Column header="Proposal">
          <template #body="{ data }">
            <RouterLink :to="`/proposals/${data.id}`" :data-testid="`proposal-link-${data.id}`">
              {{ data.id }}
            </RouterLink>
          </template>
        </Column>
        <Column field="status" header="Status">
          <template #body="{ data }">
            <Tag :severity="data.status === 'failed' ? 'danger' : 'info'" :value="data.status" />
          </template>
        </Column>
        <Column header="Spec pair">
          <template #body="{ data }">
            <code>{{ data.sourceSpecId }} → {{ data.targetSpecId }}</code>
          </template>
        </Column>
        <Column field="createdAt" header="Created" />
      </DataTable>
    </template>
  </main>
</template>

<style scoped>
.proposals {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.proposals__filter {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.proposals__pair {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.proposals__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 16rem;
}

.proposals__hint {
  color: var(--p-text-muted-color, #64748b);
}
</style>
