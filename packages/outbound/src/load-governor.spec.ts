import type { OutboundLoadLimits } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { AppLoadGovernor } from "./load-governor.js";

/**
 * OC-3 — per-app load discipline: the concurrency ceiling, the request-rate
 * ceiling, `429`/`Retry-After` back-off, and the crucial non-blocking property
 * (a throttled call is rejected *now* so it never holds a worker — OC-3 crit 5).
 */

const LIMITS: OutboundLoadLimits = {
  maxConcurrentRequests: 2,
  maxRequestsPerWindow: 3,
  rateWindowMs: 1_000,
};

function governorAt(nowRef: { ms: number }): AppLoadGovernor {
  return new AppLoadGovernor({ now: () => nowRef.ms, concurrencyRecheckMs: 50 });
}

describe("AppLoadGovernor concurrency ceiling", () => {
  it("grants up to the ceiling, then defers until a slot is released", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);

    const a = gov.tryAcquire("app", LIMITS);
    const b = gov.tryAcquire("app", LIMITS);
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(gov.inFlight("app")).toBe(2);

    // Third in-flight exceeds maxConcurrentRequests=2 → deferred, not blocked.
    const c = gov.tryAcquire("app", LIMITS);
    expect(c).toStrictEqual({ granted: false, retryAfterMs: 50 });

    // Release one; a slot frees up.
    if (a.granted) {
      a.release();
    }
    expect(gov.inFlight("app")).toBe(1);
    expect(gov.tryAcquire("app", LIMITS).granted).toBe(true);
  });

  it("release is idempotent (a double release does not underflow the counter)", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    const a = gov.tryAcquire("app", LIMITS);
    if (a.granted) {
      a.release();
      a.release();
    }
    expect(gov.inFlight("app")).toBe(0);
  });
});

describe("AppLoadGovernor request-rate ceiling", () => {
  it("allows maxRequestsPerWindow starts per window, then defers until the window rolls", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    // Release each immediately so only the RATE (starts/window), not concurrency, gates.
    for (let i = 0; i < 3; i += 1) {
      const r = gov.tryAcquire("app", LIMITS);
      expect(r.granted).toBe(true);
      if (r.granted) {
        r.release();
      }
    }
    // 4th start in the same window → deferred until the window end (1000ms).
    const fourth = gov.tryAcquire("app", LIMITS);
    expect(fourth).toStrictEqual({ granted: false, retryAfterMs: 1_000 });

    // Advance past the window → starts allowed again.
    now.ms = 1_000;
    expect(gov.tryAcquire("app", LIMITS).granted).toBe(true);
  });
});

describe("AppLoadGovernor Retry-After back-off (OC-3 crit 3)", () => {
  it("penalize backs the app off; tryAcquire defers until it clears", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    gov.penalize("app", 5_000);

    const blocked = gov.tryAcquire("app", LIMITS);
    expect(blocked).toStrictEqual({ granted: false, retryAfterMs: 5_000 });

    now.ms = 5_000;
    expect(gov.tryAcquire("app", LIMITS).granted).toBe(true);
  });

  it("penalize is honored even with no configured ceilings, and never shortens an existing back-off", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    gov.penalize("app", 10_000);
    gov.penalize("app", 1_000); // shorter — must not shorten the existing 10s back-off
    expect(gov.tryAcquire("app", undefined)).toStrictEqual({
      granted: false,
      retryAfterMs: 10_000,
    });
  });
});

describe("AppLoadGovernor isolation + non-blocking (OC-3 crit 1 + 5)", () => {
  it("ceilings are per app: a slow app's saturation never defers another app", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    // Saturate app A's concurrency.
    gov.tryAcquire("A", LIMITS);
    gov.tryAcquire("A", LIMITS);
    expect(gov.tryAcquire("A", LIMITS).granted).toBe(false);

    // App B is untouched — a slow app degrades only its own throughput.
    expect(gov.tryAcquire("B", LIMITS).granted).toBe(true);
  });

  it("tryAcquire never awaits: a throttle returns synchronously (does not hold the worker)", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    gov.penalize("A", 30_000);
    // A synchronous, immediate rejection — the call site defers via the queue
    // instead of blocking, so other records keep flowing.
    const result = gov.tryAcquire("A", LIMITS);
    expect(result.granted).toBe(false);
  });

  it("undefined limits mean unthrottled (defaults applied by the executor, not here)", () => {
    const now = { ms: 0 };
    const gov = governorAt(now);
    for (let i = 0; i < 100; i += 1) {
      expect(gov.tryAcquire("app", undefined).granted).toBe(true);
    }
  });
});
