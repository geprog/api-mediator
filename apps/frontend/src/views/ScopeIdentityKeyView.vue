<script setup lang="ts">
import type { ConfirmScopeIdentityKeyRequest } from "@mediator/contracts";
import Message from "primevue/message";
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";

import ScopeIdentityKeyPanel from "../components/sync/ScopeIdentityKeyPanel.vue";
import {
  useConfirmScopeIdentityKey,
  useScopeIdentityKeyDerivation,
} from "../composables/useScopeIdentityKey.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * The SS-15.4 scope-identity-key confirmation screen — the deep-link target of the
 * enablement panel's unconfirmed-scope-identity-key blocker. It owns the derive read +
 * confirm mutation and hosts {@link ScopeIdentityKeyPanel}; the value-preserving /
 * operator-only / not-established invariants are all server-enforced (SS-10/SS-15, OA-2).
 * The pair is addressed by the `?pair=` query parameter.
 */
const route = useRoute();
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const resourcePairRef = computed<string>(() => {
  const raw = route.query["pair"];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return typeof raw === "string" ? raw : "";
});

const derivation = useScopeIdentityKeyDerivation(resourcePairRef);
const correspondence = computed(() => derivation.data.value?.correspondence ?? null);

const confirm = useConfirmScopeIdentityKey();
const actionError = ref<string | null>(null);
const confirmed = ref<boolean>(false);

function onConfirm(request: ConfirmScopeIdentityKeyRequest): void {
  actionError.value = null;
  confirmed.value = false;
  confirm.mutate(request, {
    onSuccess: () => (confirmed.value = true),
    onError: (error) => (actionError.value = error.message),
  });
}
</script>

<template>
  <main class="scope-identity-key" data-testid="scope-identity-key-view">
    <RouterLink to="/sync">← All sync rules</RouterLink>
    <h1>Scope identity key</h1>

    <Message v-if="readonly" severity="secondary" data-testid="scope-identity-readonly">
      You are signed in as a viewer — confirming is read-only.
    </Message>

    <p v-if="resourcePairRef === ''" data-testid="scope-identity-no-pair">
      No resource pair was specified.
    </p>

    <p v-else-if="derivation.isPending.value" data-testid="scope-identity-loading">
      Loading scope correspondence…
    </p>

    <Message
      v-else-if="derivation.isError.value"
      severity="error"
      data-testid="scope-identity-load-error"
    >
      Could not load the scope correspondence: {{ derivation.error.value?.message }}
    </Message>

    <template v-else>
      <ScopeIdentityKeyPanel
        :correspondence="correspondence"
        :readonly="readonly"
        :pending="confirm.isPending.value"
        :error-message="actionError"
        @confirm="onConfirm"
      />
      <Message v-if="confirmed" severity="success" data-testid="scope-identity-confirmed-outcome">
        Scope identity key confirmed. The rule's scope-identity-key blocker is cleared.
      </Message>
    </template>
  </main>
</template>

<style scoped>
.scope-identity-key {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
