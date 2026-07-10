import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";

import HealthView from "../views/HealthView.vue";

/**
 * Application routes. Phase 0 ships a single real route (`/` → the health
 * dashboard); the operator feature pages arrive from Phase 1 onward.
 */
const routes: readonly RouteRecordRaw[] = [{ path: "/", name: "health", component: HealthView }];

export const router: Router = createRouter({
  history: createWebHistory(),
  routes: [...routes],
});
