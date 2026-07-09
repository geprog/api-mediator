import { defineConfig, devices } from "@playwright/test";

/**
 * Slice-1 Playwright config. The smoke spec deliberately drives only static
 * `data:` URLs, so no mediator server (operator API/UI or Adapter Server
 * Runtime) needs to be running — `pnpm test:e2e` passes in a CI-less local
 * run. Only the Chromium project is installed; real journeys against the
 * `scenarios/` landscapes arrive in later phases.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
