import type { CutoverAdapterTokenResponse, IssueAdapterTokenResponse } from "@mediator/contracts";
import { useMutation, type UseMutationReturnType } from "@tanstack/vue-query";

import {
  cutoverAdapterToken,
  issueAdapterToken,
  rotateAdapterToken,
} from "../api/adapter-token.js";
import type { ApiError } from "../api/errors.js";

/**
 * `@tanstack/vue-query` bindings for the Phase-5 adapter-token lifecycle (AP-4).
 *
 * These are deliberately **plain mutations with no query cache**: the raw token in
 * an issue/rotate response is shown exactly once and must never enter a store, a
 * query cache, or `localStorage` that survives navigation (AT-1.2 / CU-3.2). The
 * token panel copies the value out of the mutation result into transient component
 * state and resets the mutation, so nothing outside that one component instance
 * ever holds it. There is no read binding — no endpoint can echo the token back.
 */

/** Issue a consumer app's first adapter token (AP-4.1). */
export function useIssueAdapterToken(): UseMutationReturnType<
  IssueAdapterTokenResponse,
  ApiError,
  string,
  unknown
> {
  return useMutation<IssueAdapterTokenResponse, ApiError, string>({
    mutationFn: (appId) => issueAdapterToken(appId),
  });
}

/** Rotate a consumer app's adapter token (AP-4.3), opening the overlap window. */
export function useRotateAdapterToken(): UseMutationReturnType<
  IssueAdapterTokenResponse,
  ApiError,
  string,
  unknown
> {
  return useMutation<IssueAdapterTokenResponse, ApiError, string>({
    mutationFn: (appId) => rotateAdapterToken(appId),
  });
}

/** Confirm cutover — end a rotation overlap early (AP-4.3). Metadata only, no token. */
export function useCutoverAdapterToken(): UseMutationReturnType<
  CutoverAdapterTokenResponse,
  ApiError,
  string,
  unknown
> {
  return useMutation<CutoverAdapterTokenResponse, ApiError, string>({
    mutationFn: (appId) => cutoverAdapterToken(appId),
  });
}
