import { LLMOutputValidationError, LLMTransportError, type LlmUsage } from "@mediator/llm";

/**
 * The validate-then-corrective-retry loop (TD-3) — the engine's job, deliberately
 * NOT the provider's. Every provider call performs exactly one model call and then
 * validates; on malformed output it rejects with {@link LLMOutputValidationError}.
 * {@link callWithRetry} reacts to that rejection by re-invoking the same stage,
 * feeding the prior validation error back as `correctiveFeedback`, up to a
 * configurable attempt cap. Only a validated result is ever used, and a retry
 * produces no duplicate — exactly one value comes back on success.
 *
 * Error handling by type (see `@mediator/llm` errors):
 * - {@link LLMOutputValidationError} — malformed output: re-prompt and retry until
 *   the cap. This is the retryable failure.
 * - {@link LLMTransportError} — the model was unreachable/timed out: **not** an
 *   output problem, so it is not re-prompted; it fails the call immediately (same
 *   "never produced a valid result" outcome the cap produces).
 * - anything else (a bug, a script-setup error) **propagates** — it is never
 *   swallowed as a detection failure.
 */

/** How many total attempts the cap `maxRetries` permits: the initial call plus retries. */
export function maxAttempts(maxRetries: number): number {
  return 1 + Math.max(0, maxRetries);
}

/**
 * Read the usage the provider recorded for its most recent call. Kept a callback
 * so the loop stays decoupled from the concrete provider; the engine passes
 * `() => provider.lastUsage`.
 */
export type ReadUsage = () => LlmUsage | undefined;

/** Invoke one attempt of a stage, given the prior attempt's corrective feedback (if any). */
export type Attempt<T> = (correctiveFeedback: string | undefined) => Promise<T>;

export interface RetryResult<T> {
  readonly outcome: "success" | "failed";
  /** Present only when `outcome === "success"`. */
  readonly value: T | undefined;
  /** Total provider calls made (initial + corrective retries). */
  readonly attempts: number;
  /** Wall-clock latency across all attempts, in milliseconds. */
  readonly durationMs: number;
  /** Token usage summed across all attempts. */
  readonly usage: LlmUsage;
}

/** Turn an {@link LLMOutputValidationError}'s issues into a compact re-prompt string. */
function formatCorrectiveFeedback(error: LLMOutputValidationError): string {
  const lines = error.issues.map(
    (issue) => `- ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`,
  );
  return lines.length > 0 ? lines.join("\n") : error.message;
}

/** Fold one attempt's usage into a running total. */
function addUsage(total: LlmUsage, next: LlmUsage | undefined): LlmUsage {
  if (next === undefined) {
    return total;
  }
  const totalDurationMs =
    total.totalDurationMs === undefined && next.totalDurationMs === undefined
      ? undefined
      : (total.totalDurationMs ?? 0) + (next.totalDurationMs ?? 0);
  const summed: LlmUsage = {
    promptEvalCount: total.promptEvalCount + next.promptEvalCount,
    evalCount: total.evalCount + next.evalCount,
  };
  return totalDurationMs === undefined ? summed : { ...summed, totalDurationMs };
}

/**
 * Run a stage call with corrective retries, capped at `maxAttempts(maxRetries)`
 * total attempts (default cap: the config's `maxRetries` = 3 → 4 attempts). On
 * success, `value` is the validated result. On a malformed answer at the cap, or
 * a transport failure, `outcome` is `"failed"` (the stage applies its own failure
 * handling — the two blast radii, TD-4). `now` is injected for deterministic
 * latency measurement in tests.
 */
export async function callWithRetry<T>(
  attempt: Attempt<T>,
  readUsage: ReadUsage,
  maxRetries: number,
  now: () => number = () => Date.now(),
): Promise<RetryResult<T>> {
  const started = now();
  const cap = maxAttempts(maxRetries);
  let usage: LlmUsage = { promptEvalCount: 0, evalCount: 0 };
  let attempts = 0;
  let correctiveFeedback: string | undefined;

  while (attempts < cap) {
    attempts += 1;
    try {
      const value = await attempt(correctiveFeedback);
      usage = addUsage(usage, readUsage());
      return { outcome: "success", value, attempts, durationMs: now() - started, usage };
    } catch (error) {
      usage = addUsage(usage, readUsage());
      if (error instanceof LLMOutputValidationError) {
        correctiveFeedback = formatCorrectiveFeedback(error);
        continue; // re-prompt with the validation error, until the cap
      }
      if (error instanceof LLMTransportError) {
        return {
          outcome: "failed",
          value: undefined,
          attempts,
          durationMs: now() - started,
          usage,
        };
      }
      throw error; // a real bug / setup error must not be swallowed as a failure
    }
  }

  return { outcome: "failed", value: undefined, attempts, durationMs: now() - started, usage };
}
