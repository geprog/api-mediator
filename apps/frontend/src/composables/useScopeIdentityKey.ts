import type {
  ConfirmScopeIdentityKeyRequest,
  ConfirmScopeIdentityKeyResponse,
  ScopeIdentityKeyDerivationResponse,
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
import { confirmScopeIdentityKey, deriveScopeIdentityKey } from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the SS-15.4 scope-identity-key confirmation panel:
 * the derive-then-correct read + the confirm mutation. The derive read surfaces the
 * pair's `ScopeCorrespondence` candidate (SS-10); confirming stamps/corrects it. Every
 * invariant (value-preserving pairing, operator-only, 404 when the correspondence is not
 * established) is the server's — this layer only keeps the cache honest.
 */

/** Read query for the pair's scope-identity-key candidate (SS-15.4). */
export function useScopeIdentityKeyDerivation(
  resourcePairRef: MaybeRefOrGetter<string>,
): UseQueryReturnType<ScopeIdentityKeyDerivationResponse, ApiError> {
  return useQuery<ScopeIdentityKeyDerivationResponse, ApiError>({
    queryKey: computed(() => queryKeys.scopeIdentityKey(toValue(resourcePairRef))),
    queryFn: () => deriveScopeIdentityKey(toValue(resourcePairRef)),
    enabled: computed(() => toValue(resourcePairRef) !== ""),
  });
}

/**
 * Confirm (or correct) the pair's scope identity key (SS-15.4). Invalidates the pair's
 * derivation (to reflect the new confirmation) and the sync-rules list (the enablement
 * gate clears the `scope-identity-key` blocker once confirmed).
 */
export function useConfirmScopeIdentityKey(): UseMutationReturnType<
  ConfirmScopeIdentityKeyResponse,
  ApiError,
  ConfirmScopeIdentityKeyRequest,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ConfirmScopeIdentityKeyResponse, ApiError, ConfirmScopeIdentityKeyRequest>({
    mutationFn: (request) => confirmScopeIdentityKey(request),
    onSuccess: (_response, request) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.scopeIdentityKey(request.resourcePairRef),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncRules });
    },
  });
}
