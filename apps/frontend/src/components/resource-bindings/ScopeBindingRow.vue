<script setup lang="ts">
import type { ResourceBindingScopeDto, UpdateResourceBindingRequest } from "@mediator/contracts";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import {
  canSupplyScope,
  canSupplyScopeKey,
  scopeBindingState,
  SCOPE_KIND_OPTIONS,
  type SelectableScopeBindingKind,
} from "./binding-model.js";

/**
 * One scope path-parameter binding, **kind-aware** (SS-9.2). It is deliberately **not**
 * a {@link BindingRefRow}: a ref row ratifies (or corrects) a *derived IR pointer*,
 * whereas a scope binding is a **fill source the operator chooses + supplies**. The row
 * offers the SS-9.2 kind selector — `constant` / `record-derived` (both selectable) plus
 * `scope-link` shown disabled (a Layer-3 kind, not built yet) — and, per the selected
 * kind, the input for that kind's datum plus a single supply-and-confirm action:
 *
 * - `constant` (SS-3, unchanged) — a free-text **value** the operator types in; confirms
 *   the `{ parameterName, value }` scope patch. Empty value cannot be confirmed (the
 *   server rejects it, SS-3.3), so the action is disabled until a non-blank value.
 * - `record-derived` (SS-8a) — a **`sourceScopeKey`** naming which captured-scope component
 *   fills the parameter; confirms the `{ parameterName, kind: "record-derived",
 *   sourceScopeKey }` scope patch. The key is picked from the source resource's confirmed
 *   `sourceScopeRef` components when the panel has that rule context ({@link sourceScopeKeyOptions});
 *   otherwise a free-text input is the fallback (the gate validates it per-rule regardless —
 *   the client is not the authority). Empty key cannot be confirmed (the server 400s it).
 *
 * The existing entry renders per its **DTO** `kind` (its current persisted fill source);
 * the selector seeds from that kind and lets the operator switch which kind to confirm into.
 * No value-altering `transform` is offered (the server rejects one; L2's shared value-space
 * is pass-through). The datum shown is operator config, never a live payload / credential
 * value (SS-9.3). For a viewer the selector, inputs, and action are absent — read-only
 * (SS-9.3; OA-2 is the server guarantee).
 */
const props = defineProps<{
  bindingId: string;
  scope: ResourceBindingScopeDto;
  /** Read-only for a viewer (`!isOperator`): the selector, inputs + confirm action are absent. */
  readonly: boolean;
  /**
   * Rule-context pick list: the **source** resource's confirmed `sourceScopeRef` component
   * keys. When provided (the panel was reached with rule/source context) a `record-derived`
   * choice offers these as a pick list; when `undefined` (a standalone binding view) it falls
   * back to a free-text `sourceScopeKey` input.
   */
  sourceScopeKeyOptions?: readonly string[] | undefined;
}>();

const emit = defineEmits<{
  confirm: [payload: { bindingId: string; request: UpdateResourceBindingRequest }];
}>();

const state = computed(() => scopeBindingState(props.scope));
const stateSeverity = computed<"success" | "warn">(() =>
  state.value === "confirmed" ? "success" : "warn",
);

// The kind to confirm INTO — seeded from the entry's current DTO kind (SS-2 defaults it to
// `constant`), operator-switchable. A persisted `scope-link` entry (SS-12) is displayed
// read-only but is not a **selectable** confirm kind here (the container-linking confirm UI
// is SS-15), so the selector seeds to `constant`; the operator switches to a real kind.
const selectedKind = ref<SelectableScopeBindingKind>(
  props.scope.kind === "scope-link" ? "constant" : props.scope.kind,
);

// Per-kind drafts, seeded from the matching DTO member so a confirmed entry shows as stored
// (SS-9.3); blank for the other kind and while unconfirmed (SS-2 derives a `constant` blank).
const draftValue = ref<string>(props.scope.kind === "constant" ? props.scope.value : "");
const draftSourceScopeKey = ref<string>(
  props.scope.kind === "record-derived" ? props.scope.sourceScopeKey : "",
);

/** Rule/source context present → the `sourceScopeKey` pick list; absent → the text fallback. */
const hasSourceScopeContext = computed<boolean>(() => props.sourceScopeKeyOptions !== undefined);

/** The current persisted datum, shown read-only (operator config, never a live/secret value). */
const currentDatum = computed<string>(() => {
  switch (props.scope.kind) {
    case "constant":
      return props.scope.value;
    case "record-derived":
      return props.scope.sourceScopeKey;
    case "scope-link":
      // SS-12 — the target-container key the resolved `ScopeLink` fills this parameter from;
      // shown read-only (the container-linking confirm UI is SS-15).
      return props.scope.scopeKeyRef;
  }
});

const canConfirm = computed<boolean>(() =>
  selectedKind.value === "constant"
    ? canSupplyScope(draftValue.value)
    : canSupplyScopeKey(draftSourceScopeKey.value),
);

function supplyAndConfirm(): void {
  if (!canConfirm.value) {
    return;
  }
  const request: UpdateResourceBindingRequest =
    selectedKind.value === "constant"
      ? { parameterName: props.scope.parameterName, value: draftValue.value }
      : {
          parameterName: props.scope.parameterName,
          kind: "record-derived",
          sourceScopeKey: draftSourceScopeKey.value,
        };
  emit("confirm", { bindingId: props.bindingId, request });
}
</script>

<template>
  <div class="scope-row" :data-testid="`scope-row-${scope.parameterName}`">
    <div class="scope-row__head">
      <span class="scope-row__label">Scope path parameter</span>
      <code class="scope-row__param">{{ scope.parameterName }}</code>
      <Tag
        severity="secondary"
        :value="scope.kind"
        :data-testid="`scope-kind-${scope.parameterName}`"
      />
      <Tag
        :severity="stateSeverity"
        :value="state"
        :data-testid="`scope-state-${scope.parameterName}`"
      />
    </div>

    <p class="scope-row__hint">
      A non-record-id path parameter this resource is reached through — choose how it is filled and
      supply that kind's input.
    </p>

    <p v-if="scope.confirmedBy !== null" class="scope-row__confirmed-by">
      Confirmed by {{ scope.confirmedBy }}
    </p>

    <template v-if="!readonly">
      <label class="scope-row__field">
        <span class="scope-row__field-label">Kind</span>
        <select
          v-model="selectedKind"
          class="scope-row__select"
          :data-testid="`scope-kind-select-${scope.parameterName}`"
        >
          <option
            v-for="option in SCOPE_KIND_OPTIONS"
            :key="option.kind"
            :value="option.kind"
            :disabled="option.disabled"
            :data-testid="`scope-kind-option-${scope.parameterName}-${option.kind}`"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <!-- constant (SS-3): a value to type in — unchanged behavior. -->
      <label v-if="selectedKind === 'constant'" class="scope-row__field">
        <span class="scope-row__field-label">Value</span>
        <input
          v-model="draftValue"
          type="text"
          class="scope-row__input"
          :data-testid="`scope-input-${scope.parameterName}`"
          :placeholder="`literal value for ${scope.parameterName}`"
        />
      </label>

      <!-- record-derived (SS-8a): a sourceScopeKey — a pick list with rule context, else text. -->
      <label v-else class="scope-row__field">
        <span class="scope-row__field-label">Source scope key</span>
        <select
          v-if="hasSourceScopeContext"
          v-model="draftSourceScopeKey"
          class="scope-row__select"
          :data-testid="`scope-sourcekey-select-${scope.parameterName}`"
        >
          <option value="" disabled>Select a source scope component…</option>
          <option v-for="key in sourceScopeKeyOptions" :key="key" :value="key">
            {{ key }}
          </option>
        </select>
        <input
          v-else
          v-model="draftSourceScopeKey"
          type="text"
          class="scope-row__input"
          :data-testid="`scope-sourcekey-input-${scope.parameterName}`"
          :placeholder="`source scope component key for ${scope.parameterName}`"
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
      {{ state === "confirmed" ? currentDatum : "— not supplied —" }}
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
  min-width: 8rem;
}

.scope-row__input,
.scope-row__select {
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
