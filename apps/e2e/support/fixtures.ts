import { fileURLToPath } from "node:url";

import { test as base, expect } from "@playwright/test";

import { AppDetailPage } from "./pages/app-detail.page.js";
import { AppListPage } from "./pages/app-list.page.js";
import { RegisterAppPage } from "./pages/register-app.page.js";
import { SpecPage } from "./pages/spec.page.js";

/**
 * Absolute path to the scenario-1 Gitea `PROVIDER` OAS3 spec — the committed
 * fixture the registration journey uploads. Resolved from this file's location so
 * it is worktree-relative, not cwd-relative.
 */
export const GITEA_PROVIDER_SPEC = fileURLToPath(
  new URL(
    "../../../scenarios/scenario-1-small-overlap/specs/oas3/gitea.trimmed.oas3.json",
    import.meta.url,
  ),
);

/**
 * A collision-free app name so a journey self-isolates within the shared compose
 * Postgres (the tests never depend on a clean DB, only on their own app id).
 */
export function uniqueAppName(prefix: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`;
}

/** Page objects provided to every test via Playwright's fixture system. */
interface RegistrationFixtures {
  registerApp: RegisterAppPage;
  appList: AppListPage;
  appDetail: AppDetailPage;
  specPage: SpecPage;
}

export const test = base.extend<RegistrationFixtures>({
  registerApp: async ({ page }, use): Promise<void> => {
    await use(new RegisterAppPage(page));
  },
  appList: async ({ page }, use): Promise<void> => {
    await use(new AppListPage(page));
  },
  appDetail: async ({ page }, use): Promise<void> => {
    await use(new AppDetailPage(page));
  },
  specPage: async ({ page }, use): Promise<void> => {
    await use(new SpecPage(page));
  },
});

export { expect };
