<script setup lang="ts">
import Button from "primevue/button";
import Tag from "primevue/tag";
import { RouterLink, useRouter } from "vue-router";

import { useAuthStore } from "../stores/auth.js";

/**
 * Top navigation for the operator UI. Routes avoid the dev-proxied `/api` and
 * `/health` paths so a full page reload is served by the SPA, not proxied to the
 * backend (see `vite.config.ts`). The links + session identity/role + logout show
 * only when authenticated; the login screen renders just the brand.
 */
const auth = useAuthStore();
const router = useRouter();

function logOut(): void {
  auth.logOut();
  void router.push({ name: "login" });
}
</script>

<template>
  <nav class="app-nav" aria-label="Primary">
    <span class="app-nav__brand">API Mediator</span>

    <template v-if="auth.isAuthenticated">
      <ul class="app-nav__links">
        <li>
          <RouterLink to="/proposals" data-testid="nav-proposals">Proposals</RouterLink>
        </li>
        <li>
          <RouterLink to="/sync" data-testid="nav-sync">Sync</RouterLink>
        </li>
        <li>
          <RouterLink to="/adapter" data-testid="nav-adapter">Adapter</RouterLink>
        </li>
        <li>
          <RouterLink to="/apps" data-testid="nav-apps">Apps</RouterLink>
        </li>
        <li>
          <RouterLink to="/apps/new" data-testid="nav-register">Register app</RouterLink>
        </li>
        <li>
          <RouterLink to="/status" data-testid="nav-status">Status</RouterLink>
        </li>
      </ul>

      <div class="app-nav__session">
        <span data-testid="nav-identity">{{ auth.identity }}</span>
        <Tag
          v-if="auth.role !== null"
          :severity="auth.role === 'operator' ? 'success' : 'secondary'"
          :value="auth.role"
          data-testid="nav-role"
        />
        <Button
          size="small"
          severity="secondary"
          label="Sign out"
          data-testid="nav-logout"
          @click="logOut"
        />
      </div>
    </template>
  </nav>
</template>

<style scoped>
.app-nav {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--p-content-border-color, #e2e8f0);
}

.app-nav__brand {
  font-weight: 700;
}

.app-nav__links {
  display: flex;
  gap: 1.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.app-nav__links a {
  text-decoration: none;
  color: inherit;
}

.app-nav__links a.router-link-active {
  font-weight: 700;
  text-decoration: underline;
}

.app-nav__session {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}
</style>
