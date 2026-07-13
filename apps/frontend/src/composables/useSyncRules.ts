import type {
  ConfigureSyncRuleRequest,
  ConfigureSyncRuleResponse,
  DisableSyncRuleResponse,
  EnableSyncRuleRequest,
  EnableSyncRuleResponse,
  SyncEventListResponse,
  SyncEventQuery,
  SyncRuleListResponse,
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
import {
  configureSyncRule,
  disableSyncRule,
  enableSyncRule,
  listSyncEvents,
  listSyncRules,
} from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-4 Sync API `SyncRule` slice
 * (SA-1/SA-2). Reads are queries; each configure/enable/disable is a mutation that
 * invalidates the rules cache so the panel reflects the new gate/status. Every
 * invariant is the **server's** (the enablement gate, backfill, role gating OA-2) —
 * these are thin bindings.
 */

/** Read query for every `SyncRule` with its status + gate `stillNeeds` + lag (SA-2.1/2.2). */
export function useSyncRules(): UseQueryReturnType<SyncRuleListResponse, ApiError> {
  return useQuery<SyncRuleListResponse, ApiError>({
    queryKey: queryKeys.syncRules,
    queryFn: listSyncRules,
  });
}

/** Read query for the sync audit log, filtered by rule/record/status (SA-2.3). */
export function useSyncEvents(
  filter: MaybeRefOrGetter<SyncEventQuery>,
): UseQueryReturnType<SyncEventListResponse, ApiError> {
  return useQuery<SyncEventListResponse, ApiError>({
    queryKey: computed(() => queryKeys.syncEvents(JSON.stringify(toValue(filter)))),
    queryFn: () => listSyncEvents(toValue(filter)),
  });
}

/** Variables for the configure mutation (SA-1.1). */
export interface ConfigureSyncRuleVariables {
  readonly ruleId: string;
  readonly request: ConfigureSyncRuleRequest;
}

/** Configure a disabled rule's execution options (SA-1.1). Invalidates the rules cache. */
export function useConfigureSyncRule(): UseMutationReturnType<
  ConfigureSyncRuleResponse,
  ApiError,
  ConfigureSyncRuleVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ConfigureSyncRuleResponse, ApiError, ConfigureSyncRuleVariables>({
    mutationFn: (variables) => configureSyncRule(variables.ruleId, variables.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncRules });
    },
  });
}

/** Variables for the enable mutation (SA-1.2/1.3). */
export interface EnableSyncRuleVariables {
  readonly ruleId: string;
  readonly request: EnableSyncRuleRequest;
}

/** Enable a rule through the gate (SA-1.2/1.3). Invalidates the rules cache. */
export function useEnableSyncRule(): UseMutationReturnType<
  EnableSyncRuleResponse,
  ApiError,
  EnableSyncRuleVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<EnableSyncRuleResponse, ApiError, EnableSyncRuleVariables>({
    mutationFn: (variables) => enableSyncRule(variables.ruleId, variables.request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncRules });
    },
  });
}

/** Disable a rule (SA-1.4). Invalidates the rules cache. */
export function useDisableSyncRule(): UseMutationReturnType<
  DisableSyncRuleResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<DisableSyncRuleResponse, ApiError, string>({
    mutationFn: (ruleId) => disableSyncRule(ruleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncRules });
    },
  });
}
