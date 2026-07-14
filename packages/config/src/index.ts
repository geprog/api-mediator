import { z } from "zod";

/**
 * `@mediator/config` — the single, typed, validated view of the process
 * environment for the API Mediator.
 *
 * `loadConfig` parses `process.env` (or an injected env for tests) with Zod,
 * fails fast with an aggregated error listing every missing/invalid variable,
 * and returns a deeply-frozen `AppConfig`. It covers exactly the variables the
 * app consumes; container-only variables (`POSTGRES_*`, `GRAFANA_PORT`) belong
 * to `docker-compose.yml`, not here.
 */

// ── Public config shapes ────────────────────────────────────────────────────

/**
 * The only OTLP transport the mediator wires up. HTTP/protobuf deliberately
 * avoids native gRPC dependencies (see the `.env.example` rationale and
 * `docs/architecture/observability.md`); the field is validated to this single
 * value so an unsupported protocol fails fast rather than being silently
 * ignored by the telemetry bootstrap.
 */
export type OtlpProtocol = "http/protobuf";

export interface DatabaseConfig {
  readonly url: string;
}

/**
 * Telemetry as a discriminated union so callers branch on `enabled` type-safely
 * instead of inspecting an empty endpoint string. An empty or absent
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is a supported "disabled" state — the mediator
 * functions correctly with the telemetry pipeline down
 * (`docs/architecture/observability.md`).
 */
export type TelemetryConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly endpoint: string;
      readonly protocol: OtlpProtocol;
      readonly serviceName: string;
    };

export interface MappingLlmConfig {
  readonly provider: string;
  readonly ollamaBaseUrl: string;
  readonly model: string;
  readonly temperature: number;
  readonly thinking: boolean;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  /**
   * The confidence threshold (`0..1`) below which a `MappingProposalItem` is
   * flagged `reviewRequired` in the Phase-3 review UI (`MAPPING_LLM_REVIEW_THRESHOLD`,
   * default `0.7`). `reviewRequired` is **derived** against this value, never a
   * stored column, so changing the threshold re-flags every item without a
   * re-analysis (Phase-2 TD-5 / `docs/architecture/mapping-engine.md`
   * "Confidence & ambiguity").
   */
  readonly reviewThreshold: number;
  /**
   * API key for the Anthropic provider (`ANTHROPIC_API_KEY`). Optional: only the
   * `anthropic` provider needs it, and it is absent when unset so an Ollama-only
   * deployment never has to supply one. The `AnthropicProvider` fails fast when it
   * is missing.
   */
  readonly anthropicApiKey?: string;
}

/** The operator API/UI HTTP surface served by `apps/backend`. */
export interface HttpConfig {
  readonly port: number;
}

/**
 * App-registration defaults. `defaultPollInterval` (milliseconds) is the
 * conservative fallback stamped onto a `RegisteredApp.capabilities` when a
 * registration omits `capabilities` entirely (AR-1 criterion 2 / open question
 * 2): all capability flags default false and the poll interval defaults here. It
 * is not yet *consumed* in Phase 1 (the Sync Engine's Scheduler is Phase 4); this
 * is where its landscape-wide default lives.
 */
export interface RegistrationConfig {
  readonly defaultPollInterval: number;
}

/**
 * Credential Store configuration. `masterKey` is the decoded 32-byte master
 * key (KEK) that wraps each credential's data key (see
 * `docs/architecture/security.md` and `@mediator/credentials`). Held as a
 * `Buffer` so consumers never re-parse the encoding; it is validated to exactly
 * 32 bytes at load time so a misconfigured deployment fails fast.
 */
export interface CredentialsConfig {
  readonly masterKey: Buffer;
}

/**
 * The two operator-API authorization roles (see `docs/glossary.md`
 * `Operator / Viewer` and `docs/architecture/security.md`). `operator` may
 * mutate the landscape; `viewer` is read-only. Deliberately exactly two — the
 * single-tenant deployment model has no tenant hierarchy or finer permissions.
 */
export const operatorRoleSchema = z.enum(["operator", "viewer"]);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

/**
 * One seeded local operator account. The password is held **only** as a salted
 * hash (`@mediator/credentials` scrypt encoding) — never in plaintext — so the
 * "no plaintext at rest" invariant holds even in the process environment: the
 * mediator receives a hash, not a password (`docs/architecture/security.md`
 * *Operator authentication & authorization*).
 */
export interface OperatorAccount {
  readonly username: string;
  readonly role: OperatorRole;
  readonly passwordHash: string;
}

/**
 * Operator-authentication configuration. Phase 3 ships the local-accounts
 * provider seeded from `OPERATOR_ACCOUNTS`; a later SSO/OIDC provider replaces
 * the provider without touching this shape's consumers.
 */
export interface AuthConfig {
  readonly accounts: readonly OperatorAccount[];
}

/**
 * Sync Engine configuration.
 *
 * `testPollTrigger` gates a **test/dev-only** HTTP affordance: when true the
 * operator API registers `POST /api/sync-rules/:id/poll`, which forces exactly one
 * deterministic poll cycle for a rule (detect → enqueue → advance). The SU-6
 * capstone e2e drives the running backend over HTTP and cannot cleanly assert
 * "no echo / no duplicate write" against the Scheduler's wall-clock interval, so it
 * triggers a poll on demand instead (the SP-5 poll-trigger hook — a test seam, not
 * concept behavior; see `docs/requirements/phase-4-scheduler-poller.md`).
 *
 * It is **not** an operator feature and MUST stay off (the default) in production
 * and dev: with the flag false/unset the route is not registered at all, so a
 * request 404s. Only the e2e's backend environment sets it true.
 */
export interface SyncConfig {
  readonly testPollTrigger: boolean;
}

export interface AppConfig {
  readonly http: HttpConfig;
  readonly database: DatabaseConfig;
  readonly telemetry: TelemetryConfig;
  readonly mappingLlm: MappingLlmConfig;
  readonly credentials: CredentialsConfig;
  readonly registration: RegistrationConfig;
  readonly auth: AuthConfig;
  readonly sync: SyncConfig;
}

/** Thrown by {@link loadConfig} when the environment fails validation. */
export class ConfigValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

const POSTGRES_PROTOCOLS = ["postgres:", "postgresql:"] as const;
const HTTP_PROTOCOLS = ["http:", "https:"] as const;

function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return protocols.includes(parsed.protocol);
}

/**
 * Human-readable validation message for an invalid `DATABASE_URL`. Exported
 * alongside {@link isPostgresConnectionUrl} so `@mediator/db` reuses the exact
 * same wording when it rejects a bad URL.
 */
export const POSTGRES_URL_MESSAGE = "must be a postgres:// or postgresql:// connection URL";

/**
 * True when `value` is a `postgres://` / `postgresql://` connection URL — the
 * single source of truth for what a valid `DATABASE_URL` looks like.
 *
 * `loadConfig` uses it to validate the environment here, and `@mediator/db`
 * reuses it (migrate CLI + `resolveDatabaseUrl`) so both entrypoints accept and
 * reject identical URLs. Deliberately a standalone predicate: importing it never
 * triggers the full `loadConfig` env validation (e.g. the LLM variables).
 */
export function isPostgresConnectionUrl(value: string): boolean {
  return isUrlWithProtocol(value, POSTGRES_PROTOCOLS);
}

/**
 * Boolean env vars carry the literal strings `"true"`/`"false"`; `z.coerce.boolean`
 * would treat any non-empty string (including `"false"`) as `true`, so parse the
 * two literals explicitly instead.
 */
const booleanFromEnv = z.enum(["true", "false"]).transform((value) => value === "true");

/** The Credential Store master key (KEK) length: 32 bytes for AES-256-GCM. */
const MASTER_KEY_LENGTH_BYTES = 32;
/** Standard (padded) base64 — rejects whitespace and non-base64 characters. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Human-readable validation message for an invalid `CREDENTIAL_MASTER_KEY`. */
export const CREDENTIAL_MASTER_KEY_MESSAGE =
  "must be a base64-encoded 32-byte key (e.g. `openssl rand -base64 32`)";

/**
 * Decode `CREDENTIAL_MASTER_KEY` from standard base64 into exactly 32 bytes, or
 * return `null` when it is not canonical base64 or not 32 bytes. The re-encode
 * comparison rejects the inputs Node's lenient base64 decoder would otherwise
 * silently truncate, so validation is precise rather than best-effort.
 */
function decodeMasterKey(value: string): Buffer | null {
  if (!BASE64_PATTERN.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || decoded.length !== MASTER_KEY_LENGTH_BYTES) {
    return null;
  }
  return decoded;
}

/** Human-readable validation message for a missing/invalid `OPERATOR_ACCOUNTS`. */
export const OPERATOR_ACCOUNTS_MESSAGE =
  "must be a comma-separated list of `username:role:passwordHash` entries (role = operator|viewer; passwordHash = a salted scrypt hash, never a plaintext password)";

/**
 * Structural check that a seeded password hash looks like the salted scrypt
 * encoding produced by `@mediator/credentials`
 * (`scrypt$N$r$p$keyLen$saltBase64$hashBase64`). Deliberately shallow — the auth
 * provider does the real constant-time verification — and kept import-free so
 * `@mediator/config` stays a leaf package (credentials depends on config, not
 * the reverse).
 */
const ENCODED_HASH_PATTERN =
  /^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/;

/** The outcome of parsing the `OPERATOR_ACCOUNTS` string into typed accounts. */
type AccountsResult =
  | { readonly ok: true; readonly accounts: OperatorAccount[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `OPERATOR_ACCOUNTS` (`username:role:passwordHash`, comma-separated) into
 * typed {@link OperatorAccount}s. A username and role contain no `:`; the hash's
 * base64/`$` alphabet contains no `:` either, so splitting each entry on its
 * first two colons is unambiguous. Error messages reference entries by 1-based
 * index only — never echoing the entry — so a mistyped value can never leak into
 * a config error or log.
 */
function parseOperatorAccounts(raw: string): AccountsResult {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return {
      ok: false,
      message: `${OPERATOR_ACCOUNTS_MESSAGE} — at least one account is required`,
    };
  }

  const accounts: OperatorAccount[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const position = `account #${String(index + 1)}`;
    const firstColon = entry.indexOf(":");
    const secondColon = firstColon === -1 ? -1 : entry.indexOf(":", firstColon + 1);
    if (firstColon <= 0 || secondColon === -1 || secondColon === entry.length - 1) {
      return { ok: false, message: `${position} is not \`username:role:passwordHash\`` };
    }
    const username = entry.slice(0, firstColon);
    const role = operatorRoleSchema.safeParse(entry.slice(firstColon + 1, secondColon));
    if (!role.success) {
      return { ok: false, message: `${position} has an invalid role (expected operator|viewer)` };
    }
    const passwordHash = entry.slice(secondColon + 1);
    if (!ENCODED_HASH_PATTERN.test(passwordHash)) {
      return {
        ok: false,
        message: `${position} passwordHash is not a salted scrypt hash (never put a plaintext password here)`,
      };
    }
    if (seen.has(username)) {
      return { ok: false, message: `${position} duplicates operator username "${username}"` };
    }
    seen.add(username);
    accounts.push({ username, role: role.data, passwordHash });
  }
  return { ok: true, accounts };
}

const envSchema = z
  .object({
    // Operator API/UI HTTP server. Default 3333 is kept clear of Grafana's 3000
    // (GRAFANA_PORT) to avoid a dev clash.
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3333),

    // Database
    DATABASE_URL: z.string().refine(isPostgresConnectionUrl, { error: POSTGRES_URL_MESSAGE }),

    // Credential Store master key (KEK) — required, no default. Production must set
    // a real secret; `.env.example` ships a dev-only sample. Validated to exactly
    // 32 base64-decoded bytes so a misconfigured key fails fast at startup.
    CREDENTIAL_MASTER_KEY: z
      .string()
      .refine((v) => decodeMasterKey(v) !== null, { error: CREDENTIAL_MASTER_KEY_MESSAGE }),

    // Telemetry — empty endpoint means telemetry is disabled (a supported state).
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .default("")
      .refine((v) => v === "" || isUrlWithProtocol(v, HTTP_PROTOCOLS), {
        error: "must be empty (telemetry disabled) or an http(s):// URL",
      }),
    OTEL_EXPORTER_OTLP_PROTOCOL: z.enum(["http/protobuf"]).default("http/protobuf"),
    OTEL_SERVICE_NAME: z.string().min(1).default("api-mediator"),

    // Mapping LLM provider
    MAPPING_LLM_PROVIDER: z.string().min(1).default("ollama"),
    OLLAMA_BASE_URL: z.string().refine((v) => isUrlWithProtocol(v, HTTP_PROTOCOLS), {
      error: "must be an http(s):// URL",
    }),
    MAPPING_LLM_MODEL: z.string().min(1),
    MAPPING_LLM_TEMPERATURE: z.coerce.number().min(0).default(0),
    MAPPING_LLM_THINKING: booleanFromEnv,
    MAPPING_LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive(),
    MAPPING_LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
    MAPPING_LLM_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

    // API key for the Anthropic provider. Optional at the env layer (only the
    // `anthropic` provider consumes it); the AnthropicProvider fails fast if it is
    // required but absent.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),

    // Registration defaults. The conservative default poll interval (ms) stamped
    // onto a RegisteredApp's capabilities when a registration omits capabilities
    // (AR-1 crit 2). Defaults to 300000 ms (300 s); consumed by the Phase-4 Sync
    // Engine Scheduler.
    MEDIATOR_DEFAULT_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(300000),

    // Operator-API local accounts — required, no default. The Phase-3 auth
    // provider seeds its accounts from this; there is deliberately no
    // unauthenticated mode (docs/architecture/security.md). Comma-separated
    // `username:role:passwordHash`, where passwordHash is a salted scrypt hash
    // (never a plaintext password). Structure is validated by the superRefine
    // below so a misconfigured value fails fast at startup.
    OPERATOR_ACCOUNTS: z.string({ error: OPERATOR_ACCOUNTS_MESSAGE }),

    // Sync Engine. SYNC_TEST_POLL_TRIGGER gates the TEST/DEV-ONLY deterministic
    // poll-trigger endpoint (POST /api/sync-rules/:id/poll — the SP-5 hook the SU-6
    // e2e drives). Default false — it MUST stay off in production and dev, where the
    // route is then not registered at all (a request 404s); only the e2e sets it true.
    SYNC_TEST_POLL_TRIGGER: booleanFromEnv.default(false),
  })
  .superRefine((env, ctx) => {
    // When OPERATOR_ACCOUNTS itself failed type validation (missing), the field
    // check already reported it — skip so parsing never runs on a non-string.
    if (typeof env.OPERATOR_ACCOUNTS !== "string") {
      return;
    }
    const result = parseOperatorAccounts(env.OPERATOR_ACCOUNTS);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message, path: ["OPERATOR_ACCOUNTS"] });
    }
  });

type RawEnv = z.infer<typeof envSchema>;

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join("\n")}`;
}

function toTelemetryConfig(raw: RawEnv): TelemetryConfig {
  if (raw.OTEL_EXPORTER_OTLP_ENDPOINT === "") {
    return { enabled: false };
  }
  return {
    enabled: true,
    endpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT,
    protocol: raw.OTEL_EXPORTER_OTLP_PROTOCOL,
    serviceName: raw.OTEL_SERVICE_NAME,
  };
}

function toCredentialsConfig(raw: RawEnv): CredentialsConfig {
  const masterKey = decodeMasterKey(raw.CREDENTIAL_MASTER_KEY);
  if (masterKey === null) {
    // Unreachable: the schema refine already validated encoding and length.
    throw new ConfigValidationError(`CREDENTIAL_MASTER_KEY ${CREDENTIAL_MASTER_KEY_MESSAGE}`);
  }
  return { masterKey };
}

function toAuthConfig(raw: RawEnv): AuthConfig {
  const result = parseOperatorAccounts(raw.OPERATOR_ACCOUNTS);
  if (!result.ok) {
    // Unreachable: the schema superRefine already validated the structure.
    throw new ConfigValidationError(`OPERATOR_ACCOUNTS ${result.message}`);
  }
  return { accounts: result.accounts };
}

function toAppConfig(raw: RawEnv): AppConfig {
  return {
    http: { port: raw.HTTP_PORT },
    database: { url: raw.DATABASE_URL },
    telemetry: toTelemetryConfig(raw),
    mappingLlm: {
      provider: raw.MAPPING_LLM_PROVIDER,
      ollamaBaseUrl: raw.OLLAMA_BASE_URL,
      model: raw.MAPPING_LLM_MODEL,
      temperature: raw.MAPPING_LLM_TEMPERATURE,
      thinking: raw.MAPPING_LLM_THINKING,
      requestTimeoutMs: raw.MAPPING_LLM_REQUEST_TIMEOUT_MS,
      maxRetries: raw.MAPPING_LLM_MAX_RETRIES,
      reviewThreshold: raw.MAPPING_LLM_REVIEW_THRESHOLD,
      // Conditional spread, never an explicit `undefined` (exactOptionalPropertyTypes).
      ...(raw.ANTHROPIC_API_KEY !== undefined ? { anthropicApiKey: raw.ANTHROPIC_API_KEY } : {}),
    },
    credentials: toCredentialsConfig(raw),
    registration: { defaultPollInterval: raw.MEDIATOR_DEFAULT_POLL_INTERVAL_MS },
    auth: toAuthConfig(raw),
    sync: { testPollTrigger: raw.SYNC_TEST_POLL_TRIGGER },
  };
}

function freezeConfig(config: AppConfig): AppConfig {
  Object.freeze(config.http);
  Object.freeze(config.database);
  Object.freeze(config.telemetry);
  Object.freeze(config.mappingLlm);
  Object.freeze(config.credentials);
  Object.freeze(config.registration);
  Object.freeze(config.auth);
  Object.freeze(config.sync);
  Object.freeze(config.auth.accounts);
  for (const account of config.auth.accounts) {
    Object.freeze(account);
  }
  return Object.freeze(config);
}

/**
 * Parse and validate the environment into a frozen {@link AppConfig}.
 *
 * @param env - the environment to read; defaults to `process.env`. Injectable so
 *   tests never mutate the real process environment.
 * @throws {ConfigValidationError} if any required variable is missing or invalid;
 *   the message aggregates every offending variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(formatIssues(result.error));
  }
  return freezeConfig(toAppConfig(result.data));
}
