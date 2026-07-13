<script setup lang="ts">
import type {
  ConfigureSyncRuleRequest,
  EnableSyncRuleRequest,
  EnableSyncRuleResponse,
  SyncRuleStatusDto,
} from "@mediator/contracts";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";

import {
  canEnable,
  derivePollingState,
  enablementChecklist,
  hasNeitherLookupPath,
  isPushBlockedByCounterpart,
  toEnableRequest,
  type BackfillChoice,
} from "./enablement-model.js";

/**
 * The SU-1 rule-enablement panel (with SU-5 folded in — they share the panel). It is
 * **thin**: it renders the API's `stillNeeds` gate as a checklist, offers the backfill
 * choice, surfaces the degradations/one-way warnings, and never lets a viewer or a
 * gate-unmet/identity-key-unconfirmed rule be enabled. Every invariant is the server's
 * (BE-1/BE-2, OA-2); this only keeps the affordances honest.
 *
 * Presentational: the owning view holds the SA-1 mutations and passes state in; the
 * panel emits the operator's intent (`enable`/`disable`/`configure`).
 */
const props = defineProps<{
  rule: SyncRuleStatusDto;
  /** The counterpart direction (same `resourcePairRef`), or `null` when the rule is one-way. */
  counterpart: SyncRuleStatusDto | null;
  readonly: boolean;
  /** A SA-1 mutation is in flight (disables the actions). */
  pending: boolean;
  /** The last SA-1 mutation error, if any. */
  errorMessage: string | null;
  /** The last accepted enable result (SU-1.5 outcome). */
  enableResult: EnableSyncRuleResponse | null;
}>();

const emit = defineEmits<{
  enable: [request: EnableSyncRuleRequest];
  disable: [];
  configure: [request: ConfigureSyncRuleRequest];
}>();

const isDisabledRule = computed<boolean>(() => props.rule.status === "disabled");
const isOneWay = computed<boolean>(() => props.counterpart === null);
const neitherLookupPath = computed<boolean>(() => hasNeitherLookupPath(props.rule.stillNeeds));
const pushBlocked = computed<boolean>(() => isPushBlockedByCounterpart(props.counterpart));

const checklist = computed(() =>
  enablementChecklist(props.rule.stillNeeds, props.rule.resourcePair),
);

const pollingState = computed(() => derivePollingState(props.rule));
const pollingLabel = computed<string>(() => {
  switch (pollingState.value) {
    case "disabled":
      return "disabled";
    case "backfill-running":
      return "enabled — backfill running, not yet polling";
    case "polling":
      return "enabled — polling";
  }
  return "disabled";
});

// SU-1.2 — the backfill choice is explicit; there is NEVER a preselected default.
const backfillChoice = ref<BackfillChoice | null>(null);

const targetDriftCheckOn = computed<boolean>(
  () => props.rule.targetDriftCheck === "read-before-write",
);

const enableAllowed = computed<boolean>(() =>
  canEnable({
    stillNeeds: props.rule.stillNeeds,
    choice: backfillChoice.value,
    pushBlocked: pushBlocked.value,
  }),
);

function onEnable(): void {
  if (backfillChoice.value === null || !enableAllowed.value) {
    return;
  }
  emit("enable", toEnableRequest(backfillChoice.value));
}

function onDisable(): void {
  emit("disable");
}

function onToggleTargetDriftCheck(event: Event): void {
  const checked = (event.target as HTMLInputElement).checked;
  emit("configure", { targetDriftCheck: checked ? "read-before-write" : "none" });
}

/** SU-1.5 — the accepted-enable outcome text (never implies polling while backfilling). */
const enableOutcomeMessage = computed<string | null>(() => {
  const result = props.enableResult;
  if (result === null || result.outcome !== "accepted") {
    return null;
  }
  return result.backfillRequired
    ? "Enabled. The initial backfill is running — this rule is not polling yet; polling begins once the backfill completes."
    : "Enabled. Backfill was skipped — polling begins on the next cycle.";
});

const enableDegradationMessages = computed<string[]>(() => {
  const result = props.enableResult;
  if (result === null || result.outcome !== "accepted") {
    return [];
  }
  return result.degradations.map((degradation) =>
    degradation.kind === "match-first-unavailable"
      ? "Match-first is unavailable (no identity-lookup path) — pre-existing records may be duplicated."
      : `Change timestamps unavailable on the ${degradation.side} side — conflict resolution falls back to observation order (CF-2).`,
  );
});
</script>

<template>
  <section class="enablement" data-testid="rule-enablement-panel">
    <header class="enablement__header">
      <h2>Enable sync rule</h2>
      <div class="enablement__meta">
        <Tag
          :severity="rule.status === 'enabled' ? 'success' : 'secondary'"
          :value="rule.status"
          data-testid="rule-status"
        />
        <Tag
          :severity="pollingState === 'polling' ? 'success' : 'warn'"
          :value="pollingLabel"
          data-testid="rule-polling-state"
        />
        <code v-if="rule.resourcePair !== null">
          {{ rule.resourcePair.source.appName }} ({{ rule.resourcePair.source.resourceRef }}) →
          {{ rule.resourcePair.target.appName }} ({{ rule.resourcePair.target.resourceRef }})
        </code>
        <code v-else>{{ rule.resourcePairRef }}</code>
      </div>
    </header>

    <Message v-if="readonly" severity="secondary" data-testid="rule-readonly">
      You are signed in as a viewer — this panel is read-only.
    </Message>

    <!-- SU-1.1 / SU-5.1: the enablement gate as a checklist, driven by the API's stillNeeds. -->
    <section class="enablement__checklist" data-testid="enablement-checklist">
      <h3>Enablement gate</h3>
      <p v-if="checklist.length === 0" class="enablement__ready" data-testid="enablement-ready">
        All enablement requirements are satisfied — this rule can be enabled.
      </p>
      <ul v-else class="enablement__items">
        <li
          v-for="item in checklist"
          :key="item.key"
          class="enablement__item"
          :data-testid="`checklist-item-${item.key}`"
        >
          <span class="enablement__cross" aria-hidden="true">✗</span>
          <span>{{ item.label }}</span>
          <RouterLink
            v-if="item.bindingLink !== null"
            :to="item.bindingLink"
            class="enablement__link"
            :data-testid="`checklist-link-${item.key}`"
          >
            Confirm binding →
          </RouterLink>
        </li>
      </ul>
    </section>

    <!-- SU-1.3: neither identity-lookup path — match-first unavailable, duplicate risk. -->
    <Message v-if="neitherLookupPath" severity="warn" data-testid="enablement-degradation-lookup">
      This resource pair has <strong>neither identity-lookup path</strong>: match-first is
      unavailable, so pre-existing records cannot be matched and may be duplicated. Enabling is
      permitted <strong>only with backfill explicitly skipped</strong>.
    </Message>

    <!-- SU-1.4: one-way rule → source-of-truth semantics + targetDriftCheck opt-in. -->
    <Message v-if="isOneWay" severity="warn" data-testid="enablement-oneway">
      This is a <strong>one-way</strong> rule (no counterpart direction), so it has
      <strong>source-of-truth semantics</strong> for the mapped fields: a target-side edit between
      syncs is not observed and the next source change overwrites it silently. Opt in to
      <code>targetDriftCheck = read-before-write</code> below to turn those silent overwrites into
      conflicts (one extra read per write, CF-6).
    </Message>

    <!-- SU-5.2: changeTimestampRef is a degradation, never a blocker. -->
    <p class="enablement__note" data-testid="enablement-degradation-timestamp">
      Note: an unconfirmed change-timestamp ref (<code>changeTimestampRef</code>) never blocks
      enablement — it degrades last-write-wins conflict resolution to observation order (CF-2). It
      is a degradation, not a checklist blocker.
    </p>

    <template v-if="!readonly">
      <!-- targetDriftCheck opt-in (SU-1.4) — configurable only while the rule is disabled. -->
      <label class="enablement__drift" data-testid="target-drift-check-label">
        <input
          type="checkbox"
          :checked="targetDriftCheckOn"
          :disabled="!isDisabledRule || pending"
          data-testid="target-drift-check"
          @change="onToggleTargetDriftCheck"
        />
        <span>
          <code>targetDriftCheck = read-before-write</code> — read the target before each write to
          catch drift (turns silent overwrites into conflicts).
        </span>
      </label>

      <!-- SU-1.2: backfill choice (link-only / push) + explicit skip — never a default. -->
      <fieldset v-if="isDisabledRule" class="enablement__backfill" data-testid="backfill-choice">
        <legend>Initial backfill mode</legend>
        <label class="enablement__radio">
          <input
            v-model="backfillChoice"
            type="radio"
            value="link-only"
            :disabled="pending || neitherLookupPath"
            data-testid="backfill-link-only"
          />
          <span
            ><code>link-only</code> — link matched records + seed baselines; write nothing.</span
          >
        </label>
        <label class="enablement__radio">
          <input
            v-model="backfillChoice"
            type="radio"
            value="push"
            :disabled="pending || neitherLookupPath || pushBlocked"
            data-testid="backfill-push"
          />
          <span
            ><code>push</code> — declare the source the initial source of truth for this
            direction.</span
          >
        </label>
        <label class="enablement__radio">
          <input
            v-model="backfillChoice"
            type="radio"
            value="skip"
            :disabled="pending"
            data-testid="backfill-skip"
          />
          <span>Skip backfill — do not reconcile existing records (an explicit choice).</span>
        </label>

        <p v-if="pushBlocked" class="enablement__hint" data-testid="push-blocked-note">
          <code>push</code> is disabled: the counterpart direction already backfills
          <code>push</code>. Pushing both directions of a bidirectional pair is a contradiction.
        </p>
      </fieldset>

      <Message v-if="errorMessage !== null" severity="error" data-testid="enable-error">
        {{ errorMessage }}
      </Message>

      <Message v-if="enableOutcomeMessage !== null" severity="success" data-testid="enable-outcome">
        {{ enableOutcomeMessage }}
        <ul v-if="enableDegradationMessages.length > 0" class="enablement__degradations">
          <li v-for="message in enableDegradationMessages" :key="message">{{ message }}</li>
        </ul>
      </Message>

      <div class="enablement__actions">
        <Button
          v-if="isDisabledRule"
          label="Enable rule"
          :disabled="!enableAllowed || pending"
          data-testid="enable-button"
          @click="onEnable"
        />
        <Button
          v-else
          label="Disable rule"
          severity="secondary"
          :disabled="pending"
          data-testid="disable-button"
          @click="onDisable"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.enablement {
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.enablement__header {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.enablement__meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.enablement__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.enablement__item {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.enablement__cross {
  color: var(--p-red-500, #ef4444);
  font-weight: 700;
}

.enablement__ready {
  color: var(--p-green-600, #16a34a);
  margin: 0;
}

.enablement__note {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0;
}

.enablement__drift {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.enablement__backfill {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.75rem;
}

.enablement__radio {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.enablement__hint {
  color: var(--p-text-muted-color, #64748b);
  font-size: 0.85rem;
  margin: 0.25rem 0 0;
}

.enablement__actions {
  display: flex;
  gap: 0.5rem;
}

.enablement__link {
  font-size: 0.85rem;
}

.enablement__degradations {
  margin: 0.4rem 0 0;
  padding-left: 1.1rem;
}
</style>
