import type { SessionRole } from "@mediator/contracts";

/**
 * Single source of truth for the e2e run's ports, backend environment, and the
 * seeded operator/viewer accounts — imported by both `playwright.config.ts` (to
 * boot the backend + frontend web servers) and the specs (to authenticate, to
 * reach the DB, and to make authenticated API assertions).
 *
 * The whole backend environment is supplied **here**, not from a repo `.env`, so
 * an e2e run is self-contained and deterministic: the accounts (and therefore the
 * login credentials the specs use) are fixed, and no developer's local `.env` can
 * change what the suite authenticates against. Nothing here is a real secret — the
 * master key is the committed dev sample and the password hashes are the committed
 * `.env.example` dev samples (their plaintexts live in `OPERATOR`/`VIEWER` below).
 */

/** Dedicated test ports, clear of the dev servers (Vite 5173 / backend 3333). */
export const BACKEND_PORT = 3433;
export const FRONTEND_PORT = 5273;
export const BACKEND_ORIGIN = `http://localhost:${String(BACKEND_PORT)}`;
export const BASE_URL = `http://localhost:${String(FRONTEND_PORT)}`;

/**
 * The **Adapter Server Runtime** listener port for the e2e backend (Phase-5 RT-1) —
 * a dedicated test port clear of the operator API (3433) and the dev default (3334).
 *
 * The generated adapter surface is **one** Fastify listener in the same backend
 * process (`config.adapterHttp.port`, see `apps/backend/src/index.ts`) that hosts
 * **every** active CONSUMER spec's surface and routes each request to its consumer
 * app by the presented adapter **token** — never by port. The scenario READMEs
 * reserve host ports `13900` (scenario-3) / `14900` (scenario-4) for "the mediator's
 * adapter server", but those are per-landscape *notional* ports: a single mediator
 * process binds one adapter port and serves both consumer surfaces on it,
 * disambiguated by token→app (RT-2.3). The CU-5 capstone therefore calls this one
 * origin with the scenario's token; which consumer surface answers is decided by the
 * token, exactly as production decides it. */
export const ADAPTER_PORT = 3534;
export const ADAPTER_ORIGIN = `http://localhost:${String(ADAPTER_PORT)}`;

/**
 * The compose Postgres the backend connects to and the specs seed/inspect
 * directly. A **dedicated** database (`api_mediator_e2e`) on the compose Postgres,
 * kept separate from the primary `api_mediator` dev database so an e2e run is
 * isolated and its schema is migrated independently. Overridable via `DATABASE_URL`.
 */
export const DATABASE_URL: string =
  process.env["DATABASE_URL"] ?? "postgres://mediator:mediator@localhost:5432/api_mediator_e2e";

/** A test operator/viewer account: the plaintext password lives only in test code. */
export interface TestAccount {
  readonly username: string;
  readonly password: string;
  readonly role: SessionRole;
}

/**
 * The mutating identity for the journeys. Its salted-scrypt hash is seeded into
 * `OPERATOR_ACCOUNTS` below; the plaintext here is what the login page submits.
 */
export const OPERATOR: TestAccount = {
  username: "operator",
  password: "operator-dev-password",
  role: "operator",
};

/** The read-only identity, for the read/mutate-split assertions (OA-2 / RU-5 crit 4). */
export const VIEWER: TestAccount = {
  username: "viewer",
  password: "viewer-dev-password",
  role: "viewer",
};

/**
 * `OPERATOR_ACCOUNTS` seeding the two accounts above (the committed `.env.example`
 * dev samples: salted scrypt hashes of `operator-dev-password` / `viewer-dev-password`,
 * never plaintext). Format: comma-separated `username:role:passwordHash`.
 */
export const OPERATOR_ACCOUNTS_ENV: string =
  "operator:operator:scrypt$16384$8$1$64$w2bnVOl/1VWnBYFUjy/K7A==$lLv52mSP/+MG2mV3vG5ES77GmXaUt9di9UO7ll5GOEGMI8goQvbZpATut+xQH/ejoFD7ON6HKI/HcZXO+YIJMA==," +
  "viewer:viewer:scrypt$16384$8$1$64$rxlWdhOmYgMWJOo400l5UA==$8RnU5a8lW/XwF3qXcn7oNYHuxdxzhEWXjmVGbuweFupc4jHIHdocfl4uj0YnxpX/+qccycTHZ2HTewwHqZjvIA==";

/**
 * The dev-sample Credential Store master key (32 bytes base64) — not a real secret.
 * Exported so the SU-6 landscape seed can encrypt the scenario tokens under the **same**
 * key the backend boots with (they must match, or `withCredential` cannot decrypt).
 */
export const CREDENTIAL_MASTER_KEY = "nuaKgT2sF/l6wkVY8+Qb8bMGHE0T+wee0CxRJCAzNCE=";

/**
 * The full backend environment for the Playwright `webServer`. Every variable
 * `loadConfig` requires is supplied explicitly so the backend boots without a repo
 * `.env`. The LLM variables are present-and-valid but never exercised — RU-5 replays
 * a seeded proposal fixture, so no model is contacted; the short request timeout
 * makes any accidental call fail fast rather than hang.
 */
export function backendEnv(): Record<string, string> {
  return {
    HTTP_PORT: String(BACKEND_PORT),
    // The Adapter Server Runtime listener (RT-1) on its own dedicated test port, so
    // the CU-5 capstone can call the generated adapter surface. Off the operator port
    // and the dev default (3334); inert for the non-adapter journeys.
    ADAPTER_HTTP_PORT: String(ADAPTER_PORT),
    DATABASE_URL,
    CREDENTIAL_MASTER_KEY,
    OPERATOR_ACCOUNTS: OPERATOR_ACCOUNTS_ENV,
    // Telemetry export disabled so the run has no dependency on the Grafana container.
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    // TEST/DEV-ONLY: register the deterministic poll-trigger endpoint
    // (`POST /api/sync-rules/:id/poll`) the SU-6 capstone landscape journey drives one
    // poll cycle at a time through. Off in production/dev; the route 404s without it.
    // Registering it is inert for the non-landscape journeys (they never call it).
    SYNC_TEST_POLL_TRIGGER: "true",
    // LLM config: valid but unused (the journey replays a seeded proposal).
    MAPPING_LLM_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://localhost:11434",
    MAPPING_LLM_MODEL: "e2e-fixture-model",
    MAPPING_LLM_THINKING: "false",
    MAPPING_LLM_REQUEST_TIMEOUT_MS: "2000",
  };
}

/** The Basic `Authorization` header value for a test account (UTF-8 base64). */
export function basicAuthHeader(account: TestAccount): string {
  const encoded = Buffer.from(`${account.username}:${account.password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}
