import { defineStore } from "pinia";
import { ref, type Ref } from "vue";

import { fetchHealth, type HealthResponse } from "../api/health";

/**
 * Health probe as a discriminated union rather than a bag of optional fields,
 * so the view renders exactly one of idle / loading / loaded / error.
 */
export type HealthState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly response: HealthResponse }
  | { readonly status: "error"; readonly message: string };

export interface HealthStore {
  readonly state: Ref<HealthState>;
  readonly refresh: () => Promise<void>;
}

/**
 * Minimal Pinia store proving the state-management wiring. It owns the health
 * probe state and a `refresh` action; the heavy server-state tooling
 * (`@tanstack/vue-query`) arrives in Phase 1 when there is real data to cache.
 */
export const useHealthStore = defineStore("health", (): HealthStore => {
  const state = ref<HealthState>({ status: "idle" });

  async function refresh(): Promise<void> {
    state.value = { status: "loading" };
    const result = await fetchHealth();
    state.value =
      result.kind === "ok"
        ? { status: "loaded", response: result.response }
        : { status: "error", message: result.message };
  }

  return { state, refresh };
});
