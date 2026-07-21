import { describe, expect, it } from "vitest";

import type { ScopeProposalOutcome } from "../scope-authoring.js";
import {
  describeUnderivableScopeSkip,
  isUnderivableScopeSkip,
  underivableScopePairs,
} from "../scope-authoring.js";
import { buildScopeProposalReporter, type ScopeProposalLogSink } from "./report-scope-proposal.js";

/**
 * SS-16 — consuming the SS-18 `ScopeProposalSkipReason`s. Proves the classifier partitions
 * "correctly not scoped" from "scoped but underivable", and that the reporter surfaces only
 * the latter — the reasons that were previously returned but read by nothing.
 */

describe("isUnderivableScopeSkip", () => {
  it("treats `not-scoped` as the expected case, and the other three as underivable", () => {
    expect(isUnderivableScopeSkip("not-scoped")).toBe(false);
    expect(isUnderivableScopeSkip("target-container-unresolved")).toBe(true);
    expect(isUnderivableScopeSkip("no-source-scope-capture")).toBe(true);
    expect(isUnderivableScopeSkip("no-value-preserving-pairing")).toBe(true);
  });
});

describe("describeUnderivableScopeSkip", () => {
  it("gives a non-empty explanation for every reason (totality)", () => {
    for (const reason of [
      "not-scoped",
      "target-container-unresolved",
      "no-source-scope-capture",
      "no-value-preserving-pairing",
    ] as const) {
      expect(describeUnderivableScopeSkip(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("underivableScopePairs", () => {
  it("keeps the underivable skips and drops the not-scoped ones", () => {
    const outcome: ScopeProposalOutcome = {
      proposed: [],
      skipped: [
        { resourcePairRef: "a:x|b:y", reason: "not-scoped" },
        { resourcePairRef: "a:p|b:q", reason: "no-value-preserving-pairing" },
        { resourcePairRef: "a:m|b:n", reason: "target-container-unresolved" },
      ],
    };
    expect(underivableScopePairs(outcome)).toStrictEqual([
      { resourcePairRef: "a:p|b:q", reason: "no-value-preserving-pairing" },
      { resourcePairRef: "a:m|b:n", reason: "target-container-unresolved" },
    ]);
  });
});

describe("buildScopeProposalReporter", () => {
  function sink(): {
    calls: { obj: Record<string, unknown>; msg: string }[];
    log: ScopeProposalLogSink;
  } {
    const calls: { obj: Record<string, unknown>; msg: string }[] = [];
    return { calls, log: { warn: (obj, msg): void => void calls.push({ obj, msg }) } };
  }

  it("warns once per underivable pair, with its ref + typed reason + mapping id", () => {
    const { calls, log } = sink();
    const report = buildScopeProposalReporter(log);
    report(
      {
        proposed: [],
        skipped: [
          { resourcePairRef: "a:x|b:y", reason: "not-scoped" },
          { resourcePairRef: "a:p|b:q", reason: "no-source-scope-capture" },
        ],
      },
      { approvedMappingId: "map-1" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.obj).toMatchObject({
      approvedMappingId: "map-1",
      resourcePairRef: "a:p|b:q",
      reason: "no-source-scope-capture",
    });
  });

  it("stays silent when every pair proposed or was correctly not scoped", () => {
    const { calls, log } = sink();
    buildScopeProposalReporter(log)(
      { proposed: [], skipped: [{ resourcePairRef: "a:x|b:y", reason: "not-scoped" }] },
      { approvedMappingId: "map-2" },
    );
    expect(calls).toHaveLength(0);
  });
});
