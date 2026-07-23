<script setup lang="ts">
import type { ApprovedMappingDto } from "@mediator/contracts";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed } from "vue";

import { statusExplanation, statusSeverity, suspensionAction } from "./suspension-model.js";

/**
 * The SL-10 suspend/resume control for one `ApprovedMapping`: its current `status`, what
 * that means for execution, and the single action available from it.
 *
 * Presentational — the owning view holds the mutations and passes state in; this emits the
 * operator's intent. A `viewer` sees the status but no action (`readonly`), mirroring the
 * server's OA-2 gate, which rejects the mutation `403` regardless.
 */
const props = defineProps<{
  mapping: ApprovedMappingDto;
  /** Signed in as a viewer — read-only, no action offered (OA-2). */
  readonly: boolean;
  /** A transition is in flight for this mapping (disables the action). */
  pending: boolean;
}>();

const emit = defineEmits<{
  suspend: [mappingId: string];
  resume: [mappingId: string];
}>();

const action = computed(() => suspensionAction(props.mapping.status));
const explanation = computed<string>(() => statusExplanation(props.mapping.status));
const severity = computed(() => statusSeverity(props.mapping.status));

function onAct(): void {
  if (props.readonly || props.pending) {
    return;
  }
  if (action.value.kind === "suspend") {
    emit("suspend", props.mapping.id);
  } else if (action.value.kind === "resume") {
    emit("resume", props.mapping.id);
  }
}
</script>

<template>
  <li class="mapping-row" :data-testid="`approved-mapping-${mapping.id}`">
    <div class="mapping-row__main">
      <div class="mapping-row__heading">
        <Tag :severity="severity" :value="mapping.status" data-testid="mapping-status" />
        <code class="mapping-row__variant">{{ mapping.variant }}</code>
      </div>
      <code class="mapping-row__pair">
        {{ mapping.sourceAppId }} &rarr; {{ mapping.targetAppId }}
      </code>
      <p class="mapping-row__explanation" data-testid="mapping-status-explanation">
        {{ explanation }}
      </p>
      <p
        v-if="action.kind === 'none'"
        class="mapping-row__blocked"
        data-testid="mapping-action-blocked"
      >
        {{ action.reason }}
      </p>
    </div>

    <div v-if="!readonly && action.kind !== 'none'" class="mapping-row__actions">
      <Button
        v-if="action.kind === 'suspend'"
        label="Suspend"
        severity="secondary"
        :disabled="pending"
        data-testid="suspend-mapping"
        @click="onAct"
      />
      <Button
        v-else
        label="Resume"
        :disabled="pending"
        data-testid="resume-mapping"
        @click="onAct"
      />
    </div>
  </li>
</template>

<style scoped>
.mapping-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
}

.mapping-row__main {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.mapping-row__heading {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.mapping-row__variant,
.mapping-row__pair {
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.mapping-row__explanation {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #64748b);
}

.mapping-row__blocked {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-orange-600, #ea580c);
}

.mapping-row__actions {
  flex: none;
}
</style>
