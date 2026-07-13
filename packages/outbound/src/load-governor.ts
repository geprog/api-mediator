import type { OutboundLoadLimits } from "@mediator/domain";

/**
 * OC-3 — per-app **load discipline**. A single, process-wide governor the shared
 * Outbound Call Executor consults before *every* outbound call, so it enforces
 * each app's concurrency + request-rate ceilings across **all** traffic to that app
 * — polling, backfill enumeration, sync writes, and (Phase 5) adapter fan-out
 * counted together (`docs/architecture/overview.md` *Outbound load discipline*).
 * Single-instance deployment (see overview.md *Deployment model*) makes an
 * in-memory per-app counter authoritative.
 *
 * **Non-blocking by design (OC-3 criterion 5).** {@link tryAcquire} never awaits: a
 * call that a ceiling or an active `Retry-After` back-off would delay is *rejected
 * now* with a `retryAfterMs`, so the caller re-queues it (the ordering queue's
 * `defer`) rather than holding its worker — a slow app degrades only its own
 * throughput, never blocking other records. The ceilings are the concept's two
 * limits; the fixed-window rate limiter is the deterministic representation choice.
 */
export interface AppLoadGovernorOptions {
  /** Injected millisecond clock (for deterministic tests). Default `Date.now`. */
  readonly now?: () => number;
  /**
   * How long to defer a call blocked purely by the **concurrency** ceiling before
   * it is re-checked (ms). A rate/Retry-After block computes its own exact wait;
   * concurrency has no natural "until" so it polls. Default 100ms.
   */
  readonly concurrencyRecheckMs?: number;
}

/** The outcome of {@link AppLoadGovernor.tryAcquire}. */
export type AcquireResult =
  | {
      readonly granted: true;
      /** Release the slot when the call settles. Idempotent per acquire. */
      readonly release: () => void;
    }
  | {
      readonly granted: false;
      /** How long to defer before retrying, honoring the concept's ceilings. */
      readonly retryAfterMs: number;
    };

const DEFAULT_CONCURRENCY_RECHECK_MS = 100;

interface AppState {
  inFlight: number;
  windowStart: number;
  windowCount: number;
  /** Epoch-ms until which the app is backed off after a `429`/`Retry-After`. */
  backoffUntil: number;
}

export class AppLoadGovernor {
  readonly #now: () => number;
  readonly #concurrencyRecheckMs: number;
  readonly #apps = new Map<string, AppState>();

  public constructor(options: AppLoadGovernorOptions = {}) {
    this.#now = options.now ?? ((): number => Date.now());
    this.#concurrencyRecheckMs = options.concurrencyRecheckMs ?? DEFAULT_CONCURRENCY_RECHECK_MS;
  }

  #stateFor(appId: string): AppState {
    let state = this.#apps.get(appId);
    if (state === undefined) {
      state = { inFlight: 0, windowStart: this.#now(), windowCount: 0, backoffUntil: 0 };
      this.#apps.set(appId, state);
    }
    return state;
  }

  /**
   * Try to reserve a slot for one outbound call to `appId`, subject to `limits`.
   *
   * `limits` is the app's resolved ceilings (`RegisteredApp.outboundLimits`, or the
   * executor's configured default — OC-3 criterion 2). **Absent** limits mean the
   * app declares no ceilings and none are configured: the call is granted
   * unthrottled (but an active `Retry-After` back-off is still honored — a `429` is
   * authoritative regardless of configured ceilings).
   *
   * Never blocks: on a ceiling/back-off it returns `{ granted: false, retryAfterMs }`
   * so the caller defers the call instead of holding a worker (OC-3 criterion 5).
   */
  public tryAcquire(appId: string, limits: OutboundLoadLimits | undefined): AcquireResult {
    const now = this.#now();
    const state = this.#stateFor(appId);

    // An active Retry-After back-off gates every call, ceilings or not (OC-3 crit 3).
    if (now < state.backoffUntil) {
      return { granted: false, retryAfterMs: state.backoffUntil - now };
    }

    if (limits === undefined) {
      // No configured ceilings → unthrottled; nothing to reserve or release.
      return { granted: true, release: (): void => {} };
    }

    // Request-rate ceiling: at most `maxRequestsPerWindow` starts per fixed window.
    if (now - state.windowStart >= limits.rateWindowMs) {
      state.windowStart = now;
      state.windowCount = 0;
    }
    if (state.windowCount >= limits.maxRequestsPerWindow) {
      return { granted: false, retryAfterMs: state.windowStart + limits.rateWindowMs - now };
    }

    // Concurrency ceiling: at most `maxConcurrentRequests` calls in flight.
    if (state.inFlight >= limits.maxConcurrentRequests) {
      return { granted: false, retryAfterMs: this.#concurrencyRecheckMs };
    }

    state.inFlight += 1;
    state.windowCount += 1;
    let released = false;
    return {
      granted: true,
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        state.inFlight = Math.max(0, state.inFlight - 1);
      },
    };
  }

  /**
   * Record a `429` / `Retry-After` from `appId`: back the app off for `retryAfterMs`
   * so subsequent {@link tryAcquire} calls are deferred until then rather than
   * re-hammering it (OC-3 criterion 3). Extends any existing back-off, never
   * shortens it.
   */
  public penalize(appId: string, retryAfterMs: number): void {
    const state = this.#stateFor(appId);
    const until = this.#now() + Math.max(0, retryAfterMs);
    state.backoffUntil = Math.max(state.backoffUntil, until);
  }

  /** In-flight call count for `appId` (observability / tests). */
  public inFlight(appId: string): number {
    return this.#apps.get(appId)?.inFlight ?? 0;
  }
}
