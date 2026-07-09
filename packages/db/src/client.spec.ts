import { describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type TransactionScope } from "./client.js";

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

describe("createDb pool error handling", () => {
  // A pool 'error' event with no listener is an unhandled 'error' → Node crashes
  // the process. `createDb` must always register one. `new Pool(...)` is lazy (it
  // does not connect until first use), so we can emit the event synthetically —
  // exactly the idle-client failure a Postgres restart produces — without a live
  // database, and assert the process survives.
  const CONNECTION_STRING = "postgres://user:pass@localhost:1/none";
  const IDLE_ERROR = new Error("terminating connection due to administrator command");

  it("routes a pool 'error' to the supplied handler without throwing", async () => {
    const seen: Error[] = [];
    const db = createDb(CONNECTION_STRING, (error) => seen.push(error));

    expect(() => db.$client.emit("error", IDLE_ERROR)).not.toThrow();
    expect(seen).toEqual([IDLE_ERROR]);

    await closeDb(db);
  });

  it("swallows a pool 'error' by default so the process cannot crash", async () => {
    const db = createDb(CONNECTION_STRING);

    expect(() => db.$client.emit("error", IDLE_ERROR)).not.toThrow();

    await closeDb(db);
  });
});

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
