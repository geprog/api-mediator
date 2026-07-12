<script setup lang="ts">
import type {
  ApproveProposalResponse,
  IdentityKeyConfirmationDto,
  MappingProposalItemDto,
} from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";

import IdentityKeyPanel from "../components/mapping-review/IdentityKeyPanel.vue";
import NoCounterpartPanel from "../components/mapping-review/NoCounterpartPanel.vue";
import ProposalItemCard from "../components/mapping-review/ProposalItemCard.vue";
import { deriveProposalVariant } from "../components/mapping-review/proposal-model.js";
import {
  useApproveProposal,
  useConfirmIdentityKey,
  useProposalDetail,
} from "../composables/useMappingProposals.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * The proposal review screen (RU-1 render + RU-4 identity confirm / approve). Items
 * render in the **API's** confidence order (never re-sorted); a `failed` proposal
 * renders as needs-attention rather than an empty list; the identity-key panel
 * appears only for a peer-peer proposal; and the approve action reflects
 * `partially_approved` / `approved` with the Phase-4 enablement-gate caveat when a
 * peer-peer mapping is approved without a confirmed identity key. A `viewer` sees
 * everything read-only (no mutation controls).
 */
const route = useRoute();
const auth = useAuthStore();

const proposalId = computed<string>(() => {
  const raw = route.params["id"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});

const readonly = computed<boolean>(() => !auth.isOperator);

const detailQuery = useProposalDetail(proposalId);
const items = computed<MappingProposalItemDto[]>(() => detailQuery.data.value?.items ?? []);
const variant = computed(() => deriveProposalVariant(items.value));
const isFailed = computed<boolean>(() => detailQuery.data.value?.proposal.status === "failed");
const decidedCount = computed<number>(
  () =>
    items.value.filter((item) => item.reviewState === "accepted" || item.reviewState === "edited")
      .length,
);

const approve = useApproveProposal(proposalId);
const confirmIdentity = useConfirmIdentityKey(proposalId);

/** The last approval-producing action + whether it carried an identity key. */
const outcome = ref<{ response: ApproveProposalResponse; viaIdentityKey: boolean } | null>(null);

function doApprove(): void {
  approve.mutate(
    {},
    { onSuccess: (response) => (outcome.value = { response, viaIdentityKey: false }) },
  );
}

function onConfirmIdentity(confirmation: IdentityKeyConfirmationDto): void {
  confirmIdentity.mutate(confirmation, {
    onSuccess: (response) => (outcome.value = { response, viaIdentityKey: true }),
  });
}

const outcomeSeverity = computed<"success" | "warn">(() =>
  outcome.value?.response.outcome === "rejected" ? "warn" : "success",
);

/**
 * The approval-result message (RU-4 crit 5/6). A peer-peer approval without a
 * confirmed identity key must communicate the Phase-4 enablement gate and must not
 * imply the mapping is running.
 */
const outcomeMessage = computed<string | null>(() => {
  const current = outcome.value;
  if (current === null) {
    return null;
  }
  const response = current.response;
  if (response.outcome === "rejected") {
    return "All items were rejected — no ApprovedMapping was created.";
  }
  const statusText =
    response.outcome === "approved"
      ? "Approved."
      : "Partially approved — undecided items remain reviewable.";
  if (response.mapping?.variant === "consumer-provider") {
    return `${statusText} The adapter bindings are instantiated disabled — nothing is running yet.`;
  }
  if (current.viaIdentityKey) {
    return `${statusText} Identity key confirmed; the SyncRule can be enabled once the remaining Phase-4 gates are met. Nothing is running yet.`;
  }
  return `${statusText} The mapping is approved, but its SyncRule cannot be enabled until an identity key is confirmed (a Phase-4 gate). Nothing is running yet.`;
});
</script>

<template>
  <main class="review">
    <RouterLink to="/proposals">← All proposals</RouterLink>

    <p v-if="detailQuery.isPending.value" data-testid="review-loading">Loading proposal…</p>

    <Message v-else-if="detailQuery.isError.value" severity="error" data-testid="review-error">
      Could not load the proposal: {{ detailQuery.error.value?.message }}
    </Message>

    <template v-else-if="detailQuery.data.value !== undefined">
      <header class="review__header">
        <h1>Mapping proposal</h1>
        <div class="review__meta">
          <Tag
            :severity="isFailed ? 'danger' : 'info'"
            :value="detailQuery.data.value.proposal.status"
            data-testid="review-status"
          />
          <code
            >{{ detailQuery.data.value.proposal.sourceSpecId }} →
            {{ detailQuery.data.value.proposal.targetSpecId }}</code
          >
          <span class="review__muted">
            {{ detailQuery.data.value.proposal.generatedBy.providerId }} /
            {{ detailQuery.data.value.proposal.generatedBy.model }} ·
            {{ detailQuery.data.value.proposal.createdAt }}
          </span>
        </div>
      </header>

      <Message v-if="readonly" severity="secondary" data-testid="review-readonly">
        You are signed in as a viewer — this screen is read-only.
      </Message>

      <!-- Failed proposal: needs attention, not an empty success (RU-1 crit 3). -->
      <Message v-if="isFailed" severity="error" data-testid="review-failed">
        This proposal failed at stage 1 — the whole spec-pair shortlist could not be produced. There
        are no items to review; this needs attention.
      </Message>

      <!-- Items in the API's confidence order (RU-1 crit 1/2). -->
      <section v-if="!isFailed" class="review__items" data-testid="review-items">
        <h2>Items ({{ items.length }})</h2>
        <p v-if="items.length === 0" data-testid="review-items-empty">
          This proposal has no reviewable items.
        </p>
        <ProposalItemCard
          v-for="item in items"
          :key="item.id"
          :item="item"
          :proposal-id="proposalId"
          :readonly="readonly"
        />
      </section>

      <!-- Identity-key panel — peer-peer only (RU-4 crit 1-4). -->
      <IdentityKeyPanel
        v-if="!isFailed && variant === 'peer-peer'"
        :items="items"
        :readonly="readonly"
        :pending="confirmIdentity.isPending.value"
        :error-message="confirmIdentity.error.value?.message ?? null"
        @confirm="onConfirmIdentity"
      />

      <!-- Shortlist context: no-counterpart escape hatch + excluded (RU-3). -->
      <NoCounterpartPanel
        :proposal-id="proposalId"
        :source-spec-id="detailQuery.data.value.proposal.sourceSpecId"
        :target-spec-id="detailQuery.data.value.proposal.targetSpecId"
        :shortlist="detailQuery.data.value.shortlist"
        :analysis-exclusions="detailQuery.data.value.analysisExclusions"
        :readonly="readonly"
      />

      <!-- Approve the decided selection (RU-4 crit 5/6). -->
      <section v-if="!readonly && !isFailed" class="review__approve" data-testid="review-approve">
        <h2>Approve</h2>
        <p class="review__muted">
          {{ decidedCount }} item(s) decided (accepted or edited) will be assembled into the
          ApprovedMapping. Undecided items stay reviewable.
        </p>

        <Message v-if="approve.isError.value" severity="error" data-testid="approve-error">
          {{ approve.error.value?.message }}
        </Message>

        <Message
          v-if="outcomeMessage !== null"
          :severity="outcomeSeverity"
          data-testid="approve-outcome"
        >
          {{ outcomeMessage }}
        </Message>

        <Button
          label="Approve decided selection"
          :disabled="approve.isPending.value"
          data-testid="approve-button"
          @click="doApprove"
        />
      </section>
    </template>
  </main>
</template>

<style scoped>
.review {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.review__header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.review__meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.review__muted {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.review__items {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.review__approve {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}
</style>
