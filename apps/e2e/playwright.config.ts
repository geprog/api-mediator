import { defineConfig, devices } from "@playwright/test";

import { backendEnv, BACKEND_ORIGIN, BASE_URL, FRONTEND_PORT } from "./support/env.js";

/**
 * Playwright config: the journeys drive the **real** Vue UI against the **real**
 * Fastify operator API and the compose Postgres.
 *
 * Everything runs on dedicated test ports so a run never disturbs a developer's
 * own dev server (Vite on 5173) or backend (3333):
 *
 * - backend  → `HTTP_PORT=3433`, telemetry export disabled (empty OTLP endpoint)
 * - frontend → Vite **dev** server on `5273` (the `/api` + `/health` proxy is a
 *   dev-server feature), pointed at the test backend via `BACKEND_ORIGIN`.
 *
 * Since Phase-3 operator auth (OA-1), every operator-API route requires an
 * authenticated identity, so the backend is booted with a **fixed** set of local
 * accounts (`OPERATOR_ACCOUNTS`, see `support/env.ts`): the whole backend
 * environment is supplied here rather than from a repo `.env`, making the run
 * self-contained and the login credentials the specs use deterministic.
 *
 * Both servers are started by Playwright's `webServer` and torn down after the run.
 * `reuseExistingServer: false` guarantees a fresh, known-state server (and fails
 * loudly if the port is already taken). The DB is the shared compose Postgres, so
 * tests self-isolate by seeding/registering under unique ids and cleaning up.
 */

export default defineConfig({
  testDir: "./tests",
  // A shared backend + Postgres is single-writer state; keep the journeys serial
  // and deterministic rather than racing them through one API.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // The default project runs every journey EXCEPT the landscape-gated capstones,
      // which need a running `scenarios/` landscape and so live in their own projects
      // below — keeping a plain `test:e2e` green with only the compose Postgres.
      testIgnore: /\.landscape\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // The SU-6 capstone: the real sync round against the running scenario-1 landscape.
      // Skips itself (never fails) when Docker/the landscape is unavailable. Run it with the
      // landscape up: `playwright test --project=scenario-1-sync`.
      name: "scenario-1-sync",
      testMatch: /scenario-1-.*\.landscape\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // CU-5 capstone (scenario 3): real adapter round trips against the running
      // Vikunja + `todo-widget` CONSUMER surface. Skips itself when the landscape is
      // down. Run with the landscape up: `playwright test --project=scenario-3-adapter`.
      name: "scenario-3-adapter",
      testMatch: /scenario-3-.*\.landscape\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // CU-5 capstone (scenario 4): the real 3-backend `collection-union` (Gitea +
      // Forgejo + Vikunja) served through the `task-dashboard` CONSUMER surface. Skips
      // itself when the landscape is down. Run: `playwright test --project=scenario-4-adapter`.
      name: "scenario-4-adapter",
      testMatch: /scenario-4-.*\.landscape\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Operator API on a dedicated port, seeded with the fixed local accounts and
      // a valid-but-unused LLM config (the journeys replay seeded proposals).
      // The dedicated e2e database is provisioned (create-if-absent + migrate) as
      // the first link in the command, so it exists before the backend's `/health`
      // probe pings it — Playwright waits for web-server readiness before any
      // globalSetup, so the DB cannot be provisioned there.
      command:
        "pnpm --filter @mediator/e2e exec tsx support/ensure-db.ts && " +
        "pnpm --filter @mediator/backend exec tsx --import ./src/otel.ts src/index.ts",
      url: `${BACKEND_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: backendEnv(),
    },
    {
      // Vite dev server (not `preview`): the `/api` + `/health` proxy the journeys
      // rely on is a dev-server feature. `--strictPort` fails fast instead of
      // silently picking another port.
      command: `pnpm --filter @mediator/frontend exec vite --port ${String(FRONTEND_PORT)} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        BACKEND_ORIGIN,
      },
    },
  ],
});
