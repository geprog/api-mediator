import { describe, expect, it } from "vitest";

import {
  CONTAINER_LINK_PARK_REASON,
  ContainerUnresolvedError,
  PermanentOutboundError,
  RetryableOutboundError,
  ThrottledOutboundError,
  classifyOutboundFailure,
  settleOutboundResult,
} from "./errors.js";
import type { OutboundCallResult } from "./executor.js";

/**
 * OC-4 — how the ordering-queue dispatcher settles the executor's dispositions:
 * throttle → `defer` (attempt-neutral), permanent → `park` now, retryable →
 * retry-then-park at the ceiling.
 */

describe("classifyOutboundFailure", () => {
  it("throttle → defer with the Retry-After delay (never counts toward the ceiling)", () => {
    expect(classifyOutboundFailure(new ThrottledOutboundError(2_500), 9, 5)).toStrictEqual({
      kind: "defer",
      delayMs: 2_500,
    });
  });

  it("permanent → park immediately, regardless of attempts", () => {
    expect(classifyOutboundFailure(new PermanentOutboundError("HTTP 400"), 1, 5)).toStrictEqual({
      kind: "park",
    });
  });

  it("container-unresolved → park immediately with the distinct container-link reason (SS-11.5)", () => {
    const error = new ContainerUnresolvedError("no ScopeLink for scope {owner:alice}");
    // A permanent-park disposition: a container is linked by an operator, never by retries.
    expect(classifyOutboundFailure(error, 1, 5)).toStrictEqual({ kind: "park" });
    // The dead-letter store's `last_error` reason distinguishes a container-link park.
    expect(error.message.startsWith(CONTAINER_LINK_PARK_REASON)).toBe(true);
    expect(error).toBeInstanceOf(PermanentOutboundError);
  });

  it("retryable → retry under the ceiling, park at it", () => {
    expect(classifyOutboundFailure(new RetryableOutboundError("HTTP 503"), 2, 5)).toStrictEqual({
      kind: "retry",
    });
    expect(classifyOutboundFailure(new RetryableOutboundError("HTTP 503"), 5, 5)).toStrictEqual({
      kind: "park",
    });
  });

  it("an unknown error is treated as retryable (retry-then-park)", () => {
    expect(classifyOutboundFailure(new Error("boom"), 1, 5)).toStrictEqual({ kind: "retry" });
    expect(classifyOutboundFailure(new Error("boom"), 5, 5)).toStrictEqual({ kind: "park" });
  });
});

describe("settleOutboundResult", () => {
  it("success / skipped-duplicate resolve (the queue entry is done)", () => {
    const success: OutboundCallResult = {
      outcome: "success",
      idempotencyKey: "k",
      syncEventId: "e",
      writtenRepresentation: { body: undefined, createdNativeId: undefined },
    };
    const dup: OutboundCallResult = { outcome: "skipped-duplicate", idempotencyKey: "k" };
    expect(() => {
      settleOutboundResult(success);
    }).not.toThrow();
    expect(() => {
      settleOutboundResult(dup);
    }).not.toThrow();
  });

  it("throttled throws a ThrottledOutboundError carrying the wait", () => {
    expect(() => {
      settleOutboundResult({ outcome: "throttled", retryAfterMs: 1_234 });
    }).toThrow(ThrottledOutboundError);
  });

  it("permanent failure throws PermanentOutboundError; retryable throws RetryableOutboundError", () => {
    expect(() => {
      settleOutboundResult({
        outcome: "failure",
        disposition: "permanent",
        idempotencyKey: "k",
        syncEventId: "e",
        reason: "HTTP 400",
      });
    }).toThrow(PermanentOutboundError);
    expect(() => {
      settleOutboundResult({
        outcome: "failure",
        disposition: "retryable",
        idempotencyKey: "k",
        syncEventId: "e",
        reason: "HTTP 503",
      });
    }).toThrow(RetryableOutboundError);
  });
});
