<script setup lang="ts">
import type { ResourceBindingRefDto, UpdateResourceBindingRequest } from "@mediator/contracts";
import type { IrRefTarget } from "@mediator/domain";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import {
  canConfirm,
  defaultTargetKind,
  describeTarget,
  REF_KIND_LABELS,
  refState,
  TARGET_KINDS,
  type RefTargetOptions,
  type TargetKind,
} from "./binding-model.js";

/**
 * One `ResourceBinding` ref (RB-3): its heuristic guess, a confirmed / unconfirmed
 * / not-applicable indicator, and — when applicable — actions to confirm the guess
 * or correct it to a different IR element. A not-applicable ref is rendered as a
 * plain, non-actionable state (RB-3 criterion 5). Emits the intended change; the
 * panel owns the mutation.
 */
const props = defineProps<{
  bindingId: string;
  refDto: ResourceBindingRefDto;
  /** Correction candidates from this resource's IR group. */
  targetOptions: RefTargetOptions;
}>();

const emit = defineEmits<{
  confirm: [payload: { bindingId: string; request: UpdateResourceBindingRequest }];
  correct: [payload: { bindingId: string; request: UpdateResourceBindingRequest }];
}>();

const kind = computed(() => props.refDto.kind);
const state = computed(() => refState(props.refDto));

const stateSeverity = computed<"success" | "warn" | "secondary">(() => {
  switch (state.value) {
    case "confirmed":
      return "success";
    case "unconfirmed":
      return "warn";
    case "not-applicable":
      return "secondary";
  }
  return "secondary";
});

const isCorrecting = ref(false);
const selectedTargetKind = ref<TargetKind>(defaultTargetKind(props.refDto.kind));
const selectedTargetKey = ref<string>("");

const targetOptionsForKind = computed(() => props.targetOptions[selectedTargetKind.value]);

function startCorrection(): void {
  isCorrecting.value = true;
  selectedTargetKind.value = defaultTargetKind(props.refDto.kind);
  selectedTargetKey.value = targetOptionsForKind.value[0]?.key ?? "";
}

function cancelCorrection(): void {
  isCorrecting.value = false;
}

function onKindChange(): void {
  selectedTargetKey.value = targetOptionsForKind.value[0]?.key ?? "";
}

function confirm(): void {
  emit("confirm", { bindingId: props.bindingId, request: { refKind: props.refDto.kind } });
}

function selectedTarget(): IrRefTarget | undefined {
  return targetOptionsForKind.value.find((option) => option.key === selectedTargetKey.value)
    ?.target;
}

function saveCorrection(): void {
  const target = selectedTarget();
  if (target === undefined) {
    return;
  }
  emit("correct", {
    bindingId: props.bindingId,
    request: { refKind: props.refDto.kind, value: target },
  });
  isCorrecting.value = false;
}
</script>

<template>
  <div class="ref-row" :data-testid="`ref-row-${kind}`">
    <div class="ref-row__head">
      <span class="ref-row__label">{{ REF_KIND_LABELS[kind] }}</span>
      <Tag :severity="stateSeverity" :value="state" :data-testid="`ref-state-${kind}`" />
      <span class="ref-row__value" :data-testid="`ref-value-${kind}`">{{
        describeTarget(refDto.value)
      }}</span>
    </div>

    <div v-if="state === 'not-applicable'" class="ref-row__na" :data-testid="`ref-na-${kind}`">
      Not applicable for this resource (per the app's capabilities).
    </div>

    <div v-else class="ref-row__actions">
      <p v-if="refDto.confirmedBy !== null" class="ref-row__confirmed-by">
        Confirmed by {{ refDto.confirmedBy }}
      </p>

      <div v-if="!isCorrecting" class="ref-row__buttons">
        <Button
          size="small"
          label="Confirm"
          :disabled="!canConfirm(refDto)"
          :data-testid="`ref-confirm-${kind}`"
          @click="confirm"
        />
        <Button
          size="small"
          severity="secondary"
          label="Correct"
          :data-testid="`ref-correct-${kind}`"
          @click="startCorrection"
        />
      </div>

      <div v-else class="ref-row__correction" :data-testid="`ref-correction-${kind}`">
        <label>
          Target kind
          <select
            v-model="selectedTargetKind"
            :data-testid="`ref-kind-select-${kind}`"
            @change="onKindChange"
          >
            <option v-for="targetKind in TARGET_KINDS" :key="targetKind" :value="targetKind">
              {{ targetKind }}
            </option>
          </select>
        </label>
        <label>
          Target
          <select v-model="selectedTargetKey" :data-testid="`ref-target-select-${kind}`">
            <option value="" disabled>Select a target…</option>
            <option v-for="option in targetOptionsForKind" :key="option.key" :value="option.key">
              {{ option.label }}
            </option>
          </select>
        </label>
        <div class="ref-row__buttons">
          <Button
            size="small"
            label="Save correction"
            :disabled="selectedTargetKey === ''"
            :data-testid="`ref-save-${kind}`"
            @click="saveCorrection"
          />
          <Button
            size="small"
            severity="secondary"
            label="Cancel"
            :data-testid="`ref-cancel-${kind}`"
            @click="cancelCorrection"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ref-row {
  padding: 0.5rem 0;
  border-top: 1px solid var(--p-content-border-color, #e2e8f0);
}

.ref-row__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.ref-row__label {
  font-weight: 600;
  min-width: 8rem;
}

.ref-row__value {
  color: var(--p-text-muted-color, #64748b);
  font-family: monospace;
}

.ref-row__na {
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
  margin-top: 0.25rem;
}

.ref-row__buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.ref-row__correction {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.ref-row__correction select {
  margin-left: 0.5rem;
}

.ref-row__confirmed-by {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0.25rem 0 0;
}
</style>
