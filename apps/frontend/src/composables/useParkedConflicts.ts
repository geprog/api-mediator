import type {
  ParkedConflictListResponse,
  ResolveParkedConflictRequest,
  ResolveParkedConflictResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import type { ApiError } from "../api/errors.js";
import { listParkedConflicts, resolveParkedConflict } from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-4 Sync API parked-conflict slice
 * (SA-4): the open-conflict queue read + the resolve mutation. A resolution runs
 * through the **normal pipeline** (or, for a sever, tombstones directly) — the UI
 * never writes a value; it invalidates the queue so a resolved row drops off it.
 */

/** Read query for the open parked-conflict queue (SA-4.1). */
export function useParkedConflicts(): UseQueryReturnType<ParkedConflictListResponse, ApiError> {
  return useQuery<ParkedConflictListResponse, ApiError>({
    queryKey: queryKeys.parkedConflicts,
    queryFn: () => listParkedConflicts(),
  });
}

/** Variables for the resolve mutation (SA-4.2/4.3). */
export interface ResolveParkedConflictVariables {
  readonly id: string;
  readonly request: ResolveParkedConflictRequest;
}

/** Resolve a parked conflict by the operator's chosen side/outcome (SA-4.2/4.3). */
export function useResolveParkedConflict(): UseMutationReturnType<
  ResolveParkedConflictResponse,
  ApiError,
  ResolveParkedConflictVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ResolveParkedConflictResponse, ApiError, ResolveParkedConflictVariables>({
    mutationFn: (variables) => resolveParkedConflict(variables.id, variables.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.parkedConflicts });
    },
  });
}
