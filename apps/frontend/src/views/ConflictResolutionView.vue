<script setup lang="ts">
import type { ParkedConflictDto, ResolveParkedConflictRequest } from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import { useParkedConflicts, useResolveParkedConflict } from "../composables/useParkedConflicts.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * SU-3 — the conflict-resolution screen. Lists the parked-conflict queue (SA-4.1) with
 * the three kinds visibly distinct: a `manual-resolve` **field conflict** (choose a side)
 * and a `drifted-delete` (propagate or keep-the-survivor-and-sever) each **need a
 * decision**; a `withheld` field is an auto-resolved last-write-wins park that
 * self-reconciles through the counterpart direction and **needs no action** (a known
 * backend follow-up — the queue still surfaces it, so it is labelled clearly, not offered
 * a decision). A resolution re-runs through the normal pipeline (a field/propagate is
 * enqueued; a sever tombstones directly) — never a blind write (SA-4.2/4.3). Content
 * **hashes** only — no raw contested values, no credential material. A viewer is
 * read-only (OA-2).
 */
const auth = useAuthStore();
const readonly = computed<boolean>(() => !auth.isOperator);

const conflictsQuery = useParkedConflicts();
const conflicts = computed<ParkedConflictDto[]>(() => conflictsQuery.data.value?.conflicts ?? []);

const resolve = useResolveParkedConflict();
const actionError = ref<string | null>(null);
const outcomeMessage = ref<string | null>(null);

/** The operator's resolution choice (the SA-4 request's `resolution` values). */
type ResolutionChoice = ResolveParkedConflictRequest["resolution"];

/** A `withheld` park self-reconciles; the other two kinds need a human decision. */
function needsDecision(conflict: ParkedConflictDto): boolean {
  return conflict.kind === "manual-resolve" || conflict.kind === "drifted-delete";
}

function kindLabel(conflict: ParkedConflictDto): string {
  switch (conflict.kind) {
    case "manual-resolve":
      return "field conflict — needs a decision";
    case "drifted-delete":
      return "drifted delete (link still active) — needs a decision";
    case "withheld":
      return "withheld field (auto-resolved, self-reconciles) — no action needed";
  }
  return conflict.kind;
}

function onResolve(conflict: ParkedConflictDto, choice: ResolutionChoice): void {
  actionError.value = null;
  outcomeMessage.value = null;
  resolve.mutate(
    { id: conflict.id, request: { resolution: choice } },
    {
      onSuccess: (response) => {
        outcomeMessage.value =
          response.outcome === "enqueued"
            ? "Resolution enqueued — it re-runs through the normal pipeline (conflict + echo re-checked against current state), not a blind write."
            : "Link severed (tombstoned observed-delete) — the survivor is kept and nothing is deleted.";
      },
      onError: (error) => (actionError.value = error.message),
    },
  );
}
</script>

<template>
  <main class="conflicts" data-testid="conflict-resolution">
    <RouterLink to="/sync">← All sync rules</RouterLink>
    <h1>Conflict resolution</h1>
    <p class="conflicts__hint">
      Parked conflicts awaiting a decision. Resolving flows through the normal pipeline — it is
      never a blind write.
    </p>

    <Message v-if="readonly" severity="secondary" data-testid="conflict-readonly">
      You are signed in as a viewer — conflict resolution is read-only.
    </Message>

    <p v-if="conflictsQuery.isPending.value" data-testid="conflicts-loading">Loading conflicts…</p>

    <Message
      v-else-if="conflictsQuery.isError.value"
      severity="error"
      data-testid="conflicts-error"
    >
      Could not load parked conflicts: {{ conflictsQuery.error.value?.message }}
    </Message>

    <p v-else-if="conflicts.length === 0" data-testid="conflicts-empty">
      The parked-conflict queue is empty.
    </p>

    <ul v-else class="conflicts__queue">
      <li
        v-for="conflict in conflicts"
        :key="conflict.id"
        class="conflicts__entry"
        :data-testid="`conflict-${conflict.id}`"
      >
        <div class="conflicts__head">
          <Tag
            :severity="needsDecision(conflict) ? 'warn' : 'secondary'"
            :value="kindLabel(conflict)"
            :data-testid="`conflict-kind-${conflict.id}`"
          />
          <code v-if="conflict.fieldPath !== null">{{ conflict.fieldPath }}</code>
          <span class="conflicts__muted">side {{ conflict.side }}</span>
        </div>

        <dl class="conflicts__meta">
          <dt>Record link</dt>
          <dd>
            <code>{{ conflict.recordLinkId }}</code>
          </dd>
          <dt>Source record</dt>
          <dd>
            <code>{{ conflict.sourceNativeId ?? "—" }}</code>
          </dd>
          <dt>Source hash</dt>
          <dd>
            <code>{{ conflict.sourceObservedHash ?? "—" }}</code>
          </dd>
          <dt>Target hash</dt>
          <dd>
            <code>{{ conflict.targetObservedHash ?? "—" }}</code>
          </dd>
        </dl>

        <!-- withheld: auto-LWW, self-reconciles — no decision offered (SU-3 note). -->
        <p
          v-if="!needsDecision(conflict)"
          class="conflicts__no-action"
          :data-testid="`conflict-no-action-${conflict.id}`"
        >
          No action needed — this field was auto-resolved (last-write-wins) and reconciles through
          the counterpart direction.
        </p>

        <!-- manual-resolve field conflict: choose a side (SU-3.2). -->
        <div
          v-else-if="conflict.kind === 'manual-resolve' && !readonly"
          class="conflicts__actions"
          :data-testid="`conflict-field-actions-${conflict.id}`"
        >
          <Button
            label="Source wins"
            :disabled="resolve.isPending.value"
            :data-testid="`resolve-source-wins-${conflict.id}`"
            @click="onResolve(conflict, 'source-wins')"
          />
          <Button
            label="Target wins"
            severity="secondary"
            :disabled="resolve.isPending.value"
            :data-testid="`resolve-target-wins-${conflict.id}`"
            @click="onResolve(conflict, 'target-wins')"
          />
        </div>

        <!-- drifted-delete: exactly the two CF-7 outcomes (SU-3.3). -->
        <div
          v-else-if="conflict.kind === 'drifted-delete' && !readonly"
          class="conflicts__actions"
          :data-testid="`conflict-delete-actions-${conflict.id}`"
        >
          <Button
            label="Propagate the deletion"
            severity="danger"
            :disabled="resolve.isPending.value"
            :data-testid="`resolve-propagate-${conflict.id}`"
            @click="onResolve(conflict, 'propagate')"
          />
          <Button
            label="Keep survivor & sever"
            severity="secondary"
            :disabled="resolve.isPending.value"
            :data-testid="`resolve-sever-${conflict.id}`"
            @click="onResolve(conflict, 'sever')"
          />
        </div>
      </li>
    </ul>

    <Message v-if="actionError !== null" severity="error" data-testid="conflict-action-error">
      {{ actionError }}
    </Message>

    <Message v-if="outcomeMessage !== null" severity="success" data-testid="resolve-outcome">
      {{ outcomeMessage }}
    </Message>
  </main>
</template>

<style scoped>
.conflicts {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.conflicts__hint {
  color: var(--p-text-muted-color, #64748b);
  margin: 0;
}

.conflicts__queue {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.conflicts__entry {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.conflicts__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.conflicts__muted {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
}

.conflicts__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.2rem 1rem;
  margin: 0;
  font-size: 0.85rem;
}

.conflicts__meta dt {
  font-weight: 600;
}

.conflicts__meta dd {
  margin: 0;
  word-break: break-all;
}

.conflicts__no-action {
  color: var(--p-text-muted-color, #64748b);
  font-style: italic;
  margin: 0;
}

.conflicts__actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
