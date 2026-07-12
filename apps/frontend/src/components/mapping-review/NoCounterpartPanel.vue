<script setup lang="ts">
import type { ProposalShortlistDto } from "@mediator/contracts";
import type { NoCounterpartResource } from "@mediator/domain";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { ref } from "vue";

import { useAnalyzeResourcePair } from "../../composables/useMappingProposals.js";
import NoCounterpartRow from "./NoCounterpartRow.vue";

/**
 * The shortlist context of a proposal (RU-3): the **no-counterpart** resources
 * (each with the RA-5 escape hatch), the `analysisFailed` pairs (shown as needing
 * attention), and — kept **visibly separate, as excluded, with no action** — the
 * spec's `analysisExclusions`. The three are deliberately distinct: a shortlist
 * miss is correctable, a declared exclusion is authoritative scope.
 */
const props = defineProps<{
  proposalId: string;
  sourceSpecId: string;
  targetSpecId: string;
  shortlist: ProposalShortlistDto | null;
  analysisExclusions: readonly NoCounterpartResource[];
  readonly: boolean;
}>();

const analyze = useAnalyzeResourcePair(() => props.proposalId);
const analyzingKey = ref<string | null>(null);

function resourceKey(resource: NoCounterpartResource): string {
  return `${resource.specId}:${resource.resourceRef}`;
}

/** The spec the operator must name a counterpart from (the resource's *other* spec). */
function counterpartSpecId(resource: NoCounterpartResource): string {
  return resource.specId === props.sourceSpecId ? props.targetSpecId : props.sourceSpecId;
}

function isSourceSide(resource: NoCounterpartResource): boolean {
  return resource.specId === props.sourceSpecId;
}

function analyzePair(resource: NoCounterpartResource, counterpart: string): void {
  const request = isSourceSide(resource)
    ? { sourceResourceRef: resource.resourceRef, targetResourceRef: counterpart }
    : { sourceResourceRef: counterpart, targetResourceRef: resource.resourceRef };
  analyzingKey.value = resourceKey(resource);
  analyze.mutate(request, { onSettled: () => (analyzingKey.value = null) });
}
</script>

<template>
  <section class="shortlist-panel" data-testid="shortlist-panel">
    <h3>Shortlist context</h3>

    <Message v-if="analyze.isError.value" severity="error" data-testid="analyze-error">
      {{ analyze.error.value?.message }}
    </Message>

    <!-- No-counterpart resources with the escape hatch (RU-3 crit 1/2/5). -->
    <div class="shortlist-panel__group" data-testid="no-counterpart-group">
      <h4>No counterpart found</h4>
      <p
        v-if="shortlist === null"
        class="shortlist-panel__empty"
        data-testid="no-counterpart-unavailable"
      >
        Shortlist unavailable — the spec-pair shortlist failed for this proposal (see the
        needs-attention banner).
      </p>
      <p
        v-else-if="shortlist.noCounterpartResources.length === 0"
        class="shortlist-panel__empty"
        data-testid="no-counterpart-empty"
      >
        None — every in-scope resource was shortlisted.
      </p>
      <NoCounterpartRow
        v-for="resource in shortlist?.noCounterpartResources ?? []"
        :key="resourceKey(resource)"
        :resource="resource"
        :counterpart-spec-id="counterpartSpecId(resource)"
        :readonly="readonly"
        :pending="analyze.isPending.value && analyzingKey === resourceKey(resource)"
        @analyze="(counterpart) => analyzePair(resource, counterpart)"
      />
    </div>

    <!-- Analysis-failed pairs — needs attention, not silently omitted (RU-3 crit 4). -->
    <div
      v-if="shortlist !== null && shortlist.analysisFailedPairs.length > 0"
      class="shortlist-panel__group"
      data-testid="analysis-failed-group"
    >
      <h4>Analysis failed — needs attention</h4>
      <div
        v-for="pair in shortlist.analysisFailedPairs"
        :key="`${pair.sourceResource}:${pair.targetResource}`"
        class="shortlist-panel__failed"
        :data-testid="`analysis-failed-${pair.sourceResource}`"
      >
        <Tag severity="danger" value="analysis failed" />
        <code>{{ pair.sourceResource }} → {{ pair.targetResource }}</code>
        <span class="shortlist-panel__muted">{{ pair.rationale }}</span>
      </div>
    </div>

    <!-- Excluded resources — separate, no analyze action (RU-3 crit 3). -->
    <div class="shortlist-panel__group" data-testid="excluded-group">
      <h4>Excluded from analysis</h4>
      <p
        v-if="analysisExclusions.length === 0"
        class="shortlist-panel__empty"
        data-testid="excluded-empty"
      >
        None.
      </p>
      <div
        v-for="resource in analysisExclusions"
        :key="resourceKey(resource)"
        class="shortlist-panel__excluded"
        :data-testid="`excluded-${resource.resourceRef}`"
      >
        <Tag severity="secondary" value="excluded" />
        <code>{{ resource.resourceRef }}</code>
        <span class="shortlist-panel__muted">in {{ resource.specId }}</span>
      </div>
      <p class="shortlist-panel__note">
        Excluded resources are your declared scope — re-including one is a scope edit, not a
        review-screen override, so there is no "analyze anyway" action here.
      </p>
    </div>
  </section>
</template>

<style scoped>
.shortlist-panel {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.shortlist-panel__group h4 {
  margin: 0 0 0.35rem;
}

.shortlist-panel__empty {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
}

.shortlist-panel__failed,
.shortlist-panel__excluded {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.25rem 0;
}

.shortlist-panel__muted {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.shortlist-panel__note {
  margin: 0.35rem 0 0;
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.8rem;
}
</style>
