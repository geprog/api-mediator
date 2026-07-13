import { afterEach, describe, expect, it, vi } from "vitest";

import { trackBackgroundRun } from "./background.js";

/**
 * Unit coverage for the background-run tracking (the MUST-FIX): an in-flight
 * enable/backfill whose underlying run rejects (a transient DB fault) must NOT float an
 * unhandled rejection — under Node's `--unhandled-rejections=throw` that would terminate
 * the single-instance process, exactly what the scheduler/dispatcher `onError` discipline
 * elsewhere prevents. The rejection must instead be reported via `onError`, the run must
 * be removed from the tracking set, and the process/loop must survive whether or not the
 * caller awaits the returned promise.
 */
describe("trackBackgroundRun", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  it("reports a rejecting run via onError, cleans up the set, and does not float (caller awaits)", async () => {
    const active = new Set<Promise<unknown>>();
    const onError = vi.fn();
    const run = trackBackgroundRun(Promise.reject(new Error("db fault")), active, onError);

    // A caller that awaits the returned run still observes the real error...
    await expect(run).rejects.toThrow("db fault");
    // ...and the tracking + reporting side of the fix has settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(active.size).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("does NOT produce an unhandled rejection even when the returned run is never awaited", async () => {
    process.on("unhandledRejection", onUnhandled);
    const active = new Set<Promise<unknown>>();

    // Fire-and-forget (an HTTP handler answering 202 before the backfill finishes): the
    // returned promise is discarded, yet the rejection must be swallowed by the tracker.
    void trackBackgroundRun(Promise.reject(new Error("db fault")), active, () => {});

    // Give the event loop a full turn so any unhandled rejection would have surfaced.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toHaveLength(0);
    expect(active.size).toBe(0);
  });

  it("keeps a still-running run in the set until it settles (graceful stop can await it)", async () => {
    const active = new Set<Promise<unknown>>();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = trackBackgroundRun(pending, active, () => {});
    expect(active.has(run)).toBe(true);
    release?.();
    await run;
    await Promise.resolve();
    expect(active.size).toBe(0);
  });
});
