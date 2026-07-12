import type {
  AppSpecsResponse,
  IrResponse,
  PreviewParseRequest,
  PreviewParseResponse,
  UpdateAnalysisExclusionsRequest,
  UpdateAnalysisExclusionsResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";

import { getAppSpecs } from "../api/apps.js";
import type { ApiError } from "../api/errors.js";
import { getSpecIr, previewParse, updateAnalysisExclusions } from "../api/specs.js";
import { queryKeys } from "./queryKeys.js";

/** Variables for the update-exclusions mutation. */
export interface UpdateExclusionsVariables {
  readonly specId: string;
  readonly request: UpdateAnalysisExclusionsRequest;
}

/** Read query for one app's spec metadata (AR-2 criterion 2). */
export function useAppSpecs(
  appId: MaybeRefOrGetter<string>,
): UseQueryReturnType<AppSpecsResponse, ApiError> {
  return useQuery<AppSpecsResponse, ApiError>({
    queryKey: computed(() => queryKeys.appSpecs(toValue(appId))),
    queryFn: () => getAppSpecs(toValue(appId)),
    // Guard against an empty appId (e.g. an unselected app in the proposal-list
    // filter) firing a request with no id.
    enabled: computed(() => toValue(appId) !== ""),
  });
}

/** Read query for a spec's parsed IR (SI-3). */
export function useSpecIr(
  specId: MaybeRefOrGetter<string>,
): UseQueryReturnType<IrResponse, ApiError> {
  return useQuery<IrResponse, ApiError>({
    queryKey: computed(() => queryKeys.specIr(toValue(specId))),
    queryFn: () => getSpecIr(toValue(specId)),
  });
}

/** Stateless preview-parse mutation for the registration form (AR-3 criterion 2). */
export function usePreviewParse(): UseMutationReturnType<
  PreviewParseResponse,
  ApiError,
  PreviewParseRequest,
  unknown
> {
  return useMutation<PreviewParseResponse, ApiError, PreviewParseRequest>({
    mutationFn: previewParse,
  });
}

/**
 * Replace a spec's `analysisExclusions` (SI-4). On success it invalidates that
 * app's spec metadata so the updated exclusions are reflected.
 */
export function useUpdateAnalysisExclusions(): UseMutationReturnType<
  UpdateAnalysisExclusionsResponse,
  ApiError,
  UpdateExclusionsVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<UpdateAnalysisExclusionsResponse, ApiError, UpdateExclusionsVariables>({
    mutationFn: (variables) => updateAnalysisExclusions(variables.specId, variables.request),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.appSpecs(updated.appId) });
    },
  });
}
