import type {
  CreateScopeLinkResponse,
  ParkedContainerLinkDto,
  ParkedContainerLinkListResponse,
  UnlinkScopeLinkResponse,
} from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import type { ApiError } from "../api/errors.js";
import {
  createScopeLink,
  getScopeLinkCandidateContext,
  listParkedContainerLinks,
  unlinkScopeLink,
} from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the SS-15.5 container-linking screen: the parked
 * container-link queue read (SS-11.5) + the link/unlink mutations (SS-11.6). Linking a
 * container resolves its parked entry server-side (a parked record/scope replays and
 * leaves the queue), so the mutations invalidate the parked query. The link lifecycle
 * (idempotent establish, archive-on-unlink) is the engine's (SS-11).
 */

/** Read query for the parked container-link queue (SS-11.5 / SS-15.5). */
export function useParkedContainerLinks(): UseQueryReturnType<
  ParkedContainerLinkListResponse,
  ApiError
> {
  return useQuery<ParkedContainerLinkListResponse, ApiError>({
    queryKey: queryKeys.parkedContainerLinks,
    queryFn: () => listParkedContainerLinks(),
  });
}

/**
 * The operator's link intent for one parked entry: the parked container plus the chosen
 * candidate target native id. The composable resolves the pair's target linking context
 * (SS-15.5) and wraps the native id into a `ScopeLink` addressing key — the small gap the
 * parked payload does not carry.
 */
export interface LinkParkedContainerInput {
  readonly parked: ParkedContainerLinkDto;
  readonly targetNativeId: string;
}

/**
 * Manually link a parked container to the chosen candidate target (SS-11.6 / SS-15.5).
 * Resolves the pair's `targetAppId` + target addressing component, builds the
 * `POST /api/scope-links` request, and invalidates the parked queue so the now-resolved
 * container drops off. Errors as a plain `Error` when the pair has no confirmed
 * correspondence / resolvable component (nothing to link against yet).
 */
export function useLinkParkedContainer(): UseMutationReturnType<
  CreateScopeLinkResponse,
  Error,
  LinkParkedContainerInput,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<CreateScopeLinkResponse, Error, LinkParkedContainerInput>({
    mutationFn: async (input) => {
      const context = await getScopeLinkCandidateContext(input.parked.resourcePairRef);
      if (context.targetAppId === null || context.targetScopeKeyComponent === null) {
        throw new Error(
          "Cannot link this container: the pair has no confirmed scope identity key / resolvable target addressing component yet. Confirm the scope identity key first.",
        );
      }
      return createScopeLink({
        resourcePairRef: input.parked.resourcePairRef,
        sourceAppId: input.parked.sourceAppId,
        sourceScopeKey: input.parked.sourceScopeKey,
        targetAppId: context.targetAppId,
        targetScopeKey: { [context.targetScopeKeyComponent]: input.targetNativeId },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.parkedContainerLinks });
    },
  });
}

/** Sever a `ScopeLink` (SS-11.6). Invalidates the parked container-link queue. */
export function useUnlinkScopeLink(): UseMutationReturnType<
  UnlinkScopeLinkResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<UnlinkScopeLinkResponse, ApiError, string>({
    mutationFn: (id) => unlinkScopeLink(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.parkedContainerLinks });
    },
  });
}
