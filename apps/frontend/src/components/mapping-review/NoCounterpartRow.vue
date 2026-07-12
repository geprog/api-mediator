<script setup lang="ts">
import type { NoCounterpartResource } from "@mediator/domain";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { ref } from "vue";

/**
 * One no-counterpart resource (RU-3 crit 1) — surfaced like an `unmapped` item,
 * carrying the "analyze this resource pair anyway" escape hatch (RA-5). The
 * operator names the counterpart resource on the other spec; the panel owns the
 * mutation and receives the chosen counterpart via `analyze`. A `viewer`
 * (`readonly`) sees the resource but no action (RU-3 crit 5).
 */
defineProps<{
  resource: NoCounterpartResource;
  counterpartSpecId: string;
  readonly: boolean;
  pending: boolean;
}>();

const emit = defineEmits<{ analyze: [counterpartResourceRef: string] }>();

const counterpart = ref<string>("");

function analyze(): void {
  const value = counterpart.value.trim();
  if (value === "") {
    return;
  }
  emit("analyze", value);
}
</script>

<template>
  <div class="nc-row" :data-testid="`no-counterpart-${resource.resourceRef}`">
    <div class="nc-row__head">
      <Tag severity="warn" value="no counterpart" />
      <code>{{ resource.resourceRef }}</code>
      <span class="nc-row__spec">in {{ resource.specId }}</span>
    </div>
    <p class="nc-row__hint">
      Stage 1 shortlisted no counterpart for this resource. Analyze it against a resource in the
      other spec if a real correspondence was missed.
    </p>
    <div v-if="!readonly" class="nc-row__action">
      <label class="nc-row__field">
        Counterpart resource in {{ counterpartSpecId }}
        <input
          v-model="counterpart"
          type="text"
          :data-testid="`no-counterpart-input-${resource.resourceRef}`"
        />
      </label>
      <Button
        size="small"
        label="Analyze this resource pair anyway"
        :disabled="counterpart.trim() === '' || pending"
        :data-testid="`no-counterpart-analyze-${resource.resourceRef}`"
        @click="analyze"
      />
    </div>
  </div>
</template>

<style scoped>
.nc-row {
  padding: 0.5rem 0;
  border-top: 1px solid var(--p-content-border-color, #e2e8f0);
}

.nc-row__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.nc-row__spec {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.nc-row__hint {
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
  margin: 0.25rem 0;
}

.nc-row__action {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.nc-row__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}
</style>
