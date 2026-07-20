<script setup lang="ts">
import type { ParkedContainerLinkDto, ScopeLinkDto } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import {
  useLinkParkedContainer,
  useParkedContainerLinks,
  useUnlinkScopeLink,
} from "../composables/useScopeLinks.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * SS-15.5 — the container-linking screen (the container-level analog of SU-2 manual
 * linking). Lists the parked container-link queue (SS-11.5 / SS-12.4 / SS-17): each source
 * scope whose container could not be resolved to a `ScopeLink` — ambiguous (candidate
 * target ids present) or unresolvable (none) — with the candidate target containers. The
 * operator picks a candidate and links it (SS-11.6); a parked record/scope replays and
 * leaves the queue once its container is linked. Links established here can be severed.
 * Only ids + scope keys are shown — no credential material, no live payload value. A
 * viewer sees the queue read-only (OA-2).
 *
 * As with SU-2, there is no "list all ScopeLinks" endpoint, so unlink is offered for the
 * links established **in this session** (from the create response).
 */
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const parkedQuery = useParkedContainerLinks();
const parked = computed<ParkedContainerLinkDto[]>(() => parkedQuery.data.value?.parked ?? []);

const link = useLinkParkedContainer();
const unlink = useUnlinkScopeLink();

/** The operator's chosen candidate target native id per queue entry (keyed by `syncEventId`). */
const selectedTarget = ref<Record<string, string>>({});
/** `ScopeLink`s established in this session — the addressable set for unlink. */
const sessionLinks = ref<ScopeLinkDto[]>([]);
const actionError = ref<string | null>(null);

function describeScopeKey(scopeKey: Record<string, string>): string {
  return Object.entries(scopeKey)
    .map(([component, value]) => `${component}=${value}`)
    .join(", ");
}

function canLink(entry: ParkedContainerLinkDto): boolean {
  return !readonly.value && selectedTarget.value[entry.syncEventId] !== undefined;
}

function onLink(entry: ParkedContainerLinkDto): void {
  const targetNativeId = selectedTarget.value[entry.syncEventId];
  if (targetNativeId === undefined) {
    return;
  }
  actionError.value = null;
  link.mutate(
    { parked: entry, targetNativeId },
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
      sessionLinks.value = sessionLinks.value.filter((entry) => entry.id !== linkId);
    },
    onError: (error) => (actionError.value = error.message),
  });
}
</script>

<template>
  <main class="container-linking" data-testid="container-linking">
    <RouterLink to="/sync">← All sync rules</RouterLink>
    <h1>Container linking</h1>
    <p class="container-linking__hint">
      Containers the engine could not resolve to a <code>ScopeLink</code> — an identity match was
      ambiguous or found no counterpart (SS-11.5 / SS-17). Pick the correct target container to
      establish a <code>ScopeLink</code>; a parked record or scope replays once linked.
    </p>

    <Message v-if="readonly" severity="secondary" data-testid="container-readonly">
      You are signed in as a viewer — linking is read-only.
    </Message>

    <p v-if="parkedQuery.isPending.value" data-testid="container-loading">
      Loading parked container queue…
    </p>

    <Message v-else-if="parkedQuery.isError.value" severity="error" data-testid="container-error">
      Could not load the parked container queue: {{ parkedQuery.error.value?.message }}
    </Message>

    <p v-else-if="parked.length === 0" data-testid="parked-empty">
      The parked container-link queue is empty.
    </p>

    <ul v-else class="container-linking__queue">
      <li
        v-for="entry in parked"
        :key="entry.syncEventId"
        class="container-linking__entry"
        :data-testid="`parked-${entry.syncEventId}`"
      >
        <div class="container-linking__scope">
          <Tag
            :severity="entry.candidateTargetNativeIds.length > 0 ? 'warn' : 'danger'"
            :value="entry.candidateTargetNativeIds.length > 0 ? 'ambiguous' : 'unresolved'"
          />
          <span>
            Source scope <code>{{ describeScopeKey(entry.sourceScopeKey) }}</code> in app
            <code>{{ entry.sourceAppId }}</code>
          </span>
        </div>

        <p class="container-linking__candidates-label">Candidate target containers:</p>
        <p
          v-if="entry.candidateTargetNativeIds.length === 0"
          class="container-linking__hint"
          :data-testid="`container-no-candidates-${entry.syncEventId}`"
        >
          No candidate target container was recorded for this scope (unresolvable).
        </p>
        <div v-else class="container-linking__candidates">
          <label
            v-for="candidate in entry.candidateTargetNativeIds"
            :key="candidate"
            class="container-linking__candidate"
          >
            <input
              v-model="selectedTarget[entry.syncEventId]"
              type="radio"
              :value="candidate"
              :disabled="readonly"
              :data-testid="`container-candidate-${entry.syncEventId}-${candidate}`"
            />
            <code>{{ candidate }}</code>
          </label>
        </div>

        <Button
          v-if="!readonly"
          label="Link to selected container"
          :disabled="!canLink(entry) || link.isPending.value"
          :data-testid="`container-link-button-${entry.syncEventId}`"
          @click="onLink(entry)"
        />
      </li>
    </ul>

    <Message v-if="actionError !== null" severity="error" data-testid="container-action-error">
      {{ actionError }}
    </Message>

    <section
      v-if="!readonly && sessionLinks.length > 0"
      class="container-linking__session"
      data-testid="container-session-links"
    >
      <h2>Containers linked this session</h2>
      <ul class="container-linking__session-list">
        <li
          v-for="entry in sessionLinks"
          :key="entry.id"
          class="container-linking__session-item"
          :data-testid="`container-session-link-${entry.id}`"
        >
          <Tag
            :severity="entry.status === 'active' ? 'success' : 'secondary'"
            :value="entry.status"
          />
          <code>{{ entry.appAId }} ↔ {{ entry.appBId }}</code>
          <span class="container-linking__hint">(established {{ entry.establishedBy }})</span>
          <Button
            label="Unlink"
            severity="secondary"
            size="small"
            :disabled="unlink.isPending.value"
            :data-testid="`container-unlink-button-${entry.id}`"
            @click="onUnlink(entry.id)"
          />
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.container-linking {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.container-linking__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.container-linking__queue,
.container-linking__session-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.container-linking__entry {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  align-items: flex-start;
}

.container-linking__scope {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.container-linking__candidates {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.container-linking__candidate {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.container-linking__candidates-label {
  margin: 0;
  font-weight: 600;
}

.container-linking__session-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
