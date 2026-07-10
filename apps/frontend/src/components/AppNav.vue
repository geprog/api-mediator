<script setup lang="ts">
import { RouterLink } from "vue-router";

/**
 * Top navigation for the operator UI. Routes avoid the dev-proxied `/api` and
 * `/health` paths so a full page reload is served by the SPA, not proxied to the
 * backend (see `vite.config.ts`).
 */
</script>

<template>
  <nav class="app-nav" aria-label="Primary">
    <span class="app-nav__brand">API Mediator</span>
    <ul class="app-nav__links">
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
</style>
