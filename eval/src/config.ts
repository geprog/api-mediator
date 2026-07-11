/**
 * Harness configuration — the thresholds/floors the scoring reads. Per EH these
 * are **harness config recorded in the report, never concept constants and never
 * asserted as gates**: they tune what counts as a "confident" proposal and when
 * shortlist recall is flagged "too low", and every report echoes the config used.
 */
export interface HarnessConfig {
  /**
   * The confidence at or above which a shortlist entry / proposal item counts as a
   * **confident** proposal (as opposed to an acceptable low-confidence shortlist
   * entry). Mirrors the concept's illustrative review threshold (`< 0.7` →
   * `reviewRequired`, `docs/architecture/mapping-engine.md` *Confidence & ambiguity*)
   * — used here to distinguish a confidently-proposed negative (a scored failure)
   * from a tolerated low-confidence one (EH-2 crit 3/4). Harness config, not a gate.
   */
  readonly confidenceThreshold: number;
  /**
   * The shortlist-recall floor below which the report flags "stage-1 recall too
   * low" — the offline proxy for production escape-hatch usage (EH-3 crit 6). A
   * reported signal for humans, not an assertion.
   */
  readonly shortlistRecallFloor: number;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  confidenceThreshold: 0.7,
  shortlistRecallFloor: 0.8,
};
