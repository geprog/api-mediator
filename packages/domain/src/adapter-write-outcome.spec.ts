import { describe, expect, it } from "vitest";

import {
  type AdapterWriteOutcome,
  adapterWriteOutcomeMetadataSchema,
  adapterWriteOutcomeSchema,
  adapterWriteResultSchema,
} from "./index.js";

function successOutcome(): AdapterWriteOutcome {
  return {
    id: "wo-1",
    idempotencyKey: "idem-abc",
    adapterEndpointId: "ae-1",
    adapterBindingId: "ab-1",
    result: { outcome: "success", responseStatus: 201, responseBody: { id: 42 } },
    executedAt: new Date("2026-07-20T00:00:00.000Z"),
    expiresAt: new Date("2026-07-20T01:00:00.000Z"),
  };
}

describe("adapterWriteResultSchema (AD-4.1/AD-4.5)", () => {
  it("accepts a success with status and body", () => {
    const result = adapterWriteResultSchema.safeParse({
      outcome: "success",
      responseStatus: 200,
      responseBody: { ok: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a success with no body (204-style)", () => {
    const parsed = adapterWriteResultSchema.parse({ outcome: "success", responseStatus: 204 });
    expect(parsed).not.toHaveProperty("responseBody");
  });

  it("requires responseStatus on a success (a success always reached the backend)", () => {
    expect(adapterWriteResultSchema.safeParse({ outcome: "success" }).success).toBe(false);
  });

  it("accepts a failure with an upstream status/body", () => {
    const result = adapterWriteResultSchema.safeParse({
      outcome: "failure",
      responseStatus: 502,
      responseBody: { error: "bad gateway" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a failure with no HTTP response at all (timeout/connection failure)", () => {
    const parsed = adapterWriteResultSchema.parse({ outcome: "failure" });
    expect(parsed).toEqual({ outcome: "failure" });
  });

  it("carries the specific failure cause so a replay reports it verbatim (WR-3.4/WR-5.1)", () => {
    const parsed = adapterWriteResultSchema.parse({
      outcome: "failure",
      cause: "mediator-transform-error",
    });
    expect(parsed).toEqual({ outcome: "failure", cause: "mediator-transform-error" });
    // A success carries no cause — the success variant declares none, so it is stripped.
    const success = adapterWriteResultSchema.parse({
      outcome: "success",
      responseStatus: 201,
      cause: "upstream-error",
    });
    expect(success).not.toHaveProperty("cause");
  });

  it("distinguishes a failure from a success on the discriminant, not a nullable status", () => {
    const failure = adapterWriteResultSchema.parse({ outcome: "failure", responseStatus: 500 });
    expect(failure.outcome).toBe("failure");
    const success = adapterWriteResultSchema.parse({ outcome: "success", responseStatus: 500 });
    // Same status code, opposite outcome — a replay can never confuse the two.
    expect(success.outcome).toBe("success");
  });

  it("rejects an unknown outcome", () => {
    expect(adapterWriteResultSchema.safeParse({ outcome: "pending" }).success).toBe(false);
  });
});

describe("adapterWriteOutcomeSchema (AD-4.1/AD-4.3)", () => {
  it("accepts a bounded success outcome record", () => {
    expect(adapterWriteOutcomeSchema.safeParse(successOutcome()).success).toBe(true);
  });

  it("requires an expiresAt — the store is bounded, never unbounded (AD-4.3)", () => {
    const withoutExpiry: Partial<AdapterWriteOutcome> = { ...successOutcome() };
    delete withoutExpiry.expiresAt;
    expect(adapterWriteOutcomeSchema.safeParse(withoutExpiry).success).toBe(false);
  });

  it("requires a non-empty idempotency key", () => {
    expect(
      adapterWriteOutcomeSchema.safeParse({ ...successOutcome(), idempotencyKey: "" }).success,
    ).toBe(false);
  });

  it("records a failure outcome answerable on replay (AD-4.5)", () => {
    const result = adapterWriteOutcomeSchema.safeParse({
      ...successOutcome(),
      result: { outcome: "failure", responseStatus: 409, responseBody: { error: "conflict" } },
    });
    expect(result.success).toBe(true);
  });
});

describe("adapterWriteOutcomeMetadataSchema (AD-4.4 — no payload dump)", () => {
  it("has no responseBody field at all — a metadata read can never surface the body", () => {
    // The projection deliberately omits responseBody; even if a caller passes one,
    // Zod strips it, so no operator-facing read path can leak the stored payload.
    const parsed = adapterWriteOutcomeMetadataSchema.parse({
      id: "wo-1",
      idempotencyKey: "idem-abc",
      adapterEndpointId: "ae-1",
      adapterBindingId: "ab-1",
      outcome: "success",
      responseStatus: 201,
      responseBody: { secretish: "should be stripped" },
      executedAt: new Date("2026-07-20T00:00:00.000Z"),
      expiresAt: new Date("2026-07-20T01:00:00.000Z"),
    });
    expect(parsed).not.toHaveProperty("responseBody");
  });

  it("accepts a failure metadata row with no responseStatus", () => {
    const parsed = adapterWriteOutcomeMetadataSchema.parse({
      id: "wo-2",
      idempotencyKey: "idem-def",
      adapterEndpointId: "ae-1",
      adapterBindingId: "ab-1",
      outcome: "failure",
      executedAt: new Date("2026-07-20T00:00:00.000Z"),
      expiresAt: new Date("2026-07-20T01:00:00.000Z"),
    });
    expect(parsed).not.toHaveProperty("responseStatus");
  });
});
