<script setup lang="ts">
import type { MappingProposalItemDto } from "@mediator/contracts";
import Button from "primevue/button";
import Card from "primevue/card";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";

import { useDecideProposalItem } from "../../composables/useMappingProposals.js";
import {
  buildEditRequest,
  describeElementRef,
  formatConfidence,
  initialEditDraft,
  isEditDraftComplete,
  TRANSFORM_KINDS,
  type ItemEditDraft,
} from "./proposal-model.js";

/**
 * One `MappingProposalItem` (RU-1 crit 2 + RU-2). Renders its `kind`, `sourceRef`,
 * `targetRef` (or a distinct `unmapped` treatment), `confidenceScore`, `rationale`,
 * `reviewRequired` flag and `reviewState`, and — for an `operator` — the inline
 * accept / edit / reject controls, the `ambiguousAlternatives` choice, and the
 * unmapped supply-a-target / accept-unmapped choice. A `viewer` (`readonly`) sees
 * the same information with no mutation controls. Every decision goes through RA-2;
 * a server-side edit-validation error is shown against the form without clearing
 * the entered draft (the draft is local state, untouched by the error).
 */
const props = defineProps<{
  item: MappingProposalItemDto;
  proposalId: string;
  readonly: boolean;
}>();

const decide = useDecideProposalItem(() => props.proposalId);

const editing = ref<boolean>(false);
const draft = ref<ItemEditDraft>(initialEditDraft(props.item));

const stateSeverity = computed<"success" | "info" | "danger" | "secondary">(() => {
  switch (props.item.reviewState) {
    case "accepted":
      return "success";
    case "edited":
      return "info";
    case "rejected":
      return "danger";
    case "pending":
      return "secondary";
  }
  return "secondary";
});

const isRejected = computed<boolean>(() => props.item.reviewState === "rejected");
const canMutate = computed<boolean>(() => !props.readonly && !isRejected.value);
const editComplete = computed<boolean>(() => isEditDraftComplete(draft.value));

function startEdit(): void {
  draft.value = initialEditDraft(props.item);
  decide.reset();
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
}

function accept(): void {
  decide.mutate({ itemId: props.item.id, request: { decision: "accept" } });
}

function reject(): void {
  decide.mutate({ itemId: props.item.id, request: { decision: "reject" } });
}

function saveEdit(): void {
  decide.mutate(
    { itemId: props.item.id, request: buildEditRequest(draft.value) },
    { onSuccess: () => (editing.value = false) },
  );
}

/** Pick an ambiguous alternative — an `edited` decision with that target (RU-2 crit 2). */
function useAlternative(index: number): void {
  const alternative = props.item.ambiguousAlternatives[index];
  if (alternative === undefined) {
    return;
  }
  decide.mutate({
    itemId: props.item.id,
    request: { decision: "edit", targetRef: alternative.targetRef },
  });
}
</script>

<template>
  <Card class="item-card" :data-testid="`item-card-${item.id}`">
    <template #title>
      <div class="item-card__head">
        <Tag severity="secondary" :value="item.kind" data-testid="item-kind" />
        <Tag
          v-if="item.reviewRequired"
          severity="warn"
          value="review required"
          data-testid="item-review-required"
        />
        <Tag
          :severity="stateSeverity"
          :value="item.reviewState"
          data-testid="item-state"
          class="item-card__state"
        />
        <span class="item-card__confidence" data-testid="item-confidence">
          confidence {{ formatConfidence(item.confidenceScore) }}
        </span>
      </div>
    </template>

    <template #content>
      <dl class="item-card__refs">
        <dt>Source</dt>
        <dd>
          <code>{{ describeElementRef(item.sourceRef) }}</code>
        </dd>
        <dt>Target</dt>
        <dd v-if="item.unmapped" data-testid="item-unmapped" class="item-card__unmapped">
          Unmapped — no counterpart. Needs a manual mapping or an intentional unmapped decision.
        </dd>
        <dd v-else-if="item.targetRef !== undefined">
          <code>{{ describeElementRef(item.targetRef) }}</code>
        </dd>
        <dd v-else class="item-card__unmapped">—</dd>
      </dl>

      <p class="item-card__rationale" data-testid="item-rationale">{{ item.rationale }}</p>

      <!-- Ambiguous alternatives — presented as an explicit choice (RU-2 crit 2). -->
      <div
        v-if="item.ambiguousAlternatives.length > 0"
        class="item-card__alternatives"
        data-testid="item-alternatives"
      >
        <p class="item-card__alt-label">Alternatives (pick one to record an edit):</p>
        <div
          v-for="(alternative, index) in item.ambiguousAlternatives"
          :key="index"
          class="item-card__alt-row"
        >
          <code>{{ describeElementRef(alternative.targetRef) }}</code>
          <span class="item-card__alt-confidence">{{
            formatConfidence(alternative.confidence)
          }}</span>
          <Button
            v-if="canMutate"
            size="small"
            severity="secondary"
            label="Use this option"
            :disabled="decide.isPending.value"
            :data-testid="`item-alternative-${index}`"
            @click="useAlternative(index)"
          />
        </div>
      </div>

      <p v-if="isRejected" class="item-card__permanent" data-testid="item-rejected-permanent">
        Rejected — permanent. This correspondence will not be re-suggested by future analyses unless
        the underlying elements change.
      </p>

      <!-- Decision error (surfaced against the item; edit draft is preserved). -->
      <Message
        v-if="decide.isError.value && !editing"
        severity="error"
        data-testid="item-decision-error"
      >
        {{ decide.error.value?.message }}
      </Message>

      <div v-if="canMutate && !editing" class="item-card__actions">
        <template v-if="item.unmapped">
          <Button
            size="small"
            label="Accept as unmapped"
            :disabled="decide.isPending.value"
            data-testid="item-accept-unmapped"
            @click="accept"
          />
          <Button
            size="small"
            severity="secondary"
            label="Supply a target"
            data-testid="item-supply-target"
            @click="startEdit"
          />
        </template>
        <template v-else>
          <Button
            size="small"
            label="Accept"
            :disabled="decide.isPending.value"
            data-testid="item-accept"
            @click="accept"
          />
          <Button
            size="small"
            severity="secondary"
            label="Edit"
            data-testid="item-edit"
            @click="startEdit"
          />
          <Button
            size="small"
            severity="danger"
            label="Reject"
            :disabled="decide.isPending.value"
            data-testid="item-reject"
            @click="reject"
          />
        </template>
      </div>

      <!-- Inline edit form (RU-2 crit 3/5). -->
      <div v-if="editing" class="item-card__edit" data-testid="item-edit-form">
        <label class="item-card__field">
          Target resource
          <input v-model="draft.resourceRef" type="text" data-testid="item-edit-resource" />
        </label>

        <label v-if="draft.kind === 'field'" class="item-card__field">
          Target field path
          <input v-model="draft.path" type="text" data-testid="item-edit-path" />
        </label>

        <template v-if="draft.kind === 'operation'">
          <label class="item-card__field">
            Target operation id
            <input v-model="draft.operationId" type="text" data-testid="item-edit-operation" />
          </label>
        </template>

        <template v-if="draft.kind === 'parameter'">
          <label class="item-card__field">
            Target operation id
            <input v-model="draft.operationId" type="text" data-testid="item-edit-operation" />
          </label>
          <label class="item-card__field">
            Target parameter
            <input v-model="draft.parameter" type="text" data-testid="item-edit-parameter" />
          </label>
        </template>

        <template v-if="draft.kind === 'field' || draft.kind === 'parameter'">
          <label class="item-card__field">
            Transform
            <select v-model="draft.transform" data-testid="item-edit-transform">
              <option v-for="kind in TRANSFORM_KINDS" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </label>
          <label class="item-card__field">
            Transform detail
            <input
              v-model="draft.transformDetail"
              type="text"
              data-testid="item-edit-transform-detail"
            />
          </label>
        </template>

        <Message v-if="decide.isError.value" severity="error" data-testid="item-edit-error">
          {{ decide.error.value?.message }}
        </Message>

        <div class="item-card__actions">
          <Button
            size="small"
            label="Save edit"
            :disabled="!editComplete || decide.isPending.value"
            data-testid="item-save-edit"
            @click="saveEdit"
          />
          <Button
            size="small"
            severity="secondary"
            label="Cancel"
            data-testid="item-cancel-edit"
            @click="cancelEdit"
          />
        </div>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.item-card {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
}

.item-card__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.item-card__state {
  margin-left: auto;
}

.item-card__confidence {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.item-card__refs {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0 0 0.5rem;
}

.item-card__refs dt {
  font-weight: 600;
}

.item-card__refs dd {
  margin: 0;
}

.item-card__unmapped {
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
}

.item-card__rationale {
  margin: 0 0 0.5rem;
}

.item-card__alternatives {
  margin: 0 0 0.5rem;
  padding: 0.5rem;
  border: 1px dashed var(--p-content-border-color, #e2e8f0);
  border-radius: 4px;
}

.item-card__alt-label {
  margin: 0 0 0.35rem;
  font-weight: 600;
}

.item-card__alt-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.item-card__alt-confidence {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.item-card__permanent {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0 0 0.5rem;
}

.item-card__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.item-card__edit {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.item-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}
</style>
