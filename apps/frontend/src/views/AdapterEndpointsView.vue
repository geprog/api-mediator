<script setup lang="ts">
import type {
  AdapterEndpointStateDto,
  NotYetMappedConsumerOperationDto,
} from "@mediator/contracts";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { useAdapterEndpoints } from "../composables/useAdapterEndpoints.js";

/**
 * CU-1.1 — the adapter composition hub. It surfaces the `composition-required`
 * endpoints as a **queue** for an explicit composition decision, each stating that
 * it **keeps serving its previous configuration** meanwhile, plus the whole endpoint
 * inventory and the consumer's `not-yet-mapped` unmet needs. Reads only (AP-1) — no
 * credential material.
 *
 * NB: AP-1 does not expose a status-change timestamp, so a composition-required
 * endpoint's **age is not available** — the queue shows the structural signal
 * (which bindings are `proposed`, whether a previous configuration still serves)
 * rather than a fabricated elapsed time.
 */
const stateQuery = useAdapterEndpoints();

const endpoints = computed<AdapterEndpointStateDto[]>(() => stateQuery.data.value?.endpoints ?? []);
const notYetMapped = computed<NotYetMappedConsumerOperationDto[]>(
  () => stateQuery.data.value?.notYetMapped ?? [],
);
const compositionQueue = computed<AdapterEndpointStateDto[]>(() =>
  endpoints.value.filter((endpoint) => endpoint.status === "composition-required"),
);

function statusSeverity(status: AdapterEndpointStateDto["status"]): "success" | "warn" | "danger" {
  switch (status) {
    case "active":
      return "success";
    case "composition-required":
      return "warn";
    case "disabled":
      return "danger";
  }
}
</script>

<template>
  <main class="adapter-endpoints">
    <header class="adapter-endpoints__header">
      <h1>Adapter endpoints</h1>
      <nav class="adapter-endpoints__nav" aria-label="Adapter tools">
        <RouterLink to="/adapter/health" data-testid="nav-adapter-health">Health</RouterLink>
      </nav>
    </header>

    <p v-if="stateQuery.isPending.value" data-testid="adapter-endpoints-loading">
      Loading adapter endpoints…
    </p>

    <Message
      v-else-if="stateQuery.isError.value"
      severity="error"
      data-testid="adapter-endpoints-error"
    >
      Could not load adapter endpoints: {{ stateQuery.error.value?.message }}
    </Message>

    <template v-else>
      <!-- CU-1.1 — the composition-required queue -->
      <section class="adapter-endpoints__block" data-testid="composition-queue">
        <h2>Composition required</h2>
        <p v-if="compositionQueue.length === 0" data-testid="composition-queue-empty">
          Nothing awaiting a composition decision.
        </p>
        <ul v-else class="adapter-endpoints__list">
          <li
            v-for="endpoint in compositionQueue"
            :key="endpoint.id"
            class="adapter-endpoints__queue-item"
            :data-testid="`composition-queue-item-${endpoint.id}`"
          >
            <RouterLink
              :to="`/adapter/endpoints/${endpoint.id}`"
              :data-testid="`composition-queue-link-${endpoint.id}`"
            >
              <code>{{ endpoint.consumerAppId }} · {{ endpoint.consumerOperationId }}</code>
            </RouterLink>
            <p class="adapter-endpoints__muted">
              {{ endpoint.compositionRequired?.proposedBindingIds.length ?? 0 }} binding(s) proposed
              and awaiting a decision.
              <template v-if="endpoint.compositionRequired?.previousConfigurationServing">
                <strong>Its previous configuration keeps serving</strong> until composition is
                completed — approving a new mapping never disrupts a live endpoint.
              </template>
              <template v-else> No previous configuration is serving this operation yet. </template>
            </p>
          </li>
        </ul>
      </section>

      <!-- All endpoints -->
      <section class="adapter-endpoints__block" data-testid="all-endpoints">
        <h2>All endpoints</h2>
        <p v-if="endpoints.length === 0" data-testid="all-endpoints-empty">
          No adapter endpoints yet — approve a consumer-provider mapping to derive one.
        </p>
        <ul v-else class="adapter-endpoints__list">
          <li
            v-for="endpoint in endpoints"
            :key="endpoint.id"
            class="adapter-endpoints__row"
            :data-testid="`endpoint-row-${endpoint.id}`"
          >
            <RouterLink :to="`/adapter/endpoints/${endpoint.id}`">
              <code>{{ endpoint.consumerAppId }} · {{ endpoint.consumerOperationId }}</code>
            </RouterLink>
            <Tag :severity="statusSeverity(endpoint.status)" :value="endpoint.status" />
            <Tag
              v-if="endpoint.aggregationStrategy !== null"
              severity="secondary"
              :value="endpoint.aggregationStrategy"
            />
            <RouterLink
              :to="`/adapter/apps/${endpoint.consumerAppId}/token`"
              :data-testid="`endpoint-token-link-${endpoint.id}`"
            >
              Adapter token →
            </RouterLink>
          </li>
        </ul>
      </section>

      <!-- CU-1.1 / AP-1.3 — not-yet-mapped consumer needs -->
      <section class="adapter-endpoints__block" data-testid="not-yet-mapped">
        <h2>Not yet mapped</h2>
        <p v-if="notYetMapped.length === 0" data-testid="not-yet-mapped-empty">
          Every consumer operation has an active binding.
        </p>
        <ul v-else class="adapter-endpoints__list">
          <li
            v-for="operation in notYetMapped"
            :key="`${operation.consumerAppId}:${operation.consumerOperationId}`"
            class="adapter-endpoints__row"
            :data-testid="`not-yet-mapped-${operation.consumerAppId}-${operation.consumerOperationId}`"
          >
            <code>{{ operation.consumerAppId }} · {{ operation.consumerOperationId }}</code>
            <Tag severity="secondary" :value="operation.reason" />
          </li>
        </ul>
      </section>
    </template>
  </main>
</template>

<style scoped>
.adapter-endpoints {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.adapter-endpoints__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.adapter-endpoints__nav {
  display: flex;
  gap: 1rem;
}

.adapter-endpoints__block {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.adapter-endpoints__block h2 {
  margin: 0;
}

.adapter-endpoints__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.adapter-endpoints__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.adapter-endpoints__queue-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  border: 1px solid var(--p-content-border-color, #e2e8f0);
  border-radius: 6px;
  padding: 0.75rem;
}

.adapter-endpoints__muted {
  margin: 0;
  color: var(--p-text-muted-color, #64748b);
}
</style>
