<script setup lang="ts">
import type {
  AdapterEndpointStateDto,
  ComposeAdapterEndpointPreviewResponse,
  ComposeAdapterEndpointRequest,
  ValidationIssue,
} from "@mediator/contracts";
import {
  resolveExecutionOrder,
  type AcknowledgedIgnoredInput,
  type AdapterBindingRole,
  type AggregationStrategy,
  type EndpointStrictness,
  type PostMergeDedup,
  type PostMergeFilter,
  type PostMergePaginationConventionValue,
  type PostMergeSort,
} from "@mediator/domain";
import Button from "primevue/button";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed, reactive, ref, watch } from "vue";

import {
  availableStrategies,
  buildComposeRequest,
  coerceRoleForStrategy,
  firstSuccessTiedOrders,
  rolesForStrategy,
  strategyUsesChainInputs,
  strategyUsesDependsOn,
  strategyUsesExecutionOrder,
  upstreamConsumerResponseFields,
  WRITE_SINGLE_REASON,
  type CompositionBindingDraft,
  type CompositionDraft,
} from "./composition-model.js";
import UnionCompositionPanel, { type UnionConfigChange } from "./UnionCompositionPanel.vue";
import type { LinkDedupAvailability } from "./union-model.js";

/**
 * CU-1 — the composition screen. It composes an endpoint from its approved bindings
 * with the **illegal choices visibly unavailable**: a strategy offers exactly its
 * valid roles per binding, `executionOrder`/`dependsOnBindingId`/`chainInputs` show
 * only where meaningful, a `fanout-first-success` order tie is flagged before
 * submission, a chained binding's `chainInputs` source options are the upstream
 * binding's consumer-shape response fields, the CO-4 load-bearing-supplement and
 * CO-5 input-coverage analyses are surfaced from the preview, and a **write**
 * operation offers only `single` with the reason stated. The **server** enforces
 * every rule (CO-2/CO-3); a rejection's exact violations are surfaced verbatim.
 *
 * Editable-copy pattern (like the sync panels): it owns a draft initialised from the
 * endpoint, emits the built request for a live preview and on submit, and stays
 * read-only for a viewer (OA-2).
 */
const props = withDefaults(
  defineProps<{
    endpoint: AdapterEndpointStateDto;
    /** The AP-2 derive-then-confirm preview for the current draft, or `null` while it loads. */
    preview: ComposeAdapterEndpointPreviewResponse | null;
    /**
     * Whether the consumer operation is a write (CU-1.6). AP-1 does not expose the
     * operation's HTTP method, so a host view generally cannot determine this; when
     * unknown it is `false` and the server enforces write→single, surfacing the reason
     * on rejection. When known to be a write, only `single` is offered up front.
     */
    writeOperation?: boolean;
    /** Link-dedup availability for the union panel (CU-2.3) — server-enforced by default. */
    linkDedupAvailability?: LinkDedupAvailability;
    /** Consumer-schema field paths offered for a union dedup key (CU-2.3). */
    dedupKeyFieldOptions?: readonly string[];
    readonly: boolean;
    pending: boolean;
    /** The server's rejection of the last submit — its message + the exact rule violations. */
    rejection: { message: string; issues: readonly ValidationIssue[] } | null;
  }>(),
  {
    writeOperation: false,
    linkDedupAvailability: () => ({ kind: "server-enforced" }),
    dedupKeyFieldOptions: () => [],
  },
);

const emit = defineEmits<{
  /** The composer wants a fresh preview of the current draft (derive-then-confirm). */
  preview: [request: ComposeAdapterEndpointRequest];
  /** The composer submits the composition. */
  submit: [request: ComposeAdapterEndpointRequest];
}>();

// ── Editable draft state ─────────────────────────────────────────────────────
interface EditableChainInput {
  upstreamFieldPath: string;
  targetParamRef: string;
}
interface EditableBinding {
  bindingId: string;
  backendAppId: string;
  backendOperationId: string;
  role: AdapterBindingRole;
  executionOrder: string;
  dependsOnBindingId: string;
  chainInputs: EditableChainInput[];
}

const strategy = ref<AggregationStrategy>("single");
const strictness = ref<EndpointStrictness>("degraded");
const cacheTtlText = ref<string>("");
const bindings = ref<EditableBinding[]>([]);
/** Acknowledged optional unmapped consumer inputs, keyed `${kind}:${name}` (CO-5.4). */
const acknowledged = reactive<Record<string, boolean>>({});
// Union config, updated by the union panel's `change` event.
const unionDedup = ref<PostMergeDedup | null>(null);
const unionFilters = ref<readonly PostMergeFilter[]>([]);
const unionSorts = ref<readonly PostMergeSort[]>([]);
const unionPagination = ref<PostMergePaginationConventionValue | null>(null);
const unionPaginationConfirmed = ref<boolean>(false);

/** Re-seed the draft from the endpoint whenever it changes. */
watch(
  () => props.endpoint,
  (endpoint) => {
    const offered = availableStrategies({ writeOperation: props.writeOperation });
    const initial = endpoint.aggregationStrategy ?? "single";
    strategy.value = offered.includes(initial) ? initial : (offered[0] ?? "single");
    strictness.value = endpoint.strictness ?? "degraded";
    cacheTtlText.value = endpoint.cacheTtl === null ? "" : String(endpoint.cacheTtl);
    bindings.value = endpoint.bindings
      .filter((binding) => binding.status !== "disabled")
      .map((binding) => ({
        bindingId: binding.id,
        backendAppId: binding.backendAppId,
        backendOperationId: binding.backendOperationId,
        role: coerceRoleForStrategy(strategy.value, binding.role),
        executionOrder: binding.executionOrder === undefined ? "" : String(binding.executionOrder),
        dependsOnBindingId: binding.dependsOnBindingId ?? "",
        chainInputs: [],
      }));
    // Pre-load a union endpoint's persisted post-merge config for a recompose.
    unionDedup.value = endpoint.union?.dedup ?? null;
    unionFilters.value = endpoint.union?.filters ?? [];
    unionSorts.value = endpoint.union?.sorts ?? [];
    unionPagination.value = endpoint.union?.pagination?.convention ?? null;
    unionPaginationConfirmed.value = endpoint.union?.pagination?.confirmed ?? false;
    for (const key of Object.keys(acknowledged)) delete acknowledged[key];
  },
  { immediate: true, deep: true },
);

/** When the strategy changes, keep each binding's role valid for the new strategy. */
watch(strategy, (next) => {
  for (const binding of bindings.value) {
    binding.role = coerceRoleForStrategy(next, binding.role);
    if (!strategyUsesDependsOn(next)) {
      binding.dependsOnBindingId = "";
      binding.chainInputs = [];
    }
  }
});

const offeredStrategies = computed<readonly AggregationStrategy[]>(() =>
  availableStrategies({ writeOperation: props.writeOperation }),
);
const rolesForCurrentStrategy = computed<readonly AdapterBindingRole[]>(() =>
  rolesForStrategy(strategy.value),
);
const showOrder = computed<boolean>(() => strategyUsesExecutionOrder(strategy.value));
const showDependsOn = computed<boolean>(() => strategyUsesDependsOn(strategy.value));
const showChainInputs = computed<boolean>(() => strategyUsesChainInputs(strategy.value));
const isUnion = computed<boolean>(() => strategy.value === "collection-union");

const draftBindings = computed<CompositionBindingDraft[]>(() =>
  bindings.value.map((binding) => {
    // A `type="number"` input can hand back a number at runtime, so normalise to string.
    const order = String(binding.executionOrder ?? "").trim();
    const chain = binding.chainInputs
      .filter(
        (input) => input.upstreamFieldPath.trim() !== "" && input.targetParamRef.trim() !== "",
      )
      .map((input) => ({
        upstreamFieldPath: input.upstreamFieldPath.trim(),
        targetParamRef: input.targetParamRef.trim(),
      }));
    return {
      bindingId: binding.bindingId,
      role: binding.role,
      ...(order !== "" ? { executionOrder: Number(order) } : {}),
      ...(showDependsOn.value && binding.dependsOnBindingId !== ""
        ? { dependsOnBindingId: binding.dependsOnBindingId }
        : {}),
      ...(showChainInputs.value && chain.length > 0 ? { chainInputs: chain } : {}),
    };
  }),
);

const cacheTtl = computed<number | undefined>(() => {
  const trimmed = String(cacheTtlText.value ?? "").trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : undefined;
});

const acknowledgedInputs = computed<AcknowledgedIgnoredInput[]>(() =>
  (props.preview?.coverage.unmappedByAllBackends ?? [])
    .filter((input) => !input.required && acknowledged[`${input.kind}:${input.name}`] === true)
    .map((input) =>
      input.kind === "parameter"
        ? { kind: "parameter", consumerParamName: input.name }
        : { kind: "body-field", consumerFieldPath: input.name },
    ),
);

const draft = computed<CompositionDraft>(() => ({
  aggregationStrategy: strategy.value,
  strictness: strictness.value,
  ...(cacheTtl.value !== undefined ? { cacheTtl: cacheTtl.value } : {}),
  bindings: draftBindings.value,
  ...(acknowledgedInputs.value.length > 0
    ? { acknowledgedIgnoredInputs: acknowledgedInputs.value }
    : {}),
  ...(isUnion.value && unionDedup.value !== null ? { postMergeDedup: unionDedup.value } : {}),
  ...(isUnion.value && unionFilters.value.length > 0
    ? { postMergeFilters: unionFilters.value }
    : {}),
  ...(isUnion.value && unionSorts.value.length > 0 ? { postMergeSorts: unionSorts.value } : {}),
  ...(isUnion.value && unionPagination.value !== null
    ? {
        postMergePagination: unionPagination.value,
        confirmPostMergePagination: unionPaginationConfirmed.value,
      }
    : {}),
}));

const request = computed<ComposeAdapterEndpointRequest>(() => buildComposeRequest(draft.value));

/** Ask the host for a fresh preview whenever the built request changes. */
watch(
  request,
  (next) => {
    emit("preview", next);
  },
  { immediate: true, deep: true },
);

// ── CU-1.3 order-tie flag ────────────────────────────────────────────────────
const tiedOrders = computed<readonly number[]>(() =>
  strategy.value === "fanout-first-success" ? firstSuccessTiedOrders(draftBindings.value) : [],
);
const hasOrderTie = computed<boolean>(() => tiedOrders.value.length > 0);

// ── CU-1.5 supplement analysis + input coverage ──────────────────────────────
const supplementEntries = computed(() => {
  const analysis = props.preview?.supplementAnalysis;
  return analysis !== undefined && analysis.applicable ? analysis.entries : [];
});
const unmappedInputs = computed(() => props.preview?.coverage.unmappedByAllBackends ?? []);
const requiredUnmapped = computed(() => unmappedInputs.value.filter((input) => input.required));
const optionalUnmapped = computed(() => unmappedInputs.value.filter((input) => !input.required));

/** The consumer-shape response fields offered as a chained binding's `chainInputs` source (CU-1.4). */
function chainSourceFields(dependsOnBindingId: string): readonly string[] {
  return upstreamConsumerResponseFields(
    props.preview?.supplementAnalysis ?? null,
    dependsOnBindingId,
  );
}

const contributingExecutionOrders = computed<number[]>(() =>
  draftBindings.value.map((binding) => resolveExecutionOrder(binding)),
);

// ── Submit gating ────────────────────────────────────────────────────────────
const writeStrategyViolation = computed<boolean>(
  () => props.writeOperation && strategy.value !== "single",
);
const canSubmit = computed<boolean>(
  () =>
    !props.readonly &&
    !props.pending &&
    !hasOrderTie.value &&
    requiredUnmapped.value.length === 0 &&
    !writeStrategyViolation.value,
);

function addChainInput(binding: EditableBinding): void {
  binding.chainInputs.push({ upstreamFieldPath: "", targetParamRef: "" });
}
function removeChainInput(binding: EditableBinding, index: number): void {
  binding.chainInputs.splice(index, 1);
}

function onSubmit(): void {
  if (!canSubmit.value) return;
  emit("submit", request.value);
}

function bindingLabel(binding: EditableBinding): string {
  return `${binding.backendAppId} · ${binding.backendOperationId}`;
}
</script>

<template>
  <section class="composition-form" data-testid="composition-form">
    <header class="composition-form__header">
      <h3>Compose endpoint</h3>
      <Tag :value="endpoint.status" :data-testid="`composition-status`" />
    </header>
    <p class="composition-form__op">
      Consumer operation <code>{{ endpoint.consumerOperationId }}</code>
    </p>

    <!-- CU-1.6 — write endpoints are single-only -->
    <Message v-if="writeOperation" severity="info" data-testid="composition-write-single">
      {{ WRITE_SINGLE_REASON }}
    </Message>

    <!-- Strategy -->
    <label class="composition-form__field">
      <span>Aggregation strategy</span>
      <select v-model="strategy" :disabled="readonly" data-testid="composition-strategy">
        <option v-for="option in offeredStrategies" :key="option" :value="option">
          {{ option }}
        </option>
      </select>
    </label>

    <!-- Strictness -->
    <label class="composition-form__field">
      <span>Partial-failure mode</span>
      <select v-model="strictness" :disabled="readonly" data-testid="composition-strictness">
        <option value="degraded">degraded (drop a failed supplement's optional fields)</option>
        <option value="strict">strict (any binding failure fails the request)</option>
      </select>
    </label>

    <!-- cacheTtl -->
    <label class="composition-form__field">
      <span>Cache TTL (seconds, blank = no caching)</span>
      <input
        v-model="cacheTtlText"
        type="number"
        min="1"
        :disabled="readonly"
        data-testid="composition-cache-ttl"
      />
    </label>

    <!-- Bindings -->
    <div class="composition-form__bindings" data-testid="composition-bindings">
      <h4>Bindings</h4>
      <p v-if="bindings.length === 0" class="composition-form__muted">
        No composable bindings on this endpoint.
      </p>
      <div
        v-for="binding in bindings"
        :key="binding.bindingId"
        class="composition-form__binding"
        :data-testid="`composition-binding-${binding.bindingId}`"
      >
        <div class="composition-form__binding-head">
          <code>{{ bindingLabel(binding) }}</code>
        </div>
        <label class="composition-form__field">
          <span>role</span>
          <select
            v-model="binding.role"
            :disabled="readonly"
            :data-testid="`composition-role-${binding.bindingId}`"
          >
            <option v-for="role in rolesForCurrentStrategy" :key="role" :value="role">
              {{ role }}
            </option>
          </select>
        </label>
        <label v-if="showOrder" class="composition-form__field">
          <span>execution order</span>
          <input
            v-model="binding.executionOrder"
            type="number"
            :disabled="readonly"
            :data-testid="`composition-order-${binding.bindingId}`"
          />
        </label>
        <label v-if="showDependsOn" class="composition-form__field">
          <span>depends on (chained)</span>
          <select
            v-model="binding.dependsOnBindingId"
            :disabled="readonly"
            :data-testid="`composition-depends-${binding.bindingId}`"
          >
            <option value="">— none (parallel) —</option>
            <option
              v-for="other in bindings.filter(
                (candidate) => candidate.bindingId !== binding.bindingId,
              )"
              :key="other.bindingId"
              :value="other.bindingId"
            >
              {{ bindingLabel(other) }}
            </option>
          </select>
        </label>

        <!-- CU-1.4 — chainInputs source = upstream binding's consumer-shape response fields -->
        <div
          v-if="showChainInputs && binding.dependsOnBindingId !== ''"
          class="composition-form__chain"
          :data-testid="`composition-chain-${binding.bindingId}`"
        >
          <p class="composition-form__muted">
            Chain inputs feed this backend's parameters from the
            <strong>upstream binding's consumer-shape response fields</strong> — never the upstream
            backend's native schema.
          </p>
          <p
            v-if="chainSourceFields(binding.dependsOnBindingId).length === 0"
            class="composition-form__muted"
            :data-testid="`composition-chain-empty-${binding.bindingId}`"
          >
            No consumer-shape response fields are reported for the upstream binding yet.
          </p>
          <div
            v-for="(input, index) in binding.chainInputs"
            :key="index"
            class="composition-form__chain-row"
          >
            <label>
              <span>source (consumer-shape field)</span>
              <select
                v-model="input.upstreamFieldPath"
                :disabled="readonly"
                :data-testid="`composition-chain-source-${binding.bindingId}-${index}`"
              >
                <option value="">— choose —</option>
                <option
                  v-for="field in chainSourceFields(binding.dependsOnBindingId)"
                  :key="field"
                  :value="field"
                >
                  {{ field }}
                </option>
              </select>
            </label>
            <label>
              <span>target parameter</span>
              <input
                v-model="input.targetParamRef"
                type="text"
                :disabled="readonly"
                :data-testid="`composition-chain-target-${binding.bindingId}-${index}`"
              />
            </label>
            <button
              v-if="!readonly"
              type="button"
              :data-testid="`composition-chain-remove-${binding.bindingId}-${index}`"
              @click="removeChainInput(binding, index)"
            >
              remove
            </button>
          </div>
          <button
            v-if="!readonly"
            type="button"
            :data-testid="`composition-chain-add-${binding.bindingId}`"
            @click="addChainInput(binding)"
          >
            add chain input
          </button>
        </div>
      </div>
    </div>

    <!-- CU-1.3 — order tie flag -->
    <Message v-if="hasOrderTie" severity="error" data-testid="composition-order-tie">
      <code>fanout-first-success</code> needs a strict fallback order, but these execution orders
      are shared by more than one binding: {{ tiedOrders.join(", ") }}. The server rejects order
      ties — give each binding a distinct order.
    </Message>

    <!-- CU-1.5 — supplement load-bearing analysis -->
    <div
      v-if="supplementEntries.length > 0"
      class="composition-form__analysis"
      data-testid="composition-supplement-analysis"
    >
      <h4>Supplement analysis</h4>
      <ul>
        <li
          v-for="entry in supplementEntries"
          :key="entry.bindingId"
          :data-testid="`composition-supplement-${entry.bindingId}`"
        >
          <template v-if="entry.kind === 'supplement'">
            Supplies
            <code>{{ entry.suppliedConsumerResponseFields.join(", ") || "(no fields)" }}</code> —
            <Tag
              v-if="entry.loadBearing"
              severity="danger"
              value="load-bearing"
              :data-testid="`composition-supplement-loadbearing-${entry.bindingId}`"
            />
            <Tag v-else severity="success" value="degraded response possible" />
            <span v-if="entry.loadBearing" class="composition-form__muted">
              — it supplies a required consumer field, so its failure fails the whole request even
              in degraded mode.
            </span>
          </template>
          <template v-else> Primary — its failure always fails the request. </template>
        </li>
      </ul>
    </div>

    <!-- CU-1.5 — input coverage report -->
    <div
      v-if="unmappedInputs.length > 0"
      class="composition-form__analysis"
      data-testid="composition-input-coverage"
    >
      <h4>Consumer inputs reaching no backend</h4>
      <div v-if="requiredUnmapped.length > 0" data-testid="composition-coverage-required">
        <Message severity="error">
          These <strong>required</strong> consumer inputs reach no backend — a blocking finding that
          cannot be acknowledged away; the mapping must cover them:
          <code
            v-for="input in requiredUnmapped"
            :key="`${input.kind}:${input.name}`"
            class="composition-form__chip"
            >{{ input.name }}</code
          >
        </Message>
      </div>
      <div v-if="optionalUnmapped.length > 0" data-testid="composition-coverage-optional">
        <p class="composition-form__muted">
          These optional consumer inputs reach no backend. Each must be
          <strong>explicitly acknowledged</strong> as served-and-dropped, or a request using it is
          rejected:
        </p>
        <label
          v-for="input in optionalUnmapped"
          :key="`${input.kind}:${input.name}`"
          class="composition-form__ack"
          :data-testid="`composition-ack-${input.kind}-${input.name}`"
        >
          <input
            v-model="acknowledged[`${input.kind}:${input.name}`]"
            type="checkbox"
            :disabled="readonly"
          />
          <span
            >Acknowledge <code>{{ input.name }}</code> ({{ input.kind }})</span
          >
        </label>
      </div>
    </div>

    <!-- CU-2 — union composition panel -->
    <UnionCompositionPanel
      v-if="isUnion"
      :analysis="preview?.union ?? null"
      :dedup="unionDedup"
      :filters="unionFilters"
      :sorts="unionSorts"
      :pagination="unionPagination"
      :pagination-confirmed="unionPaginationConfirmed"
      :link-dedup-availability="linkDedupAvailability"
      :dedup-key-field-options="dedupKeyFieldOptions"
      :contributing-execution-orders="contributingExecutionOrders"
      :cache-ttl-configured="cacheTtl !== undefined"
      :readonly="readonly"
      @change="
        (config: UnionConfigChange) => {
          unionDedup = config.postMergeDedup;
          unionFilters = config.postMergeFilters;
          unionSorts = config.postMergeSorts;
          unionPagination = config.postMergePagination;
          unionPaginationConfirmed = config.confirmPostMergePagination;
        }
      "
    />

    <!-- AP-2 — server rejection with the exact rule violations -->
    <Message v-if="rejection !== null" severity="error" data-testid="composition-rejection">
      <p>{{ rejection.message }}</p>
      <ul v-if="rejection.issues.length > 0">
        <li
          v-for="(issue, index) in rejection.issues"
          :key="index"
          :data-testid="`composition-rejection-issue-${index}`"
        >
          <code>{{ issue.path }}</code
          >: {{ issue.message }}
        </li>
      </ul>
    </Message>

    <Button
      v-if="!readonly"
      label="Submit composition"
      :disabled="!canSubmit"
      :loading="pending"
      data-testid="composition-submit"
      @click="onSubmit"
    />
    <p v-else class="composition-form__muted" data-testid="composition-readonly">
      You have viewer access — composition is read-only.
    </p>
  </section>
</template>

<style scoped>
.composition-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
}

.composition-form__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.composition-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-width: 32rem;
}

.composition-form__op,
.composition-form__muted {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.composition-form__bindings,
.composition-form__analysis {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.composition-form__binding {
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.composition-form__chain {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-left: 0.75rem;
  border-left: 2px solid var(--p-content-border-color, #e2e8f0);
}

.composition-form__chain-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-end;
  flex-wrap: wrap;
}

.composition-form__chain-row label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
}

.composition-form__ack {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
}

.composition-form__chip {
  margin-right: 0.3rem;
}
</style>
