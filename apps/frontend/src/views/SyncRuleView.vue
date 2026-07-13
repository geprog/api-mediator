<script setup lang="ts">
import type {
  ConfigureSyncRuleRequest,
  EnableSyncRuleRequest,
  EnableSyncRuleResponse,
  SyncRuleStatusDto,
} from "@mediator/contracts";
import Message from "primevue/message";
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";

import RuleEnablementPanel from "../components/sync/RuleEnablementPanel.vue";
import { findCounterpart } from "../components/sync/enablement-model.js";
import {
  useConfigureSyncRule,
  useDisableSyncRule,
  useEnableSyncRule,
  useSyncRules,
} from "../composables/useSyncRules.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * The SU-1 / SU-5 rule-enablement screen. It owns the SA-1/SA-2 wiring: the rules
 * query (needed to resolve the rule **and** its counterpart for one-way / push-on-both
 * derivations) and the enable/disable/configure mutations. The gate, backfill choice,
 * and warnings live in {@link RuleEnablementPanel}; this view keeps the affordances
 * honest for a viewer (read-only) and reflects the enable outcome. Every invariant is
 * server-enforced (BE-1/BE-2, OA-2).
 */
const route = useRoute();
const auth = useAuthStore();

const ruleId = computed<string>(() => {
  const raw = route.params["id"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});

const readonly = computed<boolean>(() => !auth.isOperator);

const rulesQuery = useSyncRules();
const rules = computed<SyncRuleStatusDto[]>(() => rulesQuery.data.value?.rules ?? []);
const rule = computed<SyncRuleStatusDto | undefined>(() =>
  rules.value.find((candidate) => candidate.id === ruleId.value),
);
const counterpart = computed<SyncRuleStatusDto | null>(() =>
  rule.value === undefined ? null : findCounterpart(rules.value, rule.value),
);

const enable = useEnableSyncRule();
const disable = useDisableSyncRule();
const configure = useConfigureSyncRule();

const enableResult = ref<EnableSyncRuleResponse | null>(null);
const actionError = ref<string | null>(null);

const pending = computed<boolean>(
  () => enable.isPending.value || disable.isPending.value || configure.isPending.value,
);

function onEnable(request: EnableSyncRuleRequest): void {
  actionError.value = null;
  enable.mutate(
    { ruleId: ruleId.value, request },
    {
      onSuccess: (result) => (enableResult.value = result),
      onError: (error) => (actionError.value = error.message),
    },
  );
}

function onDisable(): void {
  actionError.value = null;
  enableResult.value = null;
  disable.mutate(ruleId.value, {
    onError: (error) => (actionError.value = error.message),
  });
}

function onConfigure(request: ConfigureSyncRuleRequest): void {
  actionError.value = null;
  configure.mutate(
    { ruleId: ruleId.value, request },
    { onError: (error) => (actionError.value = error.message) },
  );
}
</script>

<template>
  <main class="sync-rule">
    <RouterLink to="/sync">← All sync rules</RouterLink>

    <p v-if="rulesQuery.isPending.value" data-testid="sync-rule-loading">Loading sync rule…</p>

    <Message v-else-if="rulesQuery.isError.value" severity="error" data-testid="sync-rule-error">
      Could not load sync rules: {{ rulesQuery.error.value?.message }}
    </Message>

    <p v-else-if="rule === undefined" data-testid="sync-rule-missing">
      Sync rule {{ ruleId }} was not found.
    </p>

    <RuleEnablementPanel
      v-else
      :rule="rule"
      :counterpart="counterpart"
      :readonly="readonly"
      :pending="pending"
      :error-message="actionError"
      :enable-result="enableResult"
      @enable="onEnable"
      @disable="onDisable"
      @configure="onConfigure"
    />
  </main>
</template>

<style scoped>
.sync-rule {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
</style>
