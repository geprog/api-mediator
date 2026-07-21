import { describe, expect, it } from "vitest";

import { dedupMode, isPaginationUnconfirmed, shouldNudgeDistinctOrders } from "./union-model";

describe("union-model — dedup mode", () => {
  it("reads the mode of a dedup value, or null when none is chosen", () => {
    expect(dedupMode(null)).toBeNull();
    expect(dedupMode({ mode: "none" })).toBe("none");
    expect(dedupMode({ mode: "record-link" })).toBe("record-link");
    expect(dedupMode({ mode: "dedup-key", dedupKeyFieldPath: "email" })).toBe("dedup-key");
  });
});

describe("union-model — pagination derive-then-confirm (CU-2.2)", () => {
  it("is unconfirmed when a convention exists but is not confirmed", () => {
    expect(isPaginationUnconfirmed(true, false)).toBe(true);
  });

  it("is not unconfirmed once confirmed or when there is no convention", () => {
    expect(isPaginationUnconfirmed(true, true)).toBe(false);
    expect(isPaginationUnconfirmed(false, false)).toBe(false);
  });
});

describe("union-model — distinct-order nudge (CU-2.3)", () => {
  it("nudges when dedup is on and two contributors share an order", () => {
    expect(shouldNudgeDistinctOrders({ mode: "record-link" }, [0, 0])).toBe(true);
    expect(shouldNudgeDistinctOrders({ mode: "dedup-key", dedupKeyFieldPath: "id" }, [1, 1])).toBe(
      true,
    );
  });

  it("does not nudge with distinct orders, no dedup, or explicit no-dedup", () => {
    expect(shouldNudgeDistinctOrders({ mode: "record-link" }, [0, 1])).toBe(false);
    expect(shouldNudgeDistinctOrders(null, [0, 0])).toBe(false);
    expect(shouldNudgeDistinctOrders({ mode: "none" }, [0, 0])).toBe(false);
  });
});
