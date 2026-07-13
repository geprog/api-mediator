import type { UsableCredentialSecret } from "@mediator/credentials";
import { describe, expect, it } from "vitest";

import { createCredentialApplier } from "./credential-applier.js";

describe("createCredentialApplier", () => {
  it("apiKey → the configured header + scheme (default Authorization: Bearer)", () => {
    const apply = createCredentialApplier();
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "k-123" };
    expect(apply({}, secret)).toStrictEqual({ authorization: "Bearer k-123" });
  });

  it("apiKey → a custom header with no scheme (the X-API-Key convention)", () => {
    const apply = createCredentialApplier({ apiKeyHeader: "X-API-Key", apiKeyScheme: "" });
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "k-123" };
    // The header is lower-cased (matching the response-header convention); no scheme prefix.
    expect(apply({}, secret)).toStrictEqual({ "x-api-key": "k-123" });
  });

  it("oauth2 → Authorization: Bearer <accessToken>", () => {
    const apply = createCredentialApplier();
    const secret: UsableCredentialSecret = { type: "oauth2", accessToken: "at-9" };
    expect(apply({}, secret)).toStrictEqual({ authorization: "Bearer at-9" });
  });

  it("basicAuth → Authorization: Basic base64(user:pass)", () => {
    const apply = createCredentialApplier();
    const secret: UsableCredentialSecret = { type: "basicAuth", username: "u", password: "p" };
    const expected = `Basic ${Buffer.from("u:p", "utf8").toString("base64")}`;
    expect(apply({}, secret)).toStrictEqual({ authorization: expected });
  });

  it("custom → each value applied verbatim under a lower-cased header key", () => {
    const apply = createCredentialApplier();
    const secret: UsableCredentialSecret = {
      type: "custom",
      values: { "X-Token": "t", "X-Tenant": "acme" },
    };
    expect(apply({}, secret)).toStrictEqual({ "x-token": "t", "x-tenant": "acme" });
  });

  it("preserves caller headers and overrides on collision", () => {
    const apply = createCredentialApplier();
    const secret: UsableCredentialSecret = { type: "apiKey", apiKey: "k" };
    expect(apply({ accept: "application/json", authorization: "stale" }, secret)).toStrictEqual({
      accept: "application/json",
      authorization: "Bearer k",
    });
  });
});
