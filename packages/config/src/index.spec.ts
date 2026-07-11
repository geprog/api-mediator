import { describe, expect, it } from "vitest";

import { ConfigValidationError, loadConfig } from "./index.js";

/** A valid dev master key: 32 bytes, standard base64 (44 chars, padded). */
const DEV_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * A minimal, fully-valid environment. Individual tests clone and mutate this so
 * each assertion isolates one variable. Values are dev-plausible but arbitrary.
 */
function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgres://mediator:mediator@localhost:5432/api_mediator",
    CREDENTIAL_MASTER_KEY: DEV_MASTER_KEY,
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_SERVICE_NAME: "api-mediator",
    MAPPING_LLM_PROVIDER: "ollama",
    OLLAMA_BASE_URL: "http://localhost:11434",
    MAPPING_LLM_MODEL: "glm-4.7-flash:latest",
    MAPPING_LLM_TEMPERATURE: "0",
    MAPPING_LLM_THINKING: "true",
    MAPPING_LLM_REQUEST_TIMEOUT_MS: "300000",
    MAPPING_LLM_MAX_RETRIES: "3",
  };
}

describe("loadConfig", () => {
  it("parses a fully-valid environment into a typed config", () => {
    const config = loadConfig(baseEnv());

    expect(config.database.url).toBe("postgres://mediator:mediator@localhost:5432/api_mediator");
    expect(config.telemetry).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318",
      protocol: "http/protobuf",
      serviceName: "api-mediator",
    });
    expect(config.mappingLlm).toEqual({
      provider: "ollama",
      ollamaBaseUrl: "http://localhost:11434",
      model: "glm-4.7-flash:latest",
      temperature: 0,
      thinking: true,
      requestTimeoutMs: 300000,
      maxRetries: 3,
    });
    // The master key is decoded to its exact 32 bytes.
    expect(config.credentials.masterKey).toBeInstanceOf(Buffer);
    expect(config.credentials.masterKey).toStrictEqual(Buffer.alloc(32, 7));
  });

  it("returns a deeply-frozen config object", () => {
    const config = loadConfig(baseEnv());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.telemetry)).toBe(true);
    expect(Object.isFrozen(config.mappingLlm)).toBe(true);
    expect(Object.isFrozen(config.credentials)).toBe(true);
  });

  describe("HTTP_PORT", () => {
    it("defaults to 3333 when HTTP_PORT is absent", () => {
      const env = baseEnv();
      delete env.HTTP_PORT;

      expect(loadConfig(env).http).toEqual({ port: 3333 });
    });

    it("coerces a provided HTTP_PORT from its string value", () => {
      expect(loadConfig({ ...baseEnv(), HTTP_PORT: "4000" }).http.port).toBe(4000);
    });

    it("rejects a non-integer or out-of-range HTTP_PORT", () => {
      expect(() => loadConfig({ ...baseEnv(), HTTP_PORT: "3333.5" })).toThrow(/HTTP_PORT/);
      expect(() => loadConfig({ ...baseEnv(), HTTP_PORT: "0" })).toThrow(/HTTP_PORT/);
      expect(() => loadConfig({ ...baseEnv(), HTTP_PORT: "70000" })).toThrow(/HTTP_PORT/);
    });
  });

  it("throws a helpful error when DATABASE_URL is missing", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it("rejects a DATABASE_URL that is not a postgres URL", () => {
    const env = { ...baseEnv(), DATABASE_URL: "mysql://localhost:3306/db" };

    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  describe("CREDENTIAL_MASTER_KEY", () => {
    it("throws a helpful error when it is missing (no default — fail fast)", () => {
      const env = baseEnv();
      delete env.CREDENTIAL_MASTER_KEY;

      expect(() => loadConfig(env)).toThrow(ConfigValidationError);
      expect(() => loadConfig(env)).toThrow(/CREDENTIAL_MASTER_KEY/);
    });

    it("rejects a key that decodes to fewer than 32 bytes", () => {
      const env = { ...baseEnv(), CREDENTIAL_MASTER_KEY: Buffer.alloc(16, 7).toString("base64") };

      expect(() => loadConfig(env)).toThrow(/CREDENTIAL_MASTER_KEY/);
    });

    it("rejects a key that decodes to more than 32 bytes", () => {
      const env = { ...baseEnv(), CREDENTIAL_MASTER_KEY: Buffer.alloc(48, 7).toString("base64") };

      expect(() => loadConfig(env)).toThrow(/CREDENTIAL_MASTER_KEY/);
    });

    it("rejects a key that is not valid base64", () => {
      const env = { ...baseEnv(), CREDENTIAL_MASTER_KEY: "not valid base64 !!!" };

      expect(() => loadConfig(env)).toThrow(/CREDENTIAL_MASTER_KEY/);
    });

    it("never echoes the key value in the validation message", () => {
      const secretish = "こんにちは-not-base64";
      const env = { ...baseEnv(), CREDENTIAL_MASTER_KEY: secretish };

      let message = "";
      try {
        loadConfig(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("CREDENTIAL_MASTER_KEY");
      expect(message).not.toContain(secretish);
    });
  });

  it("aggregates every missing/invalid variable in one error", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    delete env.OLLAMA_BASE_URL;
    delete env.MAPPING_LLM_REQUEST_TIMEOUT_MS;

    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("OLLAMA_BASE_URL");
    expect(message).toContain("MAPPING_LLM_REQUEST_TIMEOUT_MS");
  });

  describe("telemetry disabled state", () => {
    it("treats an empty OTEL_EXPORTER_OTLP_ENDPOINT as disabled", () => {
      const config = loadConfig({ ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: "" });

      expect(config.telemetry.enabled).toBe(false);
      expect(config.telemetry).toEqual({ enabled: false });
    });

    it("treats an absent OTEL_EXPORTER_OTLP_ENDPOINT as disabled", () => {
      const env = baseEnv();
      delete env.OTEL_EXPORTER_OTLP_ENDPOINT;

      const config = loadConfig(env);

      expect(config.telemetry.enabled).toBe(false);
    });

    it("rejects a non-empty endpoint that is not an http(s) URL", () => {
      const env = { ...baseEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" };

      expect(() => loadConfig(env)).toThrow(/OTEL_EXPORTER_OTLP_ENDPOINT/);
    });
  });

  describe("coercion of LLM variables", () => {
    it("coerces MAPPING_LLM_THINKING from the literal strings", () => {
      expect(loadConfig({ ...baseEnv(), MAPPING_LLM_THINKING: "true" }).mappingLlm.thinking).toBe(
        true,
      );
      expect(loadConfig({ ...baseEnv(), MAPPING_LLM_THINKING: "false" }).mappingLlm.thinking).toBe(
        false,
      );
    });

    it("rejects a MAPPING_LLM_THINKING value that is not true/false", () => {
      const env = { ...baseEnv(), MAPPING_LLM_THINKING: "yes" };

      expect(() => loadConfig(env)).toThrow(/MAPPING_LLM_THINKING/);
    });

    it("coerces numeric variables from strings", () => {
      const config = loadConfig({
        ...baseEnv(),
        MAPPING_LLM_TEMPERATURE: "0.7",
        MAPPING_LLM_REQUEST_TIMEOUT_MS: "120000",
        MAPPING_LLM_MAX_RETRIES: "5",
      });

      expect(config.mappingLlm.temperature).toBe(0.7);
      expect(config.mappingLlm.requestTimeoutMs).toBe(120000);
      expect(config.mappingLlm.maxRetries).toBe(5);
    });

    it("rejects a non-integer MAPPING_LLM_MAX_RETRIES", () => {
      const env = { ...baseEnv(), MAPPING_LLM_MAX_RETRIES: "2.5" };

      expect(() => loadConfig(env)).toThrow(/MAPPING_LLM_MAX_RETRIES/);
    });

    it("carries ANTHROPIC_API_KEY onto mappingLlm when set", () => {
      const config = loadConfig({ ...baseEnv(), ANTHROPIC_API_KEY: "sk-ant-test" });

      expect(config.mappingLlm.anthropicApiKey).toBe("sk-ant-test");
    });

    it("omits anthropicApiKey (rather than setting undefined) when unset", () => {
      const config = loadConfig(baseEnv());

      expect(config.mappingLlm.anthropicApiKey).toBeUndefined();
      expect("anthropicApiKey" in config.mappingLlm).toBe(false);
    });

    it("rejects an empty ANTHROPIC_API_KEY", () => {
      const env = { ...baseEnv(), ANTHROPIC_API_KEY: "" };

      expect(() => loadConfig(env)).toThrow(/ANTHROPIC_API_KEY/);
    });
  });

  describe("defaults", () => {
    it("applies defaults for omitted optional variables", () => {
      const env = baseEnv();
      delete env.OTEL_EXPORTER_OTLP_PROTOCOL;
      delete env.OTEL_SERVICE_NAME;
      delete env.MAPPING_LLM_PROVIDER;
      delete env.MAPPING_LLM_TEMPERATURE;
      delete env.MAPPING_LLM_MAX_RETRIES;

      const config = loadConfig(env);

      expect(config.telemetry).toEqual({
        enabled: true,
        endpoint: "http://localhost:4318",
        protocol: "http/protobuf",
        serviceName: "api-mediator",
      });
      expect(config.mappingLlm.provider).toBe("ollama");
      expect(config.mappingLlm.temperature).toBe(0);
      expect(config.mappingLlm.maxRetries).toBe(3);
    });

    it("defaults registration.defaultPollInterval to 300000 ms when omitted", () => {
      const env = baseEnv();
      delete env.MEDIATOR_DEFAULT_POLL_INTERVAL_MS;

      expect(loadConfig(env).registration).toEqual({ defaultPollInterval: 300000 });
    });

    it("coerces a provided MEDIATOR_DEFAULT_POLL_INTERVAL_MS from its string value", () => {
      const config = loadConfig({ ...baseEnv(), MEDIATOR_DEFAULT_POLL_INTERVAL_MS: "60000" });

      expect(config.registration.defaultPollInterval).toBe(60000);
    });

    it("rejects a non-positive MEDIATOR_DEFAULT_POLL_INTERVAL_MS", () => {
      expect(() => loadConfig({ ...baseEnv(), MEDIATOR_DEFAULT_POLL_INTERVAL_MS: "0" })).toThrow(
        /MEDIATOR_DEFAULT_POLL_INTERVAL_MS/,
      );
    });
  });
});
