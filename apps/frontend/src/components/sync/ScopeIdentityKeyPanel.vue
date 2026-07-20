<script setup lang="ts">
import type { ConfirmScopeIdentityKeyRequest, ScopeCorrespondenceDto } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref, watch } from "vue";

/**
 * The **scope-identity-key confirmation panel** (SS-15.4) — the container-level analog of
 * the record identity-key panel (RB-3 / {@link IdentityKeyPanel}). It confirms the
 * value-preserving pairing *source `sourceScopeRef` component ↔ target container field*
 * (source `name` ↔ target `title`), **derive-then-correct**: the mediator pre-selects a
 * candidate `scopeIdentityKey` on the pair's `ScopeCorrespondence` (SS-10) and the
 * operator confirms it, or corrects a target field path, before confirming. The
 * value-preserving (`rename`-only) rule is the server's (SS-10, mirroring AS-5); a
 * value-altering pairing comes back as `errorMessage` and is surfaced here without
 * confirming. Presentational: the host view owns the derive read + confirm mutation.
 */
type ScopeIdentityKeyPairing = ScopeCorrespondenceDto["scopeIdentityKey"][number];

const props = defineProps<{
  /** The pair's `ScopeCorrespondence` (SS-10) carrying the candidate pairing, or `null`. */
  correspondence: ScopeCorrespondenceDto | null;
  readonly: boolean;
  pending: boolean;
  errorMessage: string | null;
}>();

const emit = defineEmits<{ confirm: [request: ConfirmScopeIdentityKeyRequest] }>();

/** Editable copy of the candidate pairings — the operator may correct a target field path. */
const pairings = ref<ScopeIdentityKeyPairing[]>([]);

watch(
  () => props.correspondence,
  (correspondence) => {
    pairings.value = (correspondence?.scopeIdentityKey ?? []).map((pairing) => ({
      ...pairing,
    }));
  },
  { immediate: true, deep: true },
);

const isConfirmed = computed<boolean>(() => props.correspondence?.confirmedBy !== null);

function isValuePreserving(pairing: ScopeIdentityKeyPairing): boolean {
  return pairing.transform === undefined || pairing.transform.kind === "rename";
}

const hasValueAltering = computed<boolean>(() =>
  pairings.value.some((pairing) => !isValuePreserving(pairing)),
);

const canConfirm = computed<boolean>(
  () =>
    !props.readonly &&
    !props.pending &&
    props.correspondence !== null &&
    pairings.value.length > 0 &&
    pairings.value.every((pairing) => pairing.targetFieldPath.trim() !== ""),
);

function confirm(): void {
  if (props.correspondence === null || !canConfirm.value) {
    return;
  }
  const scopeIdentityKey: ScopeIdentityKeyPairing[] = pairings.value.map((pairing) => ({
    sourceScopeKey: pairing.sourceScopeKey,
    targetFieldPath: pairing.targetFieldPath.trim(),
    ...(pairing.transform !== undefined ? { transform: pairing.transform } : {}),
  }));
  emit("confirm", {
    resourcePairRef: props.correspondence.resourcePairRef,
    scopeIdentityKey,
  });
}
</script>

<template>
  <section class="scope-identity-panel" data-testid="scope-identity-panel">
    <header class="scope-identity-panel__header">
      <h3>Scope identity key</h3>
      <Tag
        v-if="isConfirmed"
        severity="success"
        value="confirmed"
        data-testid="scope-identity-confirmed"
      />
      <Tag v-else severity="warn" value="unconfirmed" data-testid="scope-identity-unconfirmed" />
    </header>

    <p class="scope-identity-panel__consequence" data-testid="scope-identity-consequence">
      Confirm the value-preserving pairing of each source scope component (from
      <code>sourceScopeRef</code>) to a target container identity field — how the mediator decides
      two containers are the same. Only a value-preserving (<code>rename</code>) pairing qualifies;
      a value-altering pairing is rejected by the server.
    </p>

    <p
      v-if="correspondence === null"
      class="scope-identity-panel__empty"
      data-testid="scope-identity-empty"
    >
      No scope correspondence is established for this pair yet — there is no candidate scope
      identity key to confirm.
    </p>

    <template v-else>
      <p class="scope-identity-panel__container" data-testid="scope-identity-target-container">
        Target container:
        <code>{{ correspondence.targetContainerRef.appId }}</code> /
        <code>{{ correspondence.targetContainerRef.resourceRef }}</code>
      </p>

      <ul class="scope-identity-panel__pairings">
        <li
          v-for="pairing in pairings"
          :key="pairing.sourceScopeKey"
          class="scope-identity-panel__pairing"
          :data-testid="`scope-identity-pairing-${pairing.sourceScopeKey}`"
        >
          <code class="scope-identity-panel__source">{{ pairing.sourceScopeKey }}</code>
          <span aria-hidden="true">→</span>
          <label class="scope-identity-panel__target">
            <span class="scope-identity-panel__target-label">target field</span>
            <input
              v-model="pairing.targetFieldPath"
              type="text"
              :disabled="readonly"
              :data-testid="`scope-identity-target-${pairing.sourceScopeKey}`"
            />
          </label>
          <Tag
            v-if="!isValuePreserving(pairing)"
            severity="warn"
            value="not a rename"
            :data-testid="`scope-identity-nonrename-${pairing.sourceScopeKey}`"
          />
        </li>
      </ul>

      <p
        v-if="hasValueAltering"
        class="scope-identity-panel__hint"
        data-testid="scope-identity-nonrename-hint"
      >
        A pairing is not a <code>rename</code>. The server will reject it — a scope identity key
        must be value-preserving.
      </p>

      <Message v-if="errorMessage !== null" severity="error" data-testid="scope-identity-error">
        {{ errorMessage }}
      </Message>

      <Button
        v-if="!readonly"
        label="Confirm scope identity key"
        :disabled="!canConfirm"
        data-testid="scope-identity-confirm"
        @click="confirm"
      />
    </template>
  </section>
</template>

<style scoped>
.scope-identity-panel {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.scope-identity-panel__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.scope-identity-panel__consequence,
.scope-identity-panel__container {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.scope-identity-panel__empty {
  margin: 0;
  font-style: italic;
  color: var(--p-text-muted-color, #64748b);
}

.scope-identity-panel__pairings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.scope-identity-panel__pairing {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.scope-identity-panel__target {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
}

.scope-identity-panel__target-label {
  color: var(--p-text-muted-color, #64748b);
}

.scope-identity-panel__hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #64748b);
}
</style>
