import type { MappingVariant } from "@mediator/domain";
import type { LlmUsage } from "@mediator/llm";

/**
 * The per-call observability record the engine surfaces for every LLM stage call
 * (TD-3 crit 5). **OTel emission is the next slice**; this slice only makes the
 * signal available — attempt count, latency, outcome, and the token usage threaded
 * from the provider's {@link LlmUsage} seam — so the retry-ceiling alert has
 * something to read (`docs/architecture/observability.md`).
 *
 * `attempts` is the total number of provider calls made for this one stage call
 * (initial + corrective retries), `outcome` whether a validated result was
 * obtained (`success`) or the retry cap / a transport failure was hit (`failed`),
 * and `usage` the summed token counts across every attempt.
 */
export type LlmCallStage = "shortlist" | "detail";

export interface LlmCallMetrics {
  readonly stage: LlmCallStage;
  /** Absent for shortlist (variant-agnostic); the detail call's variant otherwise. */
  readonly variant?: MappingVariant;
  readonly outcome: "success" | "failed";
  readonly attempts: number;
  readonly durationMs: number;
  /** Summed token usage across every attempt (`promptEvalCount`/`evalCount`). */
  readonly usage: LlmUsage;
}
