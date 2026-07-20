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

/**
 * The **container-linking** park reason (SS-11.5) — the distinct `last_error` a record
 * dead-lettered because its container could not be resolved to a `ScopeLink` carries, so
 * the dead-letter surface (SA-5) distinguishes a container-link park (which an operator
 * resolves by *linking a container*, then replaying) from an ordinary write failure. A
 * non-secret note (scope keys are operator config, never a payload value).
 */
export const CONTAINER_LINK_PARK_REASON = "container-link-unresolved";

/**
 * A record whose container could **not** be resolved to a `ScopeLink` (ambiguous or
 * unresolvable — SS-11.5). A {@link PermanentOutboundError} so the ordering-queue
 * dispatcher **parks it immediately** (not a transient retry — a container is linked by an
 * operator, not by burning retries) into the existing dead-letter store with the distinct
 * {@link CONTAINER_LINK_PARK_REASON}; replay (SA-5 reactivate) re-runs the pipeline, which
 * re-attempts container resolution. The **throw** that raises this lives in the SS-12
 * write-composition/routing path (out of scope here); SS-11 provides the error + reason +
 * park disposition the dead-letter store reuses.
 */
export class ContainerUnresolvedError extends PermanentOutboundError {
  public constructor(detail: string, options?: { readonly cause?: unknown }) {
    super(`${CONTAINER_LINK_PARK_REASON}: ${detail}`, options);
    this.name = "ContainerUnresolvedError";
  }
}

/**
 * The **record-addressing** park reason (SS-19.5) — the distinct `last_error` a record
 * dead-lettered because its **container-relative address** could not be resolved carries.
 * Deliberately separate from {@link CONTAINER_LINK_PARK_REASON}: the container resolved
 * fine, so the operator's remedy is different — confirm the resource's
 * `ResourceBinding.recordAddressRef` (and replay), not link a container. A non-secret note
 * (ref names and parameter names are operator config, never a payload value).
 */
export const RECORD_ADDRESS_PARK_REASON = "record-address-unresolved";

/**
 * A linked record whose **container-relative address** could not be resolved for a write
 * (SS-19.5): the target resource is container-scoped and either its
 * `ResourceBinding.recordAddressRef` is still unconfirmed, or the `RecordLink` carries no
 * frozen address for that side (a link established before the ref was confirmed).
 *
 * A {@link PermanentOutboundError} for exactly the reason {@link ContainerUnresolvedError}
 * is one: no number of retries resolves it — an operator confirms a ref and replays. It
 * exists so the mediator **never falls back to the native id here**: inside a container
 * that id either does not exist (a 404) or, far worse, names a *different* record that the
 * write would silently clobber. Failing loud is the only safe disposition.
 */
export class RecordAddressUnresolvedError extends PermanentOutboundError {
  public constructor(detail: string, options?: { readonly cause?: unknown }) {
    super(`${RECORD_ADDRESS_PARK_REASON}: ${detail}`, options);
    this.name = "RecordAddressUnresolvedError";
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
