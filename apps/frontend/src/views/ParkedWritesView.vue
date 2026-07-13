<script setup lang="ts">
import type { DeadLetterWriteDto } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import { useDeadLetterWrites, useReplayParkedWrite } from "../composables/useDeadLetterWrites.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * SU-4 — the parked / dead-letter replay screen. Lists writes that exhausted their
 * retry ceiling (SA-5.1) with their record/rule context and the non-secret failure
 * reason. A **superseded** entry — a later same-key change already synced the record —
 * needs no action, so its replay is disabled (SA-5.3). Replaying **reactivates** the
 * entry so the dispatcher re-runs the standard pipeline against **current** state
 * (loop-prevention + conflict re-checks) — never a stale re-issue (SA-5.2). No payload
 * value, no credential material. A viewer is read-only (OA-2).
 */
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const writesQuery = useDeadLetterWrites();
const writes = computed<DeadLetterWriteDto[]>(() => writesQuery.data.value?.writes ?? []);

const replay = useReplayParkedWrite();
const actionError = ref<string | null>(null);
const outcomeMessage = ref<string | null>(null);

function onReplay(write: DeadLetterWriteDto): void {
  if (write.superseded) {
    return;
  }
  actionError.value = null;
  outcomeMessage.value = null;
  replay.mutate(write.id, {
    onSuccess: () => {
      outcomeMessage.value =
        "Reactivated — the replay re-runs the standard pipeline against current state (loop prevention + conflict detection), not a stale re-issue.";
    },
    onError: (error) => (actionError.value = error.message),
  });
}
</script>

<template>
  <main class="parked-writes" data-testid="parked-writes">
    <RouterLink to="/sync">← All sync rules</RouterLink>
    <h1>Parked writes</h1>
    <p class="parked-writes__hint">
      Writes that exhausted their retry ceiling and were dead-lettered. A later successful sync of
      the same record supersedes a parked write automatically; replay is only for a record with no
      later change.
    </p>

    <Message v-if="readonly" severity="secondary" data-testid="parked-readonly">
      You are signed in as a viewer — replay is read-only.
    </Message>

    <p v-if="writesQuery.isPending.value" data-testid="parked-loading">Loading parked writes…</p>

    <Message v-else-if="writesQuery.isError.value" severity="error" data-testid="parked-error">
      Could not load the dead-letter queue: {{ writesQuery.error.value?.message }}
    </Message>

    <p v-else-if="writes.length === 0" data-testid="dead-letter-empty">
      The dead-letter queue is empty.
    </p>

    <ul v-else class="parked-writes__queue">
      <li
        v-for="write in writes"
        :key="write.id"
        class="parked-writes__entry"
        :data-testid="`dead-letter-${write.id}`"
      >
        <div class="parked-writes__head">
          <Tag v-if="write.changeKind !== null" severity="info" :value="write.changeKind" />
          <Tag
            v-if="write.superseded"
            severity="secondary"
            value="superseded — no action needed"
            :data-testid="`superseded-${write.id}`"
          />
          <Tag v-else severity="danger" :value="`${write.attempts} attempts`" />
        </div>

        <dl class="parked-writes__meta">
          <dt>Source record</dt>
          <dd>
            <code>{{ write.sourceNativeId ?? "—" }}</code>
          </dd>
          <dt>Resource pair</dt>
          <dd>
            <code>{{ write.resourcePairRef ?? "—" }}</code>
          </dd>
          <dt>Rule</dt>
          <dd>
            <code>{{ write.ruleId ?? "—" }}</code>
          </dd>
          <dt>Last error</dt>
          <dd>{{ write.lastError ?? "—" }}</dd>
          <dt>Parked at</dt>
          <dd>{{ write.parkedAt ?? "—" }}</dd>
        </dl>

        <p
          v-if="write.superseded"
          class="parked-writes__no-action"
          :data-testid="`superseded-note-${write.id}`"
        >
          A later same-key change already synced this record — replay would be a no-op.
        </p>

        <Button
          v-if="!readonly"
          label="Replay"
          :disabled="write.superseded || replay.isPending.value"
          :data-testid="`replay-button-${write.id}`"
          @click="onReplay(write)"
        />
      </li>
    </ul>

    <Message v-if="actionError !== null" severity="error" data-testid="parked-action-error">
      {{ actionError }}
    </Message>

    <Message v-if="outcomeMessage !== null" severity="success" data-testid="replay-outcome">
      {{ outcomeMessage }}
    </Message>
  </main>
</template>

<style scoped>
.parked-writes {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.parked-writes__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.parked-writes__queue {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.parked-writes__entry {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}

.parked-writes__head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.parked-writes__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 1rem;
  margin: 0;
  font-size: 0.85rem;
}

.parked-writes__meta dt {
  font-weight: 600;
}

.parked-writes__meta dd {
  margin: 0;
  word-break: break-all;
}

.parked-writes__no-action {
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
  margin: 0;
}
</style>
