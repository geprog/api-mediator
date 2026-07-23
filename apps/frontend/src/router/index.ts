import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from "vue-router";

import { useAuthStore } from "../stores/auth.js";
import AdapterEndpointsView from "../views/AdapterEndpointsView.vue";
import AdapterEndpointView from "../views/AdapterEndpointView.vue";
import AdapterHealthView from "../views/AdapterHealthView.vue";
import AdapterTokenView from "../views/AdapterTokenView.vue";
import AppDetailView from "../views/AppDetailView.vue";
import AppListView from "../views/AppListView.vue";
import ApprovedMappingsView from "../views/ApprovedMappingsView.vue";
import ConflictResolutionView from "../views/ConflictResolutionView.vue";
import ContainerLinkingView from "../views/ContainerLinkingView.vue";
import HealthView from "../views/HealthView.vue";
import LoginView from "../views/LoginView.vue";
import ManualLinkingView from "../views/ManualLinkingView.vue";
import ParkedWritesView from "../views/ParkedWritesView.vue";
import ProposalListView from "../views/ProposalListView.vue";
import ProposalReviewView from "../views/ProposalReviewView.vue";
import RegisterAppView from "../views/RegisterAppView.vue";
import ScopeIdentityKeyView from "../views/ScopeIdentityKeyView.vue";
import SpecView from "../views/SpecView.vue";
import SyncRuleView from "../views/SyncRuleView.vue";
import SyncRulesView from "../views/SyncRulesView.vue";

/**
 * Operator UI routes. Route paths deliberately avoid `/api` and `/health` — those
 * are proxied to the backend by the Vite dev server. Every route except `/login`
 * requires an authenticated identity (the operator API is fully authenticated,
 * OA-1); the guard below redirects an anonymous visitor to the login screen.
 */
const routes: readonly RouteRecordRaw[] = [
  { path: "/", redirect: "/proposals" },
  { path: "/login", name: "login", component: LoginView },
  { path: "/apps", name: "app-list", component: AppListView },
  { path: "/apps/new", name: "app-register", component: RegisterAppView },
  { path: "/apps/:id", name: "app-detail", component: AppDetailView },
  { path: "/specs/:id", name: "spec-detail", component: SpecView },
  { path: "/proposals", name: "proposal-list", component: ProposalListView },
  { path: "/proposals/:id", name: "proposal-review", component: ProposalReviewView },
  // SL-10 — the approved-mapping lifecycle: status + manual suspend/resume.
  { path: "/mappings", name: "approved-mappings", component: ApprovedMappingsView },
  { path: "/sync", name: "sync-rules", component: SyncRulesView },
  { path: "/sync/rules/:id", name: "sync-rule", component: SyncRuleView },
  { path: "/sync/manual-links", name: "sync-manual-links", component: ManualLinkingView },
  {
    path: "/sync/container-links",
    name: "sync-container-links",
    component: ContainerLinkingView,
  },
  {
    path: "/sync/scope-identity-key",
    name: "sync-scope-identity-key",
    component: ScopeIdentityKeyView,
  },
  { path: "/sync/conflicts", name: "sync-conflicts", component: ConflictResolutionView },
  { path: "/sync/dead-letter", name: "sync-dead-letter", component: ParkedWritesView },
  { path: "/adapter", name: "adapter-endpoints", component: AdapterEndpointsView },
  {
    path: "/adapter/endpoints/:id",
    name: "adapter-endpoint",
    component: AdapterEndpointView,
  },
  {
    path: "/adapter/apps/:appId/token",
    name: "adapter-token",
    component: AdapterTokenView,
  },
  { path: "/adapter/health", name: "adapter-health", component: AdapterHealthView },
  { path: "/status", name: "status", component: HealthView },
];

export const router: Router = createRouter({
  history: createWebHistory(),
  routes: [...routes],
});

/**
 * Auth gate (OA follow-up). An unauthenticated visitor is sent to `/login` with the
 * intended path preserved as `redirect`; an already-authenticated visitor never
 * lands back on `/login`. The store is resolved lazily inside the guard so Pinia is
 * installed by the time navigation runs.
 */
router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.name === "login") {
    return auth.isAuthenticated ? { path: "/proposals" } : true;
  }
  if (!auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  return true;
});
