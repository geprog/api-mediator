import type {
  AmbiguousMatchListResponse,
  CreateRecordLinkRequest,
  CreateRecordLinkResponse,
  UnlinkRecordResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import type { ApiError } from "../api/errors.js";
import { createRecordLink, listAmbiguousMatches, unlinkRecord } from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-4 Sync API manual-link slice (SA-3):
 * the ambiguous-match queue read + the link/unlink mutations. Linking a record
 * removes it from the ambiguous queue server-side, so the create/unlink mutations
 * invalidate the queue query. The link lifecycle is the engine's (RL-5).
 */

/** Read query for the ambiguous-match queue (SA-3.3). */
export function useAmbiguousMatches(): UseQueryReturnType<AmbiguousMatchListResponse, ApiError> {
  return useQuery<AmbiguousMatchListResponse, ApiError>({
    queryKey: queryKeys.ambiguousMatches,
    queryFn: () => listAmbiguousMatches(),
  });
}

/**
 * Manually link a source record to a chosen target record (SA-3.1). Invalidates the
 * ambiguous-match queue so the now-resolved record drops off it.
 */
export function useCreateRecordLink(): UseMutationReturnType<
  CreateRecordLinkResponse,
  ApiError,
  CreateRecordLinkRequest,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<CreateRecordLinkResponse, ApiError, CreateRecordLinkRequest>({
    mutationFn: (request) => createRecordLink(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ambiguousMatches });
    },
  });
}

/** Sever a `RecordLink` (SA-3.2). Invalidates the ambiguous-match queue. */
export function useUnlinkRecord(): UseMutationReturnType<
  UnlinkRecordResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<UnlinkRecordResponse, ApiError, string>({
    mutationFn: (linkId) => unlinkRecord(linkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ambiguousMatches });
    },
  });
}
