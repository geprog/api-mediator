import { describe, expect, it } from "vitest";

import {
  DuplicateReconcilerError,
  ReconciliationSweep,
  type Reconciler,
} from "./reconciliation.js";

function recordingReconciler(name: string, ran: string[], fail = false): Reconciler {
  return {
    name,
    reconcile: () => {
      ran.push(name);
      return fail ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
    },
  };
}

describe("ReconciliationSweep", () => {
  it("runs every registered reconciler and reports ok outcomes", async () => {
    const ran: string[] = [];
    const sweep = new ReconciliationSweep();
    sweep.register(recordingReconciler("a", ran));
    sweep.register(recordingReconciler("b", ran));

    const result = await sweep.runSweep();

    expect(ran).toStrictEqual(["a", "b"]);
    expect(result.outcomes).toStrictEqual([
      { name: "a", status: "ok" },
      { name: "b", status: "ok" },
    ]);
  });

  it("isolates a failing reconciler so the others still run", async () => {
    const ran: string[] = [];
    const sweep = new ReconciliationSweep();
    sweep.register(recordingReconciler("a", ran, true));
    sweep.register(recordingReconciler("b", ran));

    const result = await sweep.runSweep();

    expect(ran).toStrictEqual(["a", "b"]);
    const first = result.outcomes[0];
    expect(first?.status).toBe("error");
    // Narrow on the discriminant before reading `error` (only the error variant has it).
    if (first?.status === "error") {
      expect(first.error).toBeInstanceOf(Error);
    }
    expect(result.outcomes[1]).toStrictEqual({ name: "b", status: "ok" });
  });

  it("runs cleanly with no registered reconcilers (Phase 1 has none)", async () => {
    const result = await new ReconciliationSweep().runSweep();
    expect(result.outcomes).toStrictEqual([]);
  });

  it("rejects a duplicate reconciler name", () => {
    const sweep = new ReconciliationSweep();
    sweep.register(recordingReconciler("dup", []));
    expect(() => {
      sweep.register(recordingReconciler("dup", []));
    }).toThrow(DuplicateReconcilerError);
  });
});
