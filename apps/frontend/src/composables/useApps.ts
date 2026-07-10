import type { AppListResponse, RegisterAppRequest, RegisterAppResponse } from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import { listApps, registerApp } from "../api/apps.js";
import type { ApiError } from "../api/errors.js";
import { queryKeys } from "./queryKeys.js";

/** Read query for the app list (AR-2). */
export function useAppList(): UseQueryReturnType<AppListResponse, ApiError> {
  return useQuery<AppListResponse, ApiError>({
    queryKey: queryKeys.apps,
    queryFn: listApps,
  });
}

/**
 * Registration mutation (AR-1/AR-3). On success it invalidates the app list so
 * the newly registered app appears without a manual refetch.
 */
export function useRegisterApp(): UseMutationReturnType<
  RegisterAppResponse,
  ApiError,
  RegisterAppRequest,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<RegisterAppResponse, ApiError, RegisterAppRequest>({
    mutationFn: registerApp,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps });
    },
  });
}
