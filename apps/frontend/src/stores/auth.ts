import type { SessionRole } from "@mediator/contracts";
import { defineStore } from "pinia";
import { computed, ref, type ComputedRef, type Ref } from "vue";

import { encodeBasicAuth, registerAuthEventHandlers, setAuthHeader } from "../api/auth-header.js";
import { ApiError } from "../api/errors.js";
import { getSession } from "../api/session.js";

/**
 * Operator authentication state as a discriminated union rather than a bag of
 * optional fields, so the UI renders exactly one of unauthenticated / logging-in /
 * authenticated. The password is never held on the state — only the derived Basic
 * header lives in {@link setAuthHeader}'s in-memory slot (a dev-SPA session; gone
 * on reload, never persisted).
 */
export type AuthState =
  | { readonly status: "unauthenticated" }
  | { readonly status: "authenticating" }
  | { readonly status: "authenticated"; readonly identity: string; readonly role: SessionRole };

export interface AuthStore {
  readonly state: Ref<AuthState>;
  /** The resolved role, or `null` when not authenticated. */
  readonly role: ComputedRef<SessionRole | null>;
  readonly isAuthenticated: ComputedRef<boolean>;
  /** Whether the current principal may mutate (drives every mutation affordance). */
  readonly isOperator: ComputedRef<boolean>;
  readonly identity: ComputedRef<string | null>;
  /** Last login failure message, for the login form. */
  readonly loginError: Ref<string | null>;
  /** Set when a mutation was refused 403 — a `viewer` hit an operator action. */
  readonly forcedReadOnly: Ref<boolean>;
  readonly logIn: (username: string, password: string) => Promise<boolean>;
  readonly logOut: () => void;
}

/**
 * The auth store (OA follow-up). Owns the session lifecycle: `logIn` installs the
 * Basic credential and resolves the role via `GET /api/session`; `logOut` clears
 * it. It also registers the transport-level reactions so a mid-session `401`
 * (credential rejected) logs out and a `403` (a `viewer` mutating) flips the UI to
 * read-only — the mutation is already blocked server-side (OA-2), this only keeps
 * the affordances honest.
 */
export const useAuthStore = defineStore("auth", (): AuthStore => {
  const state = ref<AuthState>({ status: "unauthenticated" });
  const loginError = ref<string | null>(null);
  const forcedReadOnly = ref<boolean>(false);

  const role = computed<SessionRole | null>(() =>
    state.value.status === "authenticated" ? state.value.role : null,
  );
  const isAuthenticated = computed<boolean>(() => state.value.status === "authenticated");
  const isOperator = computed<boolean>(() => role.value === "operator");
  const identity = computed<string | null>(() =>
    state.value.status === "authenticated" ? state.value.identity : null,
  );

  function logOut(): void {
    setAuthHeader(null);
    state.value = { status: "unauthenticated" };
  }

  async function logIn(username: string, password: string): Promise<boolean> {
    loginError.value = null;
    forcedReadOnly.value = false;
    state.value = { status: "authenticating" };
    setAuthHeader(encodeBasicAuth(username, password));
    try {
      const session = await getSession();
      state.value = { status: "authenticated", identity: session.identity, role: session.role };
      return true;
    } catch (error) {
      setAuthHeader(null);
      state.value = { status: "unauthenticated" };
      loginError.value =
        error instanceof ApiError && error.statusCode === 401
          ? "Invalid username or password."
          : error instanceof Error
            ? error.message
            : "Could not sign in.";
      return false;
    }
  }

  // Transport-level reactions. A 401 mid-session ends the session; a 403 means the
  // authenticated principal is a `viewer` — downgrade to read-only so the affordances
  // match what the server will allow.
  registerAuthEventHandlers({
    onUnauthenticated: (): void => {
      if (state.value.status !== "authenticating") {
        logOut();
      }
    },
    onForbidden: (): void => {
      forcedReadOnly.value = true;
      if (state.value.status === "authenticated" && state.value.role !== "viewer") {
        state.value = { ...state.value, role: "viewer" };
      }
    },
  });

  return {
    state,
    role,
    isAuthenticated,
    isOperator,
    identity,
    loginError,
    forcedReadOnly,
    logIn,
    logOut,
  };
});
