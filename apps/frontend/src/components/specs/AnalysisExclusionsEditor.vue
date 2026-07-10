<script setup lang="ts">
import type { Ir } from "@mediator/domain";
import Button from "primevue/button";
import Message from "primevue/message";
import { computed, ref, watch } from "vue";

import { useAppSpecs, useUpdateAnalysisExclusions } from "../../composables/useSpecs.js";

/**
 * Post-registration `analysisExclusions` editor (SI-4 criterion 3): toggle which
 * resource groups are excluded from later mapping analysis and PATCH the new
 * list. The current exclusions come from the owning app's spec metadata; the
 * toggles come from this spec's IR resource groups (an unknown ref is rejected
 * server-side — SI-4 criterion 4). Setting exclusions triggers no analysis in
 * Phase 1.
 */
const props = defineProps<{ specId: string; appId: string; ir: Ir }>();

const specsQuery = useAppSpecs(() => props.appId);
const updateMutation = useUpdateAnalysisExclusions();

const currentSpec = computed(() =>
  specsQuery.data.value?.specs.find((spec) => spec.id === props.specId),
);
const groups = computed(() =>
  props.ir.map((group) => ({ resourceRef: group.resourceRef, name: group.name })),
);

const selected = ref<string[]>([]);
watch(
  currentSpec,
  (spec) => {
    if (spec !== undefined) {
      selected.value = [...spec.analysisExclusions];
    }
  },
  { immediate: true },
);

function toggle(resourceRef: string): void {
  selected.value = selected.value.includes(resourceRef)
    ? selected.value.filter((ref) => ref !== resourceRef)
    : [...selected.value, resourceRef];
}

function save(): void {
  updateMutation.mutate({
    specId: props.specId,
    request: { analysisExclusions: [...selected.value] },
  });
}
</script>

<template>
  <section class="exclusions-editor" data-testid="exclusions-editor">
    <h3>Analysis exclusions</h3>
    <p class="exclusions-editor__hint">
      Excluded resource groups are kept out of later mapping analysis.
    </p>

    <p v-if="groups.length === 0" data-testid="exclusions-empty">
      This spec has no resource groups.
    </p>

    <label
      v-for="group in groups"
      :key="group.resourceRef"
      class="exclusions-editor__row"
      :data-testid="`exclusion-toggle-${group.resourceRef}`"
    >
      <input
        type="checkbox"
        :checked="selected.includes(group.resourceRef)"
        @change="toggle(group.resourceRef)"
      />
      {{ group.name }} — {{ group.resourceRef }}
    </label>

    <Message v-if="updateMutation.isError.value" severity="error" data-testid="exclusions-error">
      {{ updateMutation.error.value?.message }}
    </Message>
    <Message
      v-else-if="updateMutation.isSuccess.value"
      severity="success"
      data-testid="exclusions-saved"
    >
      Exclusions saved.
    </Message>

    <Button
      label="Save exclusions"
      data-testid="exclusions-save"
      :loading="updateMutation.isPending.value"
      @click="save"
    />
  </section>
</template>

<style scoped>
.exclusions-editor {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.exclusions-editor__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.exclusions-editor__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
