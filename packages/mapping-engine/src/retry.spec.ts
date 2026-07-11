import { LLMOutputValidationError, LLMTransportError, type LlmUsage } from "@mediator/llm";
import { describe, expect, it } from "vitest";

import { callWithRetry, maxAttempts } from "./retry.js";

const usage: LlmUsage = { promptEvalCount: 3, evalCount: 2 };
const readUsage = (): LlmUsage => usage;

function validationError(): LLMOutputValidationError {
  return new LLMOutputValidationError("bad", "{}", [
    { path: "candidatePairs", message: "required" },
  ]);
}

describe("maxAttempts", () => {
  it("is 1 + maxRetries (initial call plus retries)", () => {
    expect(maxAttempts(0)).toBe(1);
    expect(maxAttempts(3)).toBe(4);
    // A negative cap is clamped to the initial attempt.
    expect(maxAttempts(-2)).toBe(1);
  });
});

describe("callWithRetry (TD-3)", () => {
  it("returns the value on first success, one attempt", async () => {
    const result = await callWithRetry(() => Promise.resolve("ok"), readUsage, 3);
    expect(result).toMatchObject({ outcome: "success", value: "ok", attempts: 1 });
    expect(result.usage).toEqual({ promptEvalCount: 3, evalCount: 2 });
  });

  it("retries a malformed answer and uses the later valid one (no duplicate)", async () => {
    let calls = 0;
    const feedbackSeen: (string | undefined)[] = [];
    const result = await callWithRetry(
      (correctiveFeedback) => {
        feedbackSeen.push(correctiveFeedback);
        calls += 1;
        return calls === 1 ? Promise.reject(validationError()) : Promise.resolve("valid");
      },
      readUsage,
      3,
    );
    expect(result).toMatchObject({ outcome: "success", value: "valid", attempts: 2 });
    // The 2nd attempt received the prior validation error as corrective feedback.
    expect(feedbackSeen[0]).toBeUndefined();
    expect(feedbackSeen[1]).toContain("candidatePairs");
    // Usage summed across both attempts.
    expect(result.usage).toEqual({ promptEvalCount: 6, evalCount: 4 });
  });

  it("stops at the cap on repeated malformed output (failed, attempts = 1 + maxRetries)", async () => {
    let calls = 0;
    const result = await callWithRetry(
      () => {
        calls += 1;
        return Promise.reject(validationError());
      },
      readUsage,
      2,
    );
    expect(result).toMatchObject({ outcome: "failed", value: undefined, attempts: 3 });
    expect(calls).toBe(3);
  });

  it("fails immediately on a transport error (no re-prompt)", async () => {
    let calls = 0;
    const result = await callWithRetry(
      () => {
        calls += 1;
        return Promise.reject(new LLMTransportError("unreachable"));
      },
      readUsage,
      3,
    );
    expect(result.outcome).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("propagates a non-LLM error rather than swallowing it as a failure", async () => {
    await expect(
      callWithRetry(() => Promise.reject(new TypeError("bug")), readUsage, 3),
    ).rejects.toThrow(TypeError);
  });

  it("measures latency with the injected clock", async () => {
    const ticks = [0, 7];
    const now = (): number => ticks.shift() ?? 7;
    const result = await callWithRetry(() => Promise.resolve("ok"), readUsage, 3, now);
    expect(result.durationMs).toBe(7);
  });
});
