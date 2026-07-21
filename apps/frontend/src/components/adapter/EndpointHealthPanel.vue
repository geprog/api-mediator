<script setup lang="ts">
import type {
  AdapterEndpointStateDto,
  AdapterHealthResponse,
  AdapterRequestDto,
  NotYetMappedConsumerOperationDto,
} from "@mediator/contracts";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";

import {
  ADAPTER_STALENESS_NOTE,
  bindingCauseLabel,
  deriveEndpointOperationState,
  requestsForEndpoint,
  summarizeRequests,
  type OperationHealthState,
} from "./health-model.js";

/**
 * CU-4 — the endpoint-health view. It shows which consumer operations are unserved,
 * degraded, or failing and why: each operation's state (served / `not-yet-mapped` /
 * `composition-required` / `disabled`), each unhealthy binding's specific cause with
 * the note that adapter staleness breaks a **live caller now**, per-endpoint
 * request/error/degraded counts and cause breakdown, and any `mediator-transform-
 * error` surfaced **prominently as a defect to fix**. All read-only metadata — no
 * payload, token, or credential value appears (CU-4.5).
 */
const props = defineProps<{
  endpoints: readonly AdapterEndpointStateDto[];
  notYetMapped: readonly NotYetMappedConsumerOperationDto[];
  health: AdapterHealthResponse;
  requests: readonly AdapterRequestDto[];
}>();

interface OperationRow {
  readonly key: string;
  readonly consumerAppId: string;
  readonly consumerOperationId: string;
  readonly state: OperationHealthState;
  readonly endpointId: string | null;
}

const operationRows = computed<OperationRow[]>(() => {
  const fromEndpoints = props.endpoints.map<OperationRow>((endpoint) => ({
    key: endpoint.id,
    consumerAppId: endpoint.consumerAppId,
    consumerOperationId: endpoint.consumerOperationId,
    state: deriveEndpointOperationState(endpoint),
    endpointId: endpoint.id,
  }));
  const fromUnmet = props.notYetMapped.map<OperationRow>((operation) => ({
    key: `${operation.consumerAppId}:${operation.consumerOperationId}`,
    consumerAppId: operation.consumerAppId,
    consumerOperationId: operation.consumerOperationId,
    state: "not-yet-mapped",
    endpointId: null,
  }));
  return [...fromEndpoints, ...fromUnmet];
});

function stateSeverity(state: OperationHealthState): "success" | "warn" | "danger" | "secondary" {
  switch (state) {
    case "served":
      return "success";
    case "composition-required":
      return "warn";
    case "not-yet-mapped":
      return "secondary";
    case "disabled":
      return "danger";
  }
}

const endpointSummaries = computed(() =>
  props.endpoints.map((endpoint) => ({
    endpoint,
    summary: summarizeRequests(requestsForEndpoint(props.requests, endpoint.id)),
  })),
);
</script>

<template>
  <div class="endpoint-health" data-testid="endpoint-health">
    <!-- CU-4.4 — mediator-transform-error surfaced prominently as a defect to fix -->
    <Message
      v-if="health.transformErrors.length > 0"
      severity="error"
      data-testid="health-transform-errors"
    >
      <strong>{{ health.transformErrors.length }} mediator-transform-error(s)</strong> — the
      aggregated response failed validation against the consumer's own schema. This is a
      mapping/composition <strong>defect to fix</strong>, not an operational blip; the mediator
      never returns a response that violates the contract the consumer coded against.
      <ul>
        <li
          v-for="error in health.transformErrors"
          :key="error.id"
          :data-testid="`health-transform-error-${error.id}`"
        >
          endpoint <code>{{ error.relatedEndpointId ?? "—" }}</code>
          <span v-if="error.traceId !== null">
            · trace <code>{{ error.traceId }}</code></span
          >
        </li>
      </ul>
    </Message>

    <!-- CU-4.1 — consumer-operation states -->
    <section class="endpoint-health__block" data-testid="health-operations">
      <h4>Consumer operations</h4>
      <p v-if="operationRows.length === 0" class="endpoint-health__muted">
        No consumer operations yet.
      </p>
      <ul v-else class="endpoint-health__list">
        <li
          v-for="row in operationRows"
          :key="row.key"
          class="endpoint-health__row"
          :data-testid="`health-operation-${row.consumerAppId}-${row.consumerOperationId}`"
        >
          <code>{{ row.consumerAppId }} · {{ row.consumerOperationId }}</code>
          <Tag
            :severity="stateSeverity(row.state)"
            :value="row.state"
            :data-testid="`health-operation-state-${row.consumerAppId}-${row.consumerOperationId}`"
          />
        </li>
      </ul>
    </section>

    <!-- CU-4.2 — unhealthy bindings with their specific cause -->
    <section class="endpoint-health__block" data-testid="health-unhealthy-bindings">
      <h4>Unhealthy bindings</h4>
      <p v-if="health.unhealthyBindings.length === 0" class="endpoint-health__muted">
        No active binding is currently eliminated by an unhealthy mapping or a disabled backend.
      </p>
      <template v-else>
        <Message severity="warn" data-testid="health-staleness-note">{{
          ADAPTER_STALENESS_NOTE
        }}</Message>
        <ul class="endpoint-health__list">
          <li
            v-for="binding in health.unhealthyBindings"
            :key="binding.bindingId"
            :data-testid="`health-binding-${binding.bindingId}`"
          >
            endpoint <code>{{ binding.endpointId }}</code
            >, backend <code>{{ binding.backendAppId }}</code> —
            <Tag
              severity="danger"
              :value="binding.cause"
              :data-testid="`health-binding-cause-${binding.bindingId}`"
            />
            <span class="endpoint-health__muted">{{ bindingCauseLabel(binding.cause) }}</span>
          </li>
        </ul>
      </template>
    </section>

    <!-- CU-4.3 — per-endpoint request/error/degraded counts + cause breakdown -->
    <section class="endpoint-health__block" data-testid="health-request-counts">
      <h4>Recent request activity</h4>
      <p v-if="endpointSummaries.length === 0" class="endpoint-health__muted">No endpoints yet.</p>
      <ul v-else class="endpoint-health__list">
        <li
          v-for="entry in endpointSummaries"
          :key="entry.endpoint.id"
          class="endpoint-health__summary"
          :data-testid="`health-endpoint-${entry.endpoint.id}`"
        >
          <code>{{ entry.endpoint.consumerOperationId }}</code>
          <span :data-testid="`health-count-total-${entry.endpoint.id}`"
            >requests: {{ entry.summary.total }}</span
          >
          <span :data-testid="`health-count-errors-${entry.endpoint.id}`"
            >errors: {{ entry.summary.errors }}</span
          >
          <span :data-testid="`health-count-degraded-${entry.endpoint.id}`"
            >degraded: {{ entry.summary.degraded }}</span
          >
          <span
            v-for="[cause, count] in entry.summary.byCause"
            :key="cause"
            class="endpoint-health__cause"
            :data-testid="`health-cause-${entry.endpoint.id}-${cause}`"
            >{{ cause }}: {{ count }}</span
          >
        </li>
      </ul>
      <p class="endpoint-health__note" data-testid="health-cache-note">
        Cache hit rate is emitted as an OpenTelemetry metric (see Grafana) and is not a structured
        field of the in-product request-history read, so it is not shown per endpoint here.
      </p>
    </section>
  </div>
</template>

<style scoped>
.endpoint-health {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.endpoint-health__block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.endpoint-health__block h4 {
  margin: 0;
}

.endpoint-health__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.endpoint-health__row,
.endpoint-health__summary {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.endpoint-health__muted,
.endpoint-health__note {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}

.endpoint-health__note {
  font-size: 0.8rem;
  font-style: italic;
}

.endpoint-health__cause {
  font-size: 0.85rem;
  color: var(--p-text-muted-color, #64748b);
}
</style>
