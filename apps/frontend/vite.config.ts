import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

/**
 * Vite dev/build config for `@mediator/frontend`.
 *
 * Dev proxy: the browser calls same-origin paths (`/health`, `/api/*`) and the
 * Vite dev server forwards them to the operator API so there is no CORS setup.
 * The operator API listens on `HTTP_PORT` (default 3333, bound to 127.0.0.1 —
 * see `.env.example` / `apps/backend`). Override with `BACKEND_ORIGIN` when the
 * backend runs elsewhere. `/api` is reserved for future operator routes; only
 * `/health` is live in Phase 0. NOTE: `/health` is green only when Postgres is
 * up (`scripts/dev-up.sh`) and the backend is running.
 */
const BACKEND_ORIGIN = process.env["BACKEND_ORIGIN"] ?? "http://localhost:3333";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/health": { target: BACKEND_ORIGIN, changeOrigin: true },
      "/api": { target: BACKEND_ORIGIN, changeOrigin: true },
    },
  },
});
