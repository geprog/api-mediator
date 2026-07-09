import { describe, expect, it } from "vitest";

import { tx, type TransactionScope } from "./client.js";

interface FakeTx {
  readonly id: string;
}

/**
 * An in-memory {@link TransactionScope} that models Drizzle's contract without a
 * live database: it records the lifecycle it drives, commits when the callback
 * resolves, and rolls back (then re-throws) when the callback rejects.
 */
function fakeScope(log: string[]): TransactionScope<FakeTx> {
  return {
    transaction<T>(fn: (txn: FakeTx) => Promise<T>): Promise<T> {
      log.push("begin");
      return fn({ id: "fake-tx" }).then(
        (result) => {
          log.push("commit");
          return result;
        },
        (error: unknown) => {
          log.push("rollback");
          throw error;
        },
      );
    },
  };
}

describe("tx", () => {
  it("commits and returns the callback result when it resolves", async () => {
    const log: string[] = [];

    const result = await tx(fakeScope(log), (txn) => Promise.resolve(`${txn.id}:ok`));

    expect(result).toBe("fake-tx:ok");
    expect(log).toEqual(["begin", "commit"]);
  });

  it("rolls back and re-throws when the callback rejects", async () => {
    const log: string[] = [];

    await expect(tx(fakeScope(log), () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );

    expect(log).toEqual(["begin", "rollback"]);
  });
});
