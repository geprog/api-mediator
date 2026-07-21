import type {
  AdapterEndpointStateResponse,
  AdapterHealthResponse,
  AdapterRequestHistoryResponse,
  AdapterStateResponse,
  ComposeAdapterEndpointPreviewResponse,
  ComposeAdapterEndpointRequest,
  ComposeAdapterEndpointResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";

import {
  composeAdapterEndpoint,
  getAdapterEndpoint,
  getAdapterHealth,
  listAdapterEndpoints,
  listAdapterRequests,
  previewComposition,
  setAdapterBindingEnabled,
  setAdapterEndpointEnabled,
  type AdapterRequestHistoryFilter,
} from "../api/adapter-endpoints.js";
import type { ApiError } from "../api/errors.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-5 adapter-management API (AP-1..AP-3,
 * AP-5). Reads are queries; each compose/enable/disable is a mutation that
 * invalidates the endpoint-state cache so the composition screen and health view
 * reflect the new serving configuration. The composition **preview** (AP-2.4) is a
 * mutation, not a query: it derives against a *draft* the composer is editing and
 * persists nothing (derive-then-confirm), so it is re-run on demand as the draft
 * changes rather than cached by key. Every invariant is the **server's** (CO-2/CO-3,
 * OA-2) — these are thin bindings.
 */

/** Read query for the whole adapter state: endpoints + not-yet-mapped needs (AP-1). */
export function useAdapterEndpoints(): UseQueryReturnType<AdapterStateResponse, ApiError> {
  return useQuery<AdapterStateResponse, ApiError>({
    queryKey: queryKeys.adapterEndpoints,
    queryFn: listAdapterEndpoints,
  });
}

/** Read query for one endpoint's state (AP-1), keyed by (reactive) id. */
export function useAdapterEndpoint(
  endpointId: MaybeRefOrGetter<string>,
): UseQueryReturnType<AdapterEndpointStateResponse, ApiError> {
  return useQuery<AdapterEndpointStateResponse, ApiError>({
    queryKey: computed(() => queryKeys.adapterEndpoint(toValue(endpointId))),
    queryFn: () => getAdapterEndpoint(toValue(endpointId)),
    enabled: computed(() => toValue(endpointId) !== ""),
  });
}

/** Read query for the adapter request history (AP-5.1), keyed by (reactive) filter. */
export function useAdapterRequests(
  filter: MaybeRefOrGetter<AdapterRequestHistoryFilter>,
): UseQueryReturnType<AdapterRequestHistoryResponse, ApiError> {
  return useQuery<AdapterRequestHistoryResponse, ApiError>({
    queryKey: computed(() => queryKeys.adapterRequests(JSON.stringify(toValue(filter)))),
    queryFn: () => listAdapterRequests(toValue(filter)),
  });
}

/** Read query for the operator-actionable endpoint health (AP-5.3). */
export function useAdapterHealth(): UseQueryReturnType<AdapterHealthResponse, ApiError> {
  return useQuery<AdapterHealthResponse, ApiError>({
    queryKey: queryKeys.adapterHealth,
    queryFn: getAdapterHealth,
  });
}

/** Variables for the compose / preview mutations (AP-2). */
export interface ComposeAdapterEndpointVariables {
  readonly endpointId: string;
  readonly request: ComposeAdapterEndpointRequest;
}

/**
 * The composition **preview** mutation (AP-2.4) — runs the derive-then-confirm
 * derivation for the current draft. It persists nothing, so it does **not**
 * invalidate any cache.
 */
export function useComposePreview(): UseMutationReturnType<
  ComposeAdapterEndpointPreviewResponse,
  ApiError,
  ComposeAdapterEndpointVariables,
  unknown
> {
  return useMutation<
    ComposeAdapterEndpointPreviewResponse,
    ApiError,
    ComposeAdapterEndpointVariables
  >({
    mutationFn: (variables) => previewComposition(variables.endpointId, variables.request),
  });
}

/** Submit a composition (AP-2.1/2.2). Invalidates the endpoint-state caches on success. */
export function useComposeAdapterEndpoint(): UseMutationReturnType<
  ComposeAdapterEndpointResponse,
  ApiError,
  ComposeAdapterEndpointVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ComposeAdapterEndpointResponse, ApiError, ComposeAdapterEndpointVariables>({
    mutationFn: (variables) => composeAdapterEndpoint(variables.endpointId, variables.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterEndpoints });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterHealth });
    },
  });
}

/** Variables for the endpoint enable/disable mutation (AP-3.1). */
export interface SetAdapterEndpointEnabledVariables {
  readonly endpointId: string;
  readonly enabled: boolean;
}

/** Enable/disable a whole endpoint (AP-3.1). Invalidates the endpoint-state caches. */
export function useSetAdapterEndpointEnabled(): UseMutationReturnType<
  AdapterEndpointStateResponse,
  ApiError,
  SetAdapterEndpointEnabledVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<AdapterEndpointStateResponse, ApiError, SetAdapterEndpointEnabledVariables>({
    mutationFn: (variables) => setAdapterEndpointEnabled(variables.endpointId, variables.enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterEndpoints });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterHealth });
    },
  });
}

/** Variables for the binding enable/disable mutation (AP-3.2/3.3). */
export interface SetAdapterBindingEnabledVariables {
  readonly endpointId: string;
  readonly bindingId: string;
  readonly enabled: boolean;
}

/** Enable/disable a single binding (AP-3.2/3.3). Invalidates the endpoint-state caches. */
export function useSetAdapterBindingEnabled(): UseMutationReturnType<
  ComposeAdapterEndpointResponse,
  ApiError,
  SetAdapterBindingEnabledVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ComposeAdapterEndpointResponse, ApiError, SetAdapterBindingEnabledVariables>({
    mutationFn: (variables) =>
      setAdapterBindingEnabled(variables.endpointId, variables.bindingId, variables.enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterEndpoints });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adapterHealth });
    },
  });
}
