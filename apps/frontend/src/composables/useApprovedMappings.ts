import type {
  ApprovedMappingListResponse,
  ApprovedMappingTransitionResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import {
  listApprovedMappings,
  resumeApprovedMapping,
  suspendApprovedMapping,
} from "../api/approved-mappings.js";
import type { ApiError } from "../api/errors.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the SL-10 `ApprovedMapping` lifecycle. The read is a
 * query; suspend and resume are mutations that invalidate the mappings cache — and the
 * sync-rule and adapter-endpoint caches too, because the transition changes what those
 * derived artifacts do (a suspended mapping's rules pause and its bindings fail
 * `mapping-suspended`, both **derived** from the mapping status rather than stored on the
 * rule/binding). Every invariant is the server's; these are thin bindings.
 */

/** Read query for every `ApprovedMapping` with its current `status` (SL-10). */
export function useApprovedMappings(): UseQueryReturnType<ApprovedMappingListResponse, ApiError> {
  return useQuery<ApprovedMappingListResponse, ApiError>({
    queryKey: queryKeys.approvedMappings,
    queryFn: listApprovedMappings,
  });
}

/** Invalidate the mapping list plus the two derived surfaces a transition changes. */
function invalidateAffected(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.approvedMappings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.syncRules });
  void queryClient.invalidateQueries({ queryKey: queryKeys.adapterEndpoints });
}

/** Suspend an `active` mapping (SL-10.1) — the manual operator hold. */
export function useSuspendApprovedMapping(): UseMutationReturnType<
  ApprovedMappingTransitionResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ApprovedMappingTransitionResponse, ApiError, string>({
    mutationFn: (mappingId) => suspendApprovedMapping(mappingId),
    onSuccess: () => {
      invalidateAffected(queryClient);
    },
  });
}

/** Resume a `suspended` mapping (SL-10.2) — the exact inverse of suspend. */
export function useResumeApprovedMapping(): UseMutationReturnType<
  ApprovedMappingTransitionResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ApprovedMappingTransitionResponse, ApiError, string>({
    mutationFn: (mappingId) => resumeApprovedMapping(mappingId),
    onSuccess: () => {
      invalidateAffected(queryClient);
    },
  });
}
