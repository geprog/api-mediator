<script setup lang="ts">
import type { ResourceBindingDto, UpdateResourceBindingRequest } from "@mediator/contracts";
import type { Ir } from "@mediator/domain";
import Card from "primevue/card";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";

import {
  useResourceBindings,
  useUpdateResourceBinding,
} from "../../composables/useResourceBindings.js";
import { useAuthStore } from "../../stores/auth.js";
import { buildRefTargetOptions, type RefTargetOptions } from "./binding-model.js";
import BindingRefRow from "./BindingRefRow.vue";
import ScopeBindingRow from "./ScopeBindingRow.vue";

/**
 * `ResourceBinding` confirmation panel (RB-3). Owns the spec's bindings query so
 * it self-refreshes after a confirm/correct (the mutation invalidates the query).
 * The IR is supplied by the parent (shared with the IR viewer) to feed each
 * resource's correction picker without a second fetch.
 *
 * Also hosts the SS-6/SS-9 scope path-parameter supply UI: each scope entry offers the
 * SS-9.2 kind choice (`constant` / `record-derived`, with `scope-link` disabled) and,
 * per kind, the input to supply — a `constant` value (SS-3) or a `record-derived`
 * `sourceScopeKey` (SS-8a). Confirming it clears the SS-5/SS-9 enablement blocker via the
 * same PATCH + query invalidation, so the panel and the enablement checklist both reflect
 * the satisfied item (SS-6.3 / SU-5.3).
 */
const props = defineProps<{
  specId: string;
  ir: Ir;
  /**
   * Rule/source context for a `record-derived` choice (SS-9.2): the **source** resource's
   * confirmed `sourceScopeRef` component keys. Provided when the panel is reached with rule
   * context (the enablement `source-scope-ref` deep-link knows the rule → source resource),
   * threaded to each scope row as its `sourceScopeKey` pick list; `undefined` in a standalone
   * spec/binding view, where the row falls back to a free-text `sourceScopeKey` input.
   */
  sourceScopeKeyOptions?: readonly string[];
}>();

const auth = useAuthStore();
// SS-6.4 / SS-9.3 — the kind selector, inputs + confirm action are absent for a viewer. Only
// the scope section is role-gated here; the operational ref rows keep their RB-3 behavior.
const scopeReadonly = computed<boolean>(() => !auth.isOperator);

const bindingsQuery = useResourceBindings(() => props.specId);
const updateMutation = useUpdateResourceBinding(() => props.specId);

const bindings = computed<ResourceBindingDto[]>(() => bindingsQuery.data.value?.bindings ?? []);

/** Correction targets per binding, keyed by binding id (from the matching IR group). */
const targetOptionsByBinding = computed<Record<string, RefTargetOptions>>(() => {
  const map: Record<string, RefTargetOptions> = {};
  for (const binding of bindings.value) {
    const group = props.ir.find((candidate) => candidate.resourceRef === binding.resourceRef);
    map[binding.id] = buildRefTargetOptions(group);
  }
  return map;
});

function optionsFor(bindingId: string): RefTargetOptions {
  return targetOptionsByBinding.value[bindingId] ?? { field: [], operation: [], parameter: [] };
}

function applyUpdate(payload: { bindingId: string; request: UpdateResourceBindingRequest }): void {
  updateMutation.mutate(payload);
}
</script>

<template>
  <section class="binding-panel" data-testid="binding-panel">
    <h3>Resource bindings</h3>
    <p class="binding-panel__hint">
      Bindings are heuristic guesses until confirmed. Unconfirmed refs are highlighted; a
      not-applicable ref is not actionable.
    </p>

    <p v-if="bindingsQuery.isPending.value" data-testid="binding-loading">Loading bindings…</p>

    <Message v-else-if="bindingsQuery.isError.value" severity="error" data-testid="binding-error">
      Could not load bindings: {{ bindingsQuery.error.value?.message }}
    </Message>

    <p v-else-if="bindings.length === 0" data-testid="binding-empty">
      This spec has no resource bindings.
    </p>

    <template v-else>
      <Message
        v-if="updateMutation.isError.value"
        severity="error"
        data-testid="binding-mutation-error"
      >
        {{ updateMutation.error.value?.message }}
      </Message>

      <Card
        v-for="binding in bindings"
        :key="binding.id"
        class="binding-card"
        :data-testid="`binding-resource-${binding.resourceRef}`"
      >
        <template #title>
          <span>{{ binding.resourceRef }}</span>
          <Tag severity="secondary" value="resource" />
        </template>
        <template #content>
          <BindingRefRow
            v-for="bindingRef in binding.refs"
            :key="bindingRef.kind"
            :binding-id="binding.id"
            :ref-dto="bindingRef"
            :target-options="optionsFor(binding.id)"
            @confirm="applyUpdate"
            @correct="applyUpdate"
          />

          <!-- SS-6.2 / SS-9.2: scope path-parameter bindings — a fill-source kind to choose
               and that kind's datum to supply, not refs to ratify. Each entry renders per its
               DTO kind (`constant`/`record-derived`), whichever it currently is. -->
          <section
            v-if="binding.scopeBindings.length > 0"
            class="binding-card__scopes"
            :data-testid="`scope-bindings-${binding.resourceRef}`"
          >
            <h4 class="binding-card__scopes-title">Scope path parameters</h4>
            <p class="binding-card__scopes-hint">
              Non-record-id path parameters this resource is reached through. For each, choose how
              it is filled — a <strong>constant</strong> you supply or a
              <strong>record-derived</strong> source scope key — and confirm it; a rule cannot
              enable until every one is confirmed (SS-5/SS-9).
            </p>
            <ScopeBindingRow
              v-for="scope in binding.scopeBindings"
              :key="scope.parameterName"
              :binding-id="binding.id"
              :scope="scope"
              :readonly="scopeReadonly"
              :source-scope-key-options="props.sourceScopeKeyOptions"
              @confirm="applyUpdate"
            />
          </section>
        </template>
      </Card>
    </template>
  </section>
</template>

<style scoped>
.binding-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.binding-panel__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.binding-card {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
}

.binding-card__scopes {
  margin-top: 0.75rem;
  border-top: 2px solid var(--p-content-border-color, #e2e8f0);
  padding-top: 0.5rem;
}

.binding-card__scopes-title {
  margin: 0.25rem 0;
}

.binding-card__scopes-hint {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0 0 0.25rem;
}
</style>
