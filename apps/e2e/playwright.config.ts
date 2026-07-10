import { defineConfig, devices } from "@playwright/test";

/**
 * Phase-1 Playwright config: the registration journey drives the **real** Vue UI
 * against the **real** Fastify operator API and the compose Postgres.
 *
 * Everything runs on dedicated test ports so a run never disturbs a developer's
 * own dev server (Vite on 5173) or backend (3333):
 *
 * - backend  → `HTTP_PORT=3433`, telemetry export disabled (empty OTLP endpoint)
 * - frontend → Vite **dev** server on `5273` (the `/api` + `/health` proxy is a
 *   dev-server feature), pointed at the test backend via `BACKEND_ORIGIN`.
 *
 * Both are started by Playwright's `webServer` and torn down after the run.
 * `reuseExistingServer: false` guarantees a fresh, known-state server (and fails
 * loudly if the port is already taken). The DB is the shared compose Postgres, so
 * tests self-isolate by registering apps under unique names and asserting only on
 * their own app id (see `support/fixtures.ts`).
 */

const BACKEND_PORT = 3433;
const FRONTEND_PORT = 5273;
const BACKEND_ORIGIN = `http://localhost:${String(BACKEND_PORT)}`;
const BASE_URL = `http://localhost:${String(FRONTEND_PORT)}`;

export default defineConfig({
  testDir: "./tests",
  // A shared backend + Postgres is single-writer state; keep the journeys serial
  // and deterministic rather than racing registrations through one API.
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
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      // Operator API on a dedicated port; telemetry export disabled so the run
      // has no dependency on the Grafana LGTM container.
      command: "pnpm --filter @mediator/backend exec tsx --import ./src/otel.ts src/index.ts",
      url: `${BACKEND_ORIGIN}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        HTTP_PORT: String(BACKEND_PORT),
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      },
    },
    {
      // Vite dev server (not `preview`): the `/api` + `/health` proxy the journey
      // relies on is a dev-server feature. `--strictPort` fails fast instead of
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
