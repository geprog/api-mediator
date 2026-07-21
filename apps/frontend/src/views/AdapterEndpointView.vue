<script setup lang="ts">
import type {
  ComposeAdapterEndpointPreviewResponse,
  ComposeAdapterEndpointRequest,
  ValidationIssue,
} from "@mediator/contracts";
import Message from "primevue/message";
import { computed, onBeforeUnmount, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";

import CompositionForm from "../components/adapter/CompositionForm.vue";
import {
  useAdapterEndpoint,
  useComposeAdapterEndpoint,
  useComposePreview,
} from "../composables/useAdapterEndpoints.js";
import { useAuthStore } from "../stores/auth.js";

/**
 * CU-1 / CU-2 — one endpoint's composition screen. It owns the AP-1 read, the AP-2
 * derive-then-confirm **preview** (operator-only), and the AP-2 compose/recompose
 * submission; the form ({@link CompositionForm}) renders the constrained choices and
 * emits the built request. A viewer sees it read-only (OA-2) and no preview is run
 * (the preview route is an operator mutation). A server rejection's exact rule
 * violations are surfaced back through the form.
 */
const route = useRoute();
const auth = useAuthStore();

const endpointId = computed<string>(() => {
  const raw = route.params["id"];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
});
const readonly = computed<boolean>(() => !auth.isOperator);

const endpointQuery = useAdapterEndpoint(endpointId);
const endpoint = computed(() => endpointQuery.data.value?.endpoint);

const previewMutation = useComposePreview();
const composeMutation = useComposeAdapterEndpoint();

const preview = ref<ComposeAdapterEndpointPreviewResponse | null>(null);
const rejection = ref<{ message: string; issues: readonly ValidationIssue[] } | null>(null);
const composed = ref<boolean>(false);

// Latest-wins preview: a light debounce plus a sequence guard so a slow, stale
// preview response never overwrites a newer one (the draft changes as the composer edits).
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewSeq = 0;
onBeforeUnmount(() => {
  if (previewTimer !== undefined) clearTimeout(previewTimer);
});

function onPreview(request: ComposeAdapterEndpointRequest): void {
  // The preview route is operator-only; never provoke a 403 for a viewer.
  if (!auth.isOperator) return;
  if (previewTimer !== undefined) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const seq = ++previewSeq;
    previewMutation.mutate(
      { endpointId: endpointId.value, request },
      {
        onSuccess: (result) => {
          if (seq === previewSeq) preview.value = result;
        },
      },
    );
  }, 150);
}

function onSubmit(request: ComposeAdapterEndpointRequest): void {
  rejection.value = null;
  composed.value = false;
  composeMutation.mutate(
    { endpointId: endpointId.value, request },
    {
      onSuccess: () => {
        composed.value = true;
      },
      onError: (error) => {
        rejection.value = { message: error.message, issues: error.issues };
      },
    },
  );
}
</script>

<template>
  <main class="adapter-endpoint">
    <RouterLink to="/adapter">← All adapter endpoints</RouterLink>

    <p v-if="endpointQuery.isPending.value" data-testid="adapter-endpoint-loading">
      Loading endpoint…
    </p>

    <Message
      v-else-if="endpointQuery.isError.value"
      severity="error"
      data-testid="adapter-endpoint-error"
    >
      Could not load endpoint: {{ endpointQuery.error.value?.message }}
    </Message>

    <p v-else-if="endpoint === undefined" data-testid="adapter-endpoint-missing">
      Adapter endpoint {{ endpointId }} was not found.
    </p>

    <template v-else>
      <p class="adapter-endpoint__links">
        <RouterLink
          :to="`/adapter/apps/${endpoint.consumerAppId}/token`"
          data-testid="adapter-endpoint-token-link"
        >
          Adapter token →
        </RouterLink>
      </p>

      <Message v-if="composed" severity="success" data-testid="adapter-endpoint-composed">
        Composition activated.
      </Message>

      <CompositionForm
        :endpoint="endpoint"
        :preview="preview"
        :readonly="readonly"
        :pending="composeMutation.isPending.value"
        :rejection="rejection"
        @preview="onPreview"
        @submit="onSubmit"
      />
    </template>
  </main>
</template>

<style scoped>
.adapter-endpoint {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.adapter-endpoint__links {
  margin: 0;
}
</style>
