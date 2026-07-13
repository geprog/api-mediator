<script setup lang="ts">
import type { AmbiguousMatchDto, RecordLinkDto } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import {
  useAmbiguousMatches,
  useCreateRecordLink,
  useUnlinkRecord,
} from "../composables/useRecordLinks.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * SU-2 — the manual-linking screen. Lists the ambiguous-match queue (SA-3.3): each
 * unresolved source record with the candidate target native ids the engine refused to
 * pick between (RL-4). The operator picks a target and links it (SA-3.1), which drops
 * the record from the queue; links established here can be severed (SA-3.2). Only
 * identifying **ids** are shown — no credential material, no live payload values
 * (SA-3.5). A viewer sees the queue read-only (OA-2).
 *
 * There is no "list all RecordLinks" endpoint in SA-3, so unlink is offered for the
 * links established **in this session** (from the create response) — the set the screen
 * can address safely without a live-value read.
 */
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const matchesQuery = useAmbiguousMatches();
const matches = computed<AmbiguousMatchDto[]>(() => matchesQuery.data.value?.matches ?? []);

const createLink = useCreateRecordLink();
const unlink = useUnlinkRecord();

/** The operator's chosen target native id per queue entry (keyed by its `syncEventId`). */
const selectedTarget = ref<Record<string, string>>({});
/** Links established in this session — the addressable set for unlink (SA-3.2). */
const sessionLinks = ref<RecordLinkDto[]>([]);
const actionError = ref<string | null>(null);

function canLink(match: AmbiguousMatchDto): boolean {
  return (
    !readonly.value &&
    match.ruleId !== null &&
    match.sourceNativeId !== null &&
    selectedTarget.value[match.syncEventId] !== undefined
  );
}

function onLink(match: AmbiguousMatchDto): void {
  const targetNativeId = selectedTarget.value[match.syncEventId];
  if (match.ruleId === null || match.sourceNativeId === null || targetNativeId === undefined) {
    return;
  }
  actionError.value = null;
  createLink.mutate(
    { ruleId: match.ruleId, sourceNativeId: match.sourceNativeId, targetNativeId },
    {
      onSuccess: (response) => sessionLinks.value.push(response.link),
      onError: (error) => (actionError.value = error.message),
    },
  );
}

function onUnlink(linkId: string): void {
  actionError.value = null;
  unlink.mutate(linkId, {
    onSuccess: () => {
      sessionLinks.value = sessionLinks.value.filter((link) => link.id !== linkId);
    },
    onError: (error) => (actionError.value = error.message),
  });
}
</script>

<template>
  <main class="manual-linking" data-testid="manual-linking">
    <RouterLink to="/sync">← All sync rules</RouterLink>
    <h1>Manual linking</h1>
    <p class="manual-linking__hint">
      Records the engine refused to link automatically — an identity lookup matched more than one
      target (RL-4). Pick the correct target to establish a <code>RecordLink</code>.
    </p>

    <Message v-if="readonly" severity="secondary" data-testid="manual-readonly">
      You are signed in as a viewer — linking is read-only.
    </Message>

    <p v-if="matchesQuery.isPending.value" data-testid="manual-loading">Loading ambiguous queue…</p>

    <Message v-else-if="matchesQuery.isError.value" severity="error" data-testid="manual-error">
      Could not load the ambiguous queue: {{ matchesQuery.error.value?.message }}
    </Message>

    <p v-else-if="matches.length === 0" data-testid="ambiguous-empty">
      The ambiguous-match queue is empty.
    </p>

    <ul v-else class="manual-linking__queue">
      <li
        v-for="match in matches"
        :key="match.syncEventId"
        class="manual-linking__entry"
        :data-testid="`ambiguous-${match.syncEventId}`"
      >
        <div class="manual-linking__record">
          <Tag severity="warn" value="ambiguous" />
          <span>
            Source record <code>{{ match.sourceNativeId ?? "—" }}</code>
            <span v-if="match.sourceAppId !== null">
              in app <code>{{ match.sourceAppId }}</code></span
            >
          </span>
        </div>

        <p class="manual-linking__candidates-label">Candidate target ids:</p>
        <p
          v-if="match.candidateTargetNativeIds.length === 0"
          class="manual-linking__hint"
          :data-testid="`ambiguous-no-candidates-${match.syncEventId}`"
        >
          No candidate ids were recorded for this match.
        </p>
        <div v-else class="manual-linking__candidates">
          <label
            v-for="candidate in match.candidateTargetNativeIds"
            :key="candidate"
            class="manual-linking__candidate"
          >
            <input
              v-model="selectedTarget[match.syncEventId]"
              type="radio"
              :value="candidate"
              :disabled="readonly"
              :data-testid="`candidate-${match.syncEventId}-${candidate}`"
            />
            <code>{{ candidate }}</code>
          </label>
        </div>

        <p
          v-if="match.ruleId === null || match.sourceNativeId === null"
          class="manual-linking__hint"
          :data-testid="`ambiguous-unlinkable-${match.syncEventId}`"
        >
          This entry lacks the rule/record context needed to link it here.
        </p>

        <Button
          v-if="!readonly"
          label="Link to selected target"
          :disabled="!canLink(match) || createLink.isPending.value"
          :data-testid="`link-button-${match.syncEventId}`"
          @click="onLink(match)"
        />
      </li>
    </ul>

    <Message v-if="actionError !== null" severity="error" data-testid="manual-action-error">
      {{ actionError }}
    </Message>

    <section
      v-if="!readonly && sessionLinks.length > 0"
      class="manual-linking__session"
      data-testid="session-links"
    >
      <h2>Links established this session</h2>
      <ul class="manual-linking__session-list">
        <li
          v-for="link in sessionLinks"
          :key="link.id"
          class="manual-linking__session-item"
          :data-testid="`session-link-${link.id}`"
        >
          <Tag
            :severity="link.status === 'active' ? 'success' : 'secondary'"
            :value="link.status"
          />
          <code>{{ link.appANativeId }} ↔ {{ link.appBNativeId }}</code>
          <span class="manual-linking__hint">(established {{ link.establishedBy }})</span>
          <Button
            label="Unlink"
            severity="secondary"
            size="small"
            :disabled="unlink.isPending.value"
            :data-testid="`unlink-button-${link.id}`"
            @click="onUnlink(link.id)"
          />
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.manual-linking {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.manual-linking__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.manual-linking__queue,
.manual-linking__session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.manual-linking__entry {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
}

.manual-linking__record {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.manual-linking__candidates {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.manual-linking__candidate {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.manual-linking__candidates-label {
  margin: 0;
  font-weight: 600;
}

.manual-linking__session-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
