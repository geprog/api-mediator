<script setup lang="ts">
import type { ApprovedMappingDto } from "@mediator/contracts";
import Message from "primevue/message";
import { computed, ref } from "vue";

import MappingSuspensionRow from "../components/approved-mappings/MappingSuspensionRow.vue";
import {
  useApprovedMappings,
  useResumeApprovedMapping,
  useSuspendApprovedMapping,
} from "../composables/useApprovedMappings.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * **SL-10 — the approved-mapping lifecycle screen.** Every `ApprovedMapping` with its
 * current `status`, what that status means for execution, and the one transition available
 * from it: suspend an `active` mapping (a deliberate operator hold — its sync rules pause
 * and its adapter bindings fail live calls with `mapping-suspended`) or resume a `suspended`
 * one (the exact inverse — rules and bindings resume under their stored state).
 *
 * A `viewer` sees the statuses but is offered no action; the server rejects the mutation
 * `403` regardless (OA-2), so this only keeps the affordances honest.
 */
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const mappingsQuery = useApprovedMappings();
const mappings = computed<ApprovedMappingDto[]>(() => mappingsQuery.data.value?.mappings ?? []);

const suspendMutation = useSuspendApprovedMapping();
const resumeMutation = useResumeApprovedMapping();

/** The mapping a transition is currently in flight for, so only its own action disables. */
const pendingMappingId = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

function isPending(mappingId: string): boolean {
  return pendingMappingId.value === mappingId;
}

async function run(mappingId: string, action: "suspend" | "resume"): Promise<void> {
  if (!auth.isOperator || pendingMappingId.value !== null) {
    return;
  }
  pendingMappingId.value = mappingId;
  errorMessage.value = null;
  try {
    if (action === "suspend") {
      await suspendMutation.mutateAsync(mappingId);
    } else {
      await resumeMutation.mutateAsync(mappingId);
    }
  } catch (error) {
    // The server owns the transition rules; surface its reason verbatim (e.g. the 409 for
    // resuming a mapping a breaking change marked `stale` while it was suspended).
    errorMessage.value = error instanceof Error ? error.message : "The transition failed.";
  } finally {
    pendingMappingId.value = null;
  }
}

function onSuspend(mappingId: string): void {
  void run(mappingId, "suspend");
}

function onResume(mappingId: string): void {
  void run(mappingId, "resume");
}
</script>

<template>
  <main class="approved-mappings">
    <header>
      <h1>Approved mappings</h1>
      <p class="approved-mappings__intro">
        Suspend a mapping to stop it executing for an operational reason — a deliberate hold,
        distinct from the <code>stale</code> state a breaking spec change causes. Resume restores it
        under its stored state: no re-backfill, no re-composition.
      </p>
    </header>

    <Message v-if="readonly" severity="secondary" data-testid="approved-mappings-readonly">
      You are signed in as a viewer — suspend and resume require the operator role.
    </Message>

    <p v-if="mappingsQuery.isPending.value" data-testid="approved-mappings-loading">
      Loading approved mappings…
    </p>

    <Message
      v-else-if="mappingsQuery.isError.value"
      severity="error"
      data-testid="approved-mappings-error"
    >
      Could not load approved mappings: {{ mappingsQuery.error.value?.message }}
    </Message>

    <p v-else-if="mappings.length === 0" data-testid="approved-mappings-empty">
      No approved mappings yet — approve a proposal to create one.
    </p>

    <template v-else>
      <Message v-if="errorMessage !== null" severity="error" data-testid="transition-error">
        {{ errorMessage }}
      </Message>

      <ul class="approved-mappings__list" data-testid="approved-mappings-list">
        <MappingSuspensionRow
          v-for="mapping in mappings"
          :key="mapping.id"
          :mapping="mapping"
          :readonly="readonly"
          :pending="isPending(mapping.id)"
          @suspend="onSuspend"
          @resume="onResume"
        />
      </ul>
    </template>
  </main>
</template>

<style scoped>
.approved-mappings {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.approved-mappings__intro {
  margin: 0.35rem 0 0;
  color: var(--p-text-muted-color, #64748b);
  max-width: 70ch;
}

.approved-mappings__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
</style>
