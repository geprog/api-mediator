import { describe, expect, it } from "vitest";

import { peerScoringInput } from "./fixtures.js";
import { formatSummary } from "./report.js";
import { scoreScenario } from "./scoring.js";

describe("formatSummary", () => {
  const summary = formatSummary(scoreScenario(peerScoringInput()));

  it("renders a human-readable summary carrying the provider identity and both stages", () => {
    expect(summary).toContain("Detection eval — fixture-peer");
    expect(summary).toContain("provider: fixture / fixture-model");
    expect(summary).toContain("Stage 1 (shortlist)");
    expect(summary).toContain("Stage 2 (detail");
    expect(summary).toContain("recall");
    // The confidently-proposed negative surfaces as an explicit failure line.
    expect(summary).toContain("FAIL [incorrect-but-tempting]");
  });
});
