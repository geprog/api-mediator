import type { DeadLetterQueueResponse, ReplayParkedWriteResponse } from "@mediator/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationReturnType,
  type UseQueryReturnType,
} from "@tanstack/vue-query";

import type { ApiError } from "../api/errors.js";
import { listDeadLetterWrites, replayParkedWrite } from "../api/sync.js";
import { queryKeys } from "./queryKeys.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-4 Sync API dead-letter slice (SA-5):
 * the parked-write queue read + the replay mutation. Replay **reactivates** the
 * parked entry so the running dispatcher re-runs the standard pipeline against
 * current state — never a blind re-issue. The mutation invalidates the queue.
 */

/** Read query for the dead-letter (parked-write) queue (SA-5.1). */
export function useDeadLetterWrites(): UseQueryReturnType<DeadLetterQueueResponse, ApiError> {
  return useQuery<DeadLetterQueueResponse, ApiError>({
    queryKey: queryKeys.deadLetterWrites,
    queryFn: () => listDeadLetterWrites(),
  });
}

/** Replay a parked write (SA-5.2). Invalidates the dead-letter queue. */
export function useReplayParkedWrite(): UseMutationReturnType<
  ReplayParkedWriteResponse,
  ApiError,
  string,
  unknown
> {
  const queryClient = useQueryClient();
  return useMutation<ReplayParkedWriteResponse, ApiError, string>({
    mutationFn: (id) => replayParkedWrite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deadLetterWrites });
    },
  });
}
