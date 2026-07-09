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
}

export interface AppConfig {
  readonly database: DatabaseConfig;
  readonly telemetry: TelemetryConfig;
  readonly mappingLlm: MappingLlmConfig;
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
 * Boolean env vars carry the literal strings `"true"`/`"false"`; `z.coerce.boolean`
 * would treat any non-empty string (including `"false"`) as `true`, so parse the
 * two literals explicitly instead.
 */
const booleanFromEnv = z.enum(["true", "false"]).transform((value) => value === "true");

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().refine((v) => isUrlWithProtocol(v, POSTGRES_PROTOCOLS), {
    error: "must be a postgres:// or postgresql:// connection URL",
  }),

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

function toAppConfig(raw: RawEnv): AppConfig {
  return {
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
    },
  };
}

function freezeConfig(config: AppConfig): AppConfig {
  Object.freeze(config.database);
  Object.freeze(config.telemetry);
  Object.freeze(config.mappingLlm);
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
