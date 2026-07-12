<script setup lang="ts">
import type { IdentityKeyConfirmationDto, MappingProposalItemDto } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref, watch } from "vue";

import {
  describeElementRef,
  identityCandidateItems,
  isRenameItem,
  suggestedIdentityItemId,
} from "./proposal-model.js";

/**
 * The identity-key confirmation panel (RU-4 crit 1-3), rendered by the review view
 * **only for a peer-peer proposal** (a consumer-provider proposal shows none —
 * crit 4). It pre-selects the `identityCandidate` pairing and its
 * `targetLookupParamRef` but never auto-confirms; confirmation is an explicit
 * operator action (the emitted `confirm`).
 *
 * Confirming the identity key **also approves** the currently-decided selection —
 * RA-3 delegates to approve — so the panel says so plainly; it is not a separate
 * non-committing step. The rename-only and shared-pairing locks are enforced by
 * the server (RA-3/AS-5); a violation comes back as `errorMessage` and is surfaced
 * here without confirming. (The counterpart-direction *pre-lock* is not derivable
 * from the read contract, so a divergent attempt is surfaced reactively as that
 * same shared-pairing error.)
 */
const props = defineProps<{
  items: readonly MappingProposalItemDto[];
  readonly: boolean;
  pending: boolean;
  errorMessage: string | null;
}>();

const emit = defineEmits<{ confirm: [confirmation: IdentityKeyConfirmationDto] }>();

const candidates = computed<MappingProposalItemDto[]>(() => identityCandidateItems(props.items));
const suggestedId = computed<string | null>(() => suggestedIdentityItemId(props.items));

const selectedItemId = ref<string>("");
const targetLookupParamRef = ref<string>("");

// Keep the selection valid + pre-set to the LLM's suggestion as items load/change.
watch(
  [candidates, suggestedId],
  () => {
    const ids = candidates.value.map((candidate) => candidate.id);
    if (!ids.includes(selectedItemId.value)) {
      selectedItemId.value = suggestedId.value ?? candidates.value[0]?.id ?? "";
    }
  },
  { immediate: true },
);

// Pre-fill the lookup parameter from the selected candidate's suggestion.
watch(
  selectedItemId,
  (id) => {
    const item = candidates.value.find((candidate) => candidate.id === id);
    targetLookupParamRef.value = item?.targetLookupParamRef ?? "";
  },
  { immediate: true },
);

const selectedItem = computed<MappingProposalItemDto | undefined>(() =>
  candidates.value.find((candidate) => candidate.id === selectedItemId.value),
);

function confirm(): void {
  if (selectedItemId.value === "") {
    return;
  }
  const confirmation: IdentityKeyConfirmationDto = {
    itemId: selectedItemId.value,
    ...(targetLookupParamRef.value !== ""
      ? { targetLookupParamRef: targetLookupParamRef.value }
      : {}),
  };
  emit("confirm", confirmation);
}
</script>

<template>
  <section class="identity-panel" data-testid="identity-panel">
    <h3>Identity key (peer-peer)</h3>
    <p class="identity-panel__consequence" data-testid="identity-consequence">
      Confirming the identity key <strong>also approves</strong> the currently-decided selection and
      emits <code>MappingApproved</code> — it is not a separate, non-committing step. Only a
      value-preserving (<code>rename</code>) field pairing qualifies, and the pairing is shared with
      the reverse direction.
    </p>

    <p
      v-if="candidates.length === 0"
      class="identity-panel__empty"
      data-testid="identity-no-candidates"
    >
      No mapped field pairing is available to key on yet. Accept or edit a field correspondence
      first.
    </p>

    <template v-else>
      <ul class="identity-panel__candidates">
        <li v-for="candidate in candidates" :key="candidate.id" class="identity-panel__candidate">
          <label>
            <input
              v-model="selectedItemId"
              type="radio"
              :value="candidate.id"
              :disabled="readonly"
              :data-testid="`identity-candidate-${candidate.id}`"
            />
            <code>{{ describeElementRef(candidate.sourceRef) }}</code>
            <span v-if="candidate.targetRef !== undefined">
              →
              <code>{{ describeElementRef(candidate.targetRef) }}</code>
            </span>
          </label>
          <Tag
            v-if="candidate.id === suggestedId"
            severity="info"
            value="suggested"
            :data-testid="`identity-suggested-${candidate.id}`"
          />
          <Tag
            v-if="!isRenameItem(candidate)"
            severity="warn"
            value="not a rename"
            :data-testid="`identity-nonrename-${candidate.id}`"
          />
        </li>
      </ul>

      <label class="identity-panel__lookup">
        Target lookup parameter (optional)
        <input
          v-model="targetLookupParamRef"
          type="text"
          :disabled="readonly"
          data-testid="identity-lookup-param"
        />
      </label>

      <p
        v-if="selectedItem !== undefined && !isRenameItem(selectedItem)"
        class="identity-panel__hint"
        data-testid="identity-rename-hint"
      >
        The selected pairing is not a <code>rename</code>. The server will reject it — only a
        value-preserving pairing can be an identity key.
      </p>

      <Message v-if="errorMessage !== null" severity="error" data-testid="identity-error">
        {{ errorMessage }}
      </Message>

      <Button
        v-if="!readonly"
        label="Confirm identity key & approve selection"
        :disabled="selectedItemId === '' || pending"
        data-testid="identity-confirm"
        @click="confirm"
      />
    </template>
  </section>
</template>

<style scoped>
.identity-panel {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.identity-panel__consequence {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.identity-panel__empty {
  margin: 0;
  font-style: italic;
  color: var(--p-text-muted-color, #64748b);
}

.identity-panel__candidates {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.identity-panel__candidate {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.identity-panel__lookup {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
  max-width: 24rem;
}

.identity-panel__hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #64748b);
}
</style>
