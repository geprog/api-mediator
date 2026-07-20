<script setup lang="ts">
import type { ResourceBindingScopeDto, UpdateResourceBindingRequest } from "@mediator/contracts";
import Button from "primevue/button";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import {
  canSupplyScope,
  canSupplyScopeKey,
  canSupplyScopeKeyRef,
  scopeBindingState,
  scopeKindOptions,
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
 * - `scope-link` (SS-18.4, Layer 3) — selectable only once the pair has a proposed
 *   `ScopeCorrespondence` (`scopeLinkAvailable`). Its datum is the **`scopeKeyRef`**: which
 *   component of the resolved `ScopeLink`'s target `appXScopeKey` fills the parameter,
 *   pre-filled from the mediator's derived candidate (`scopeKeyRefCandidate`) and
 *   operator-correctable. Unlike the other two kinds it offers **two** actions, because
 *   SS-18.4 separates them: *Select scope-link* writes the entry **unconfirmed** (the choice
 *   is recorded, and used nowhere), and *Confirm* then ratifies it. Nothing is ever
 *   auto-confirmed (SS-18.8).
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
  /**
   * SS-18.4 — whether this resource's pair has a proposed `ScopeCorrespondence`, which is
   * what makes `scope-link` a **selectable** kind rather than a disabled one.
   */
  scopeLinkAvailable: boolean;
  /**
   * SS-18.4 — the mediator's **derived** `scopeKeyRef` for this resource (which target
   * `appXScopeKey` component addresses its scope parameters), seeding the input. `null`
   * when it could not be derived; the operator then types one. A proposal, not a
   * confirmation.
   */
  scopeKeyRefCandidate: string | null;
}>();

const emit = defineEmits<{
  confirm: [payload: { bindingId: string; request: UpdateResourceBindingRequest }];
}>();

const state = computed(() => scopeBindingState(props.scope));
const stateSeverity = computed<"success" | "warn">(() =>
  state.value === "confirmed" ? "success" : "warn",
);

// The kind to confirm INTO — seeded from the entry's current DTO kind (SS-2 defaults it to
// `constant`), operator-switchable. Since SS-18.4 `scope-link` is a real selectable kind
// (when the pair has a proposed `ScopeCorrespondence`), so a persisted `scope-link` entry
// now seeds the selector to itself rather than falling back to `constant`.
const selectedKind = ref<SelectableScopeBindingKind>(props.scope.kind);

// The kind-selector options (SS-9.2, extended by SS-18.4): `scope-link` is enabled exactly
// when the pair has a proposed correspondence.
const kindOptions = computed(() => scopeKindOptions(props.scopeLinkAvailable));

// Per-kind drafts, seeded from the matching DTO member so a confirmed entry shows as stored
// (SS-9.3); blank for the other kinds and while unconfirmed (SS-2 derives a `constant` blank).
const draftValue = ref<string>(props.scope.kind === "constant" ? props.scope.value : "");
const draftSourceScopeKey = ref<string>(
  props.scope.kind === "record-derived" ? props.scope.sourceScopeKey : "",
);
// SS-18.4 — the stored `scopeKeyRef` if the entry already is `scope-link`, else the
// mediator's derived candidate (a proposal the operator may correct before writing it).
const draftScopeKeyRef = ref<string>(
  props.scope.kind === "scope-link" ? props.scope.scopeKeyRef : (props.scopeKeyRefCandidate ?? ""),
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

const canConfirm = computed<boolean>(() => {
  switch (selectedKind.value) {
    case "constant":
      return canSupplyScope(draftValue.value);
    case "record-derived":
      return canSupplyScopeKey(draftSourceScopeKey.value);
    case "scope-link":
      return canSupplyScopeKeyRef(draftScopeKeyRef.value);
  }
});

/**
 * The scope patch for the selected kind. `confirm` is only meaningful for `scope-link`
 * (SS-18.4's select-then-confirm); the `constant`/`record-derived` shapes are unchanged
 * supply-and-confirm actions, so they ignore it.
 */
function scopePatchFor(confirm: boolean): UpdateResourceBindingRequest {
  switch (selectedKind.value) {
    case "constant":
      return { parameterName: props.scope.parameterName, value: draftValue.value };
    case "record-derived":
      return {
        parameterName: props.scope.parameterName,
        kind: "record-derived",
        sourceScopeKey: draftSourceScopeKey.value,
      };
    case "scope-link":
      return {
        parameterName: props.scope.parameterName,
        kind: "scope-link",
        scopeKeyRef: draftScopeKeyRef.value,
        confirm,
      };
  }
}

function supplyAndConfirm(): void {
  if (!canConfirm.value) {
    return;
  }
  emit("confirm", { bindingId: props.bindingId, request: scopePatchFor(true) });
}

/**
 * SS-18.4 — *select* `scope-link` as this parameter's fill source: the entry is written
 * with the derived `scopeKeyRef` and left **unconfirmed**, so the choice is recorded but
 * used nowhere until the operator confirms it separately (SS-18.8).
 */
function selectScopeLink(): void {
  if (!canConfirm.value) {
    return;
  }
  emit("confirm", { bindingId: props.bindingId, request: scopePatchFor(false) });
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
            v-for="option in kindOptions"
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
      <label v-else-if="selectedKind === 'record-derived'" class="scope-row__field">
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

      <!-- scope-link (SS-18.4, Layer 3): the scopeKeyRef — seeded from the mediator's derived
           candidate, operator-correctable. Two actions: select (writes it UNCONFIRMED) and
           confirm (ratifies it). -->
      <label v-else class="scope-row__field">
        <span class="scope-row__field-label">Scope key ref</span>
        <input
          v-model="draftScopeKeyRef"
          type="text"
          class="scope-row__input"
          :data-testid="`scope-keyref-input-${scope.parameterName}`"
          :placeholder="`container key component for ${scope.parameterName}`"
        />
      </label>

      <p
        v-if="selectedKind === 'scope-link'"
        class="scope-row__hint"
        :data-testid="`scope-keyref-hint-${scope.parameterName}`"
      >
        Which component of the linked container's scope key fills this parameter. Selecting
        <strong>scope-link</strong> records the choice but leaves it unconfirmed — confirm it
        separately, and confirm the pair's scope identity key, before a rule can enable.
      </p>

      <div class="scope-row__buttons">
        <Button
          v-if="selectedKind === 'scope-link'"
          size="small"
          severity="secondary"
          label="Select scope-link"
          :disabled="!canConfirm"
          :data-testid="`scope-select-link-${scope.parameterName}`"
          @click="selectScopeLink"
        />
        <Button
          size="small"
          :label="selectedKind === 'scope-link' ? 'Confirm' : 'Supply and confirm'"
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
