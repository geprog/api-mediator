import type { LoopPreventionMetrics } from "./types.js";

/**
 * Counting {@link LoopPreventionMetrics} for unit tests — asserts the skipped-loop
 * rate is emitted (EP-4.5) and that skipped-loop vs. skipped-policy are counted
 * **distinctly** (a delete echo / resurrection is never conflated with a
 * counterpart-deleted survivor change).
 */
export class FakeLoopPreventionMetrics implements LoopPreventionMetrics {
  public skippedLoop: string[] = [];
  public skippedPolicy: string[] = [];

  public recordSkippedLoop(ruleId: string): void {
    this.skippedLoop.push(ruleId);
  }

  public recordSkippedPolicy(ruleId: string): void {
    this.skippedPolicy.push(ruleId);
  }
}
