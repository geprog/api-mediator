import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";

import AppDetailView from "../views/AppDetailView.vue";
import AppListView from "../views/AppListView.vue";
import HealthView from "../views/HealthView.vue";
import RegisterAppView from "../views/RegisterAppView.vue";
import SpecView from "../views/SpecView.vue";

/**
 * Operator UI routes (Phase 1). Route paths deliberately avoid `/api` and
 * `/health` — those are proxied to the backend by the Vite dev server, so a full
 * reload on such a path would hit the backend instead of the SPA. The health
 * dashboard therefore lives at `/status`; `/` redirects to the app list.
 */
const routes: readonly RouteRecordRaw[] = [
  { path: "/", redirect: "/apps" },
  { path: "/apps", name: "app-list", component: AppListView },
  { path: "/apps/new", name: "app-register", component: RegisterAppView },
  { path: "/apps/:id", name: "app-detail", component: AppDetailView },
  { path: "/specs/:id", name: "spec-detail", component: SpecView },
  { path: "/status", name: "status", component: HealthView },
];

export const router: Router = createRouter({
  history: createWebHistory(),
  routes: [...routes],
});
