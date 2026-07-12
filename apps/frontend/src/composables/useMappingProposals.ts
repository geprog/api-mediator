import type {
  AnalyzeResourcePairRequest,
  AnalyzeResourcePairResponse,
  ApproveProposalRequest,
  ApproveProposalResponse,
  IdentityKeyConfirmationDto,
  MappingProposalDetailResponse,
  MappingProposalItemDto,
  MappingProposalListResponse,
  RecordProposalItemDecisionRequest,
  RecordProposalItemDecisionResponse,
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
  analyzeResourcePair,
  approveMappingProposal,
  confirmIdentityKey,
  getMappingProposalDetail,
  listMappingProposals,
  recordProposalItemDecision,
  type ProposalListFilter,
} from "../api/mapping-proposals.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-3 Review & Approval API (RA-1..RA-5).
 * Reads are queries; each decision/confirm/approve/escape-hatch is a mutation that
 * keeps the detail cache in sync. The confidence sort is the **API's** — the detail
 * query returns items already sorted riskiest-first and this layer never re-sorts.
 */

/** Read query for the proposal list, filtered by spec pair (RA-1). */
export function useProposalList(
  filter: MaybeRefOrGetter<ProposalListFilter | null>,
): UseQueryReturnType<MappingProposalListResponse, ApiError> {
  return useQuery<MappingProposalListResponse, ApiError>({
    queryKey: computed(() => {
      const value = toValue(filter);
      return value === null
        ? queryKeys.mappingProposalList("", null)
        : queryKeys.mappingProposalList(value.sourceSpecId, value.targetSpecId ?? null);
    }),
    queryFn: () => {
      const value = toValue(filter);
      if (value === null) {
        // Guarded by `enabled`; unreachable, but keeps the queryFn total.
        return Promise.resolve({ proposals: [] });
      }
      return listMappingProposals(value);
    },
    enabled: computed(() => {
      const value = toValue(filter);
      return value !== null && value.sourceSpecId !== "";
    }),
  });
}

/** Read query for one proposal's detail — items confidence-sorted (RA-1). */
export function useProposalDetail(
  proposalId: MaybeRefOrGetter<string>,
): UseQueryReturnType<MappingProposalDetailResponse, ApiError> {
  return useQuery<MappingProposalDetailResponse, ApiError>({
    queryKey: computed(() => queryKeys.mappingProposal(toValue(proposalId))),
    queryFn: () => getMappingProposalDetail(toValue(proposalId)),
    enabled: computed(() => toValue(proposalId) !== ""),
  });
}

/** Variables for a per-item decision (RA-2). */
export interface DecideItemVariables {
  readonly itemId: string;
  readonly request: RecordProposalItemDecisionRequest;
}

/** Replace one item in the cached detail with the server's post-decision item. */
function patchCachedItem(
  detail: MappingProposalDetailResponse | undefined,
  item: MappingProposalItemDto,
): MappingProposalDetailResponse | undefined {
  if (detail === undefined) {
    return undefined;
  }
  return {
    ...detail,
    items: detail.items.map((existing) => (existing.id === item.id ? item : existing)),
  };
}

/**
 * Per-item accept/edit/reject (RA-2). On success it patches the returned item into
 * the cached detail **in place**, preserving the API's confidence order (no
 * re-sort, no refetch flicker).
 */
export function useDecideProposalItem(
  proposalId: MaybeRefOrGetter<string>,
): UseMutationReturnType<
  RecordProposalItemDecisionResponse,
  ApiError,
  DecideItemVariables,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<RecordProposalItemDecisionResponse, ApiError, DecideItemVariables>({
    mutationFn: (variables) =>
      recordProposalItemDecision(toValue(proposalId), variables.itemId, variables.request),
    onSuccess: (response) => {
      queryClient.setQueryData<MappingProposalDetailResponse>(
        queryKeys.mappingProposal(toValue(proposalId)),
        (detail) => patchCachedItem(detail, response.item),
      );
    },
  });
}

/**
 * Confirm the identity key (RA-3). The endpoint delegates to approve, so this also
 * finalizes a (partial) approval; invalidate the detail + list so the resulting
 * status is reflected.
 */
export function useConfirmIdentityKey(
  proposalId: MaybeRefOrGetter<string>,
): UseMutationReturnType<ApproveProposalResponse, ApiError, IdentityKeyConfirmationDto, unknown> {
  const queryClient = useQueryClient();
  return useMutation<ApproveProposalResponse, ApiError, IdentityKeyConfirmationDto>({
    mutationFn: (request) => confirmIdentityKey(toValue(proposalId), request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mappingProposals });
    },
  });
}

/** Approve the decided selection (RA-4). Invalidates the detail + list on success. */
export function useApproveProposal(
  proposalId: MaybeRefOrGetter<string>,
): UseMutationReturnType<ApproveProposalResponse, ApiError, ApproveProposalRequest, unknown> {
  const queryClient = useQueryClient();
  return useMutation<ApproveProposalResponse, ApiError, ApproveProposalRequest>({
    mutationFn: (request) => approveMappingProposal(toValue(proposalId), request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mappingProposals });
    },
  });
}

/**
 * The shortlist-miss escape hatch (RA-5). Invalidates the detail so the newly
 * produced items appear and the analyzed resource leaves the no-counterpart list
 * (or is marked `analysisFailed`).
 */
export function useAnalyzeResourcePair(
  proposalId: MaybeRefOrGetter<string>,
): UseMutationReturnType<
  AnalyzeResourcePairResponse,
  ApiError,
  AnalyzeResourcePairRequest,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<AnalyzeResourcePairResponse, ApiError, AnalyzeResourcePairRequest>({
    mutationFn: (request) => analyzeResourcePair(toValue(proposalId), request),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mappingProposal(toValue(proposalId)),
      });
    },
  });
}
