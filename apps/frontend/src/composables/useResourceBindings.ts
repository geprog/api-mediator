import type {
  ResourceBindingsResponse,
  UpdateResourceBindingRequest,
  UpdateResourceBindingResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";

import type { ApiError } from "../api/errors.js";
import { getResourceBindings, updateResourceBinding } from "../api/resource-bindings.js";
import { queryKeys } from "./queryKeys.js";

/** Variables for the confirm/correct mutation. */
export interface UpdateBindingVariables {
  readonly bindingId: string;
  readonly request: UpdateResourceBindingRequest;
}

/** Read query for a spec's resource bindings (RB-3). */
export function useResourceBindings(
  specId: MaybeRefOrGetter<string>,
): UseQueryReturnType<ResourceBindingsResponse, ApiError> {
  return useQuery<ResourceBindingsResponse, ApiError>({
    queryKey: computed(() => queryKeys.specBindings(toValue(specId))),
    queryFn: () => getResourceBindings(toValue(specId)),
  });
}

/**
 * Confirm/correct one binding ref (RB-2/RB-3). On success it invalidates the
 * owning spec's bindings query so the panel reflects the new state.
 */
export function useUpdateResourceBinding(
  specId: MaybeRefOrGetter<string>,
): UseMutationReturnType<UpdateResourceBindingResponse, ApiError, UpdateBindingVariables, unknown> {
  const queryClient = useQueryClient();
  return useMutation<UpdateResourceBindingResponse, ApiError, UpdateBindingVariables>({
    mutationFn: (variables) => updateResourceBinding(variables.bindingId, variables.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.specBindings(toValue(specId)) });
    },
  });
}
