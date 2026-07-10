import { describe, expect, it } from "vitest";

import {
  collectClientIssues,
  createEmptyFormState,
  prepareRegistration,
  requiresBaseUrl,
  type RegistrationFormState,
} from "./registration-model";

function baseState(): RegistrationFormState {
  const state = createEmptyFormState();
  state.name = "Demo";
  const spec = state.specs[0];
  if (spec !== undefined) {
    spec.role = "CONSUMER";
    spec.document = { openapi: "3.0.0" };
  }
  return state;
}

describe("registration-model", () => {
  it("requires baseUrl only when a spec has the PROVIDER role", () => {
    const state = baseState();
    expect(requiresBaseUrl(state)).toBe(false);
    const spec = state.specs[0];
    if (spec !== undefined) spec.role = "PROVIDER";
    expect(requiresBaseUrl(state)).toBe(true);
  });

  it("flags a PROVIDER spec with no baseUrl", () => {
    const state = baseState();
    const spec = state.specs[0];
    if (spec !== undefined) spec.role = "PROVIDER";
    const issues = collectClientIssues(state);
    expect(issues.some((issue) => issue.path === "baseUrl")).toBe(true);
  });

  it("flags a missing name and a spec with no document", () => {
    const state = createEmptyFormState();
    const issues = collectClientIssues(state);
    expect(issues.some((issue) => issue.path === "name")).toBe(true);
    expect(issues.some((issue) => issue.path === "specs.0.document")).toBe(true);
  });

  it("requires a positive poll interval when capabilities are declared", () => {
    const state = baseState();
    state.capabilities.declare = true;
    state.capabilities.defaultPollInterval = null;
    expect(
      collectClientIssues(state).some((issue) => issue.path === "capabilities.defaultPollInterval"),
    ).toBe(true);

    state.capabilities.defaultPollInterval = 5000;
    expect(
      collectClientIssues(state).some((issue) => issue.path === "capabilities.defaultPollInterval"),
    ).toBe(false);
  });

  it("validates credential completeness per type", () => {
    const state = baseState();
    state.credentialEnabled = true;
    state.credential.type = "basicAuth";
    let issues = collectClientIssues(state);
    expect(issues.some((issue) => issue.path === "credential.secret.username")).toBe(true);
    expect(issues.some((issue) => issue.path === "credential.secret.password")).toBe(true);

    state.credential.username = "svc";
    state.credential.password = "pw";
    issues = collectClientIssues(state);
    expect(issues.some((issue) => issue.path.startsWith("credential.secret"))).toBe(false);
  });

  it("builds a request omitting optional fields when valid", () => {
    const result = prepareRegistration(baseState());
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.request).toEqual({
        name: "Demo",
        specs: [{ role: "CONSUMER", document: { openapi: "3.0.0" } }],
      });
      expect(result.request.baseUrl).toBeUndefined();
      expect(result.request.capabilities).toBeUndefined();
      expect(result.request.credential).toBeUndefined();
    }
  });

  it("builds full capabilities and a custom credential when declared", () => {
    const state = baseState();
    state.baseUrl = "https://demo.example";
    state.capabilities.declare = true;
    state.capabilities.supportsPolling = true;
    state.capabilities.defaultPollInterval = 60000;
    state.credentialEnabled = true;
    state.credential.type = "custom";
    state.credential.customEntries = [
      { key: "header", value: "X-Token" },
      { key: "", value: "ignored" },
    ];
    state.credential.scopes = "read, write";

    const result = prepareRegistration(state);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.request.baseUrl).toBe("https://demo.example");
      expect(result.request.capabilities).toEqual({
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60000,
      });
      expect(result.request.credential).toEqual({
        secret: { type: "custom", values: { header: "X-Token" } },
        scopes: ["read", "write"],
      });
    }
  });

  it("returns invalid without a request when client checks fail", () => {
    const result = prepareRegistration(createEmptyFormState());
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});
