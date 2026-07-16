<script setup lang="ts">
import type { ResourceBindingScopeDto, UpdateResourceBindingRequest } from "@mediator/contracts";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import { canSupplyScope, scopeBindingState } from "./binding-model.js";

/**
 * One `constant` scope path-parameter binding (SS-6.2). It is deliberately **not**
 * a {@link BindingRefRow}: a ref row ratifies (or corrects) a *derived IR pointer*,
 * whereas a scope constant is a **value the operator types in**. So this row offers
 * a free-text input plus a supply-and-confirm action, not a confirm/correct picker.
 * An empty value cannot be confirmed (the server rejects it, SS-3.3), so the action
 * is disabled until a non-blank value is entered. The literal is operator config,
 * shown exactly as entered (never a live payload / credential value, SS-6.5). Emits
 * the intended scope patch; the panel owns the mutation. For a viewer the input and
 * action are absent — read-only (SS-6.4; OA-2 is the server guarantee).
 */
const props = defineProps<{
  bindingId: string;
  scope: ResourceBindingScopeDto;
  /** Read-only for a viewer (`!isOperator`): the input + confirm action are absent. */
  readonly: boolean;
}>();

const emit = defineEmits<{
  confirm: [payload: { bindingId: string; request: UpdateResourceBindingRequest }];
}>();

const state = computed(() => scopeBindingState(props.scope));
const stateSeverity = computed<"success" | "warn">(() =>
  state.value === "confirmed" ? "success" : "warn",
);

// The literal is a value the operator TYPES IN. Seed from the confirmed value so it
// shows exactly as entered (SS-6.5); empty while unconfirmed (SS-2 derives it blank).
const draftValue = ref<string>(props.scope.value);

const canConfirm = computed<boolean>(() => canSupplyScope(draftValue.value));

function supplyAndConfirm(): void {
  if (!canConfirm.value) {
    return;
  }
  emit("confirm", {
    bindingId: props.bindingId,
    request: { parameterName: props.scope.parameterName, value: draftValue.value },
  });
}
</script>

<template>
  <div class="scope-row" :data-testid="`scope-row-${scope.parameterName}`">
    <div class="scope-row__head">
      <span class="scope-row__label">Scope path parameter</span>
      <code class="scope-row__param">{{ scope.parameterName }}</code>
      <Tag
        :severity="stateSeverity"
        :value="state"
        :data-testid="`scope-state-${scope.parameterName}`"
      />
    </div>

    <p class="scope-row__hint">
      A scope constant — a value you supply for this path parameter, not an IR pointer to ratify.
    </p>

    <p v-if="scope.confirmedBy !== null" class="scope-row__confirmed-by">
      Confirmed by {{ scope.confirmedBy }}
    </p>

    <template v-if="!readonly">
      <label class="scope-row__field">
        <span class="scope-row__field-label">Value</span>
        <input
          v-model="draftValue"
          type="text"
          class="scope-row__input"
          :data-testid="`scope-input-${scope.parameterName}`"
          :placeholder="`literal value for ${scope.parameterName}`"
        />
      </label>
      <div class="scope-row__buttons">
        <Button
          size="small"
          label="Supply and confirm"
          :disabled="!canConfirm"
          :data-testid="`scope-confirm-${scope.parameterName}`"
          @click="supplyAndConfirm"
        />
      </div>
    </template>

    <p v-else class="scope-row__readonly" :data-testid="`scope-readonly-${scope.parameterName}`">
      {{ state === "confirmed" ? scope.value : "— not supplied —" }}
    </p>
  </div>
</template>

<style scoped>
.scope-row {
  padding: 0.5rem 0;
  border-top: 1px solid var(--p-content-border-color, #e2e8f0);
}

.scope-row__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.scope-row__label {
  font-weight: 600;
  min-width: 8rem;
}

.scope-row__param {
  font-family: monospace;
}

.scope-row__hint {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0.25rem 0;
}

.scope-row__field {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.scope-row__field-label {
  font-weight: 600;
}

.scope-row__input {
  flex: 1;
  min-width: 12rem;
}

.scope-row__buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.scope-row__readonly {
  color: var(--p-text-muted-color, #64748b);
  font-family: monospace;
  margin: 0.25rem 0 0;
}

.scope-row__confirmed-by {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0.25rem 0 0;
}
</style>
