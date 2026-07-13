import type { FailureDisposition } from "@mediator/sync-engine";

import type { OutboundCallResult } from "./executor.js";

/**
 * OC-4 — the failure signals the Outbound Call Executor's result maps onto, and the
 * classifier the ordering-queue dispatcher uses to settle them. Kept here (not in
 * `@mediator/sync-engine`) so the *generic* dispatcher stays protocol-agnostic: it
 * takes an injected `classifyFailure`, and this is the outbound one.
 *
 * The three signals are the dispositions a failed outbound settle needs:
 *  - {@link RetryableOutboundError} — a transient failure (5xx / timeout / network):
 *    retry with backoff **inside** the per-record queue, park at the ceiling
 *    (OC-4 criterion 1/2).
 *  - {@link PermanentOutboundError} — a non-retryable failure (a 4xx, a
 *    `TransformError`, or a credential-refresh failure): park immediately rather
 *    than burn retries on something that cannot succeed (OC-4 criterion 6).
 *  - {@link ThrottledOutboundError} — a load-discipline wait (a per-app ceiling or a
 *    `Retry-After`): `defer` the entry (not a failed attempt), so a rate-limited app
 *    is never dead-lettered (OC-3 criterion 5).
 *
 * **Security:** every message is a non-secret note (a status code, a transform-error
 * kind) — never a payload value or credential material.
 */

/** A transient outbound failure: retry with backoff, park at the ceiling. */
export class RetryableOutboundError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RetryableOutboundError";
  }
}

/** A non-retryable outbound failure: park immediately (no useful retry). */
export class PermanentOutboundError extends Error {
  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PermanentOutboundError";
  }
}

/** A load-discipline throttle: defer without counting a failed attempt. */
export class ThrottledOutboundError extends Error {
  /** How long to defer before retrying (the ceiling wait or `Retry-After`). */
  public readonly retryAfterMs: number;

  public constructor(retryAfterMs: number) {
    super(`outbound call throttled; retry after ${String(retryAfterMs)}ms`);
    this.name = "ThrottledOutboundError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The `classifyFailure` the ordering-queue dispatcher uses for the outbound
 * pipeline: routes each signal to its {@link FailureDisposition} (OC-3 / OC-4).
 * Unknown errors are treated as retryable (retry-then-park), the safe default.
 */
export function classifyOutboundFailure(
  error: unknown,
  attempts: number,
  maxAttempts: number,
): FailureDisposition {
  if (error instanceof ThrottledOutboundError) {
    return { kind: "defer", delayMs: error.retryAfterMs };
  }
  if (error instanceof PermanentOutboundError) {
    return { kind: "park" };
  }
  return attempts >= maxAttempts ? { kind: "park" } : { kind: "retry" };
}

/**
 * Translate an {@link OutboundCallResult} into the ordering-queue dispatcher's
 * throw/return contract (a queue handler resolves on success, throws to signal a
 * failure the dispatcher then settles via {@link classifyOutboundFailure}). This is
 * the seam the Sync Engine's pipeline handler (SP, a later slice) uses to run the
 * executor inside a queued execution; it lives here so the mapping is defined and
 * tested with the executor it settles.
 *
 * `success` / `skipped-duplicate` resolve (the entry is `done`); a `throttled`
 * result `defer`s; a `failure` result parks-or-retries by its disposition. The
 * executor has **already** recorded the `SyncEvent` (OC-5) before this runs, so
 * this only drives the queue lifecycle — never a second audit write.
 */
export function settleOutboundResult(result: OutboundCallResult): void {
  switch (result.outcome) {
    case "success":
    case "skipped-duplicate":
      return;
    case "throttled":
      throw new ThrottledOutboundError(result.retryAfterMs);
    case "failure":
      throw result.disposition === "permanent"
        ? new PermanentOutboundError(result.reason)
        : new RetryableOutboundError(result.reason);
  }
}
