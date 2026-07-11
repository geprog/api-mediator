import type { MappingLlmConfig } from "@mediator/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicConfigError,
  AnthropicProvider,
  createAnthropicSdkClient,
  type AnthropicContentBlock,
  type AnthropicMessagesClient,
  type AnthropicResponse,
  type AnthropicToolRequest,
  type AnthropicUsage,
} from "./anthropic-provider.js";
import { LLMOutputValidationError, LLMTransportError } from "./errors.js";
import { buildDetailPrompt, buildShortlistPrompt } from "./prompt.js";
import { consumerProviderDetailFormat, peerPeerDetailFormat, shortlistFormat } from "./schemas.js";
import {
  consumerProviderDetailContext,
  malformedShortlist,
  outOfRangeConfidenceShortlist,
  paddedRefsShortlist,
  peerPeerDetailContext,
  shortlistContext,
  validConsumerProviderSet,
  validPeerPeerSet,
  validShortlist,
} from "./fixtures.js";

/** Base config with NO api key: every test injects a client, so the key is unused. */
const config: MappingLlmConfig = {
  provider: "anthropic",
  ollamaBaseUrl: "http://localhost:11434",
  model: "claude-sonnet-5",
  temperature: 0,
  thinking: false,
  requestTimeoutMs: 5_000,
  maxRetries: 3,
};

interface ReplyOptions {
  readonly usage?: AnthropicUsage;
  readonly extraBlocks?: readonly AnthropicContentBlock[];
  readonly stopReason?: string | null;
}

/**
 * A mock client that records the last request and replies with a single tool_use
 * block whose name matches the request's forced tool and whose `input` is the
 * given (already-parsed) value — mirroring what the SDK returns for a forced tool.
 */
function replyClient(
  input: unknown,
  options: ReplyOptions = {},
): { client: AnthropicMessagesClient; lastRequest: () => AnthropicToolRequest | undefined } {
  let last: AnthropicToolRequest | undefined;
  const client: AnthropicMessagesClient = {
    createMessage(request) {
      last = request;
      const response: AnthropicResponse = {
        content: [
          ...(options.extraBlocks ?? []),
          { type: "tool_use", name: request.toolChoice.name, input },
        ],
        usage: options.usage ?? { inputTokens: 0, outputTokens: 0 },
        stopReason: options.stopReason ?? "tool_use",
      };
      return Promise.resolve(response);
    },
  };
  return { client, lastRequest: () => last };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AnthropicProvider — request shape (LP-2)", () => {
  it("sends one forced-tool shortlist call with the shortlist format, no temperature, thinking disabled", async () => {
    const { client, lastRequest } = replyClient(validShortlist);
    const provider = new AnthropicProvider({ config, client });

    await provider.shortlistResourcePairs(shortlistContext);

    const request = lastRequest();
    expect(request?.model).toBe("claude-sonnet-5");
    expect(request?.maxTokens).toBe(16000);
    expect(request?.thinking).toEqual({ type: "disabled" });
    expect(request?.toolChoice).toEqual({ type: "tool", name: "emit_resource_shortlist" });
    expect(request?.tools).toHaveLength(1);
    expect(request?.tools[0].name).toBe("emit_resource_shortlist");
    expect(request?.tools[0].inputSchema).toBe(shortlistFormat);
    // No temperature is expressible on the request type — the forced-tool call
    // deliberately omits it (a non-default value is rejected by Claude).
    expect(request).not.toHaveProperty("temperature");
  });

  it("splits the shared prompt into a top-level system string plus user messages", async () => {
    const { client, lastRequest } = replyClient(validShortlist);
    await new AnthropicProvider({ config, client }).shortlistResourcePairs(shortlistContext);

    const prompt = buildShortlistPrompt(shortlistContext);
    const expectedSystem = prompt
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const expectedUsers = prompt.filter((message) => message.role === "user");

    const request = lastRequest();
    expect(request?.system).toBe(expectedSystem);
    expect(request?.system.length).toBeGreaterThan(0);
    expect(request?.messages).toEqual(expectedUsers);
    expect(request?.messages.every((message) => message.role === "user")).toBe(true);
  });

  it("appends the corrective-feedback user message when the context carries one", async () => {
    const { client, lastRequest } = replyClient(validShortlist);
    await new AnthropicProvider({ config, client }).shortlistResourcePairs({
      ...shortlistContext,
      correctiveFeedback: "candidatePairs: Required",
    });

    const request = lastRequest();
    const lastUserMessage = request?.messages.at(-1)?.content ?? "";
    expect(lastUserMessage).toContain("candidatePairs: Required");
    // The system prompt still contains only the shortlist system message.
    expect(request?.system).toContain("shortlist stage");
  });

  it("uses the variant-correct detail format and mapping tool for each variant", async () => {
    const peer = replyClient(validPeerPeerSet);
    await new AnthropicProvider({ config, client: peer.client }).generateMappingProposal(
      peerPeerDetailContext,
    );
    expect(peer.lastRequest()?.tools[0].inputSchema).toBe(peerPeerDetailFormat);
    expect(peer.lastRequest()?.toolChoice.name).toBe("emit_mapping_suggestions");

    const consumer = replyClient(validConsumerProviderSet);
    await new AnthropicProvider({ config, client: consumer.client }).generateMappingProposal(
      consumerProviderDetailContext,
    );
    expect(consumer.lastRequest()?.tools[0].inputSchema).toBe(consumerProviderDetailFormat);

    // Sanity: the detail user message carries both resources in full.
    const detailPrompt = buildDetailPrompt(peerPeerDetailContext);
    expect(peer.lastRequest()?.messages).toEqual(
      detailPrompt.filter((message) => message.role === "user"),
    );
  });

  it("reports its provider identity for provenance", () => {
    const provider = new AnthropicProvider({ config, client: replyClient({}).client });
    expect(provider.providerId).toBe("anthropic");
    expect(provider.model).toBe("claude-sonnet-5");
  });
});

describe("AnthropicProvider — parse/validate/repair contract (LP-2, TD-3)", () => {
  it("returns a valid shortlist read from the tool_use input", async () => {
    const { client } = replyClient(validShortlist);
    const provider = new AnthropicProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
      validShortlist,
    );
  });

  it("returns valid peer-peer and consumer-provider suggestion sets", async () => {
    await expect(
      new AnthropicProvider({
        config,
        client: replyClient(validPeerPeerSet).client,
      }).generateMappingProposal(peerPeerDetailContext),
    ).resolves.toEqual(validPeerPeerSet);

    await expect(
      new AnthropicProvider({
        config,
        client: replyClient(validConsumerProviderSet).client,
      }).generateMappingProposal(consumerProviderDetailContext),
    ).resolves.toEqual(validConsumerProviderSet);
  });

  it("applies the shared repair pass (clamps out-of-range confidence)", async () => {
    const { client } = replyClient(outOfRangeConfidenceShortlist);
    const result = await new AnthropicProvider({ config, client }).shortlistResourcePairs(
      shortlistContext,
    );
    expect(result.candidatePairs.map((pair) => pair.confidence)).toEqual([1, 0]);
  });

  it("applies the shared repair pass (trims padded refs)", async () => {
    const { client } = replyClient(paddedRefsShortlist);
    const result = await new AnthropicProvider({ config, client }).shortlistResourcePairs(
      shortlistContext,
    );
    expect(result.candidatePairs[0]?.sourceResource).toBe("issues");
    expect(result.candidatePairs[0]?.targetResource).toBe("tasks");
  });

  it("throws LLMOutputValidationError (carrying the raw output) on a malformed answer", async () => {
    const { client } = replyClient(malformedShortlist);
    const provider = new AnthropicProvider({ config, client });

    const error = await provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMOutputValidationError);
    if (error instanceof LLMOutputValidationError) {
      expect(error.rawOutput).toBe(JSON.stringify(malformedShortlist));
    }
  });
});

describe("AnthropicProvider — transport failures (LP-2)", () => {
  it("throws LLMTransportError when the client fails (network error)", async () => {
    const client: AnthropicMessagesClient = {
      createMessage: () => Promise.reject(new Error("ECONNRESET")),
    };
    const provider = new AnthropicProvider({ config, client });

    const error = await provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMTransportError);
    if (error instanceof LLMTransportError) {
      expect(error.timedOut).toBe(false);
    }
  });

  it("treats a response with no matching tool_use block as a transport failure", async () => {
    const client: AnthropicMessagesClient = {
      createMessage: () =>
        Promise.resolve({
          content: [{ type: "text" }],
          usage: { inputTokens: 5, outputTokens: 0 },
          stopReason: "end_turn",
        }),
    };
    const provider = new AnthropicProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      LLMTransportError,
    );
  });

  it("aborts and throws a timed-out LLMTransportError past requestTimeoutMs", async () => {
    vi.useFakeTimers();
    const client: AnthropicMessagesClient = {
      createMessage: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    const provider = new AnthropicProvider({
      config: { ...config, requestTimeoutMs: 1_000 },
      client,
    });

    const settled = provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(error).toBeInstanceOf(LLMTransportError);
    if (error instanceof LLMTransportError) {
      expect(error.timedOut).toBe(true);
    }
  });
});

describe("AnthropicProvider — token-usage seam (deliverable 7)", () => {
  it("maps input/output tokens onto lastUsage (no model wall time reported)", async () => {
    const { client } = replyClient(validShortlist, {
      usage: { inputTokens: 128, outputTokens: 64 },
    });
    const provider = new AnthropicProvider({ config, client });
    await provider.shortlistResourcePairs(shortlistContext);
    expect(provider.lastUsage).toEqual({ promptEvalCount: 128, evalCount: 64 });
  });

  it("records usage even when the answer fails validation (tokens were spent)", async () => {
    const { client } = replyClient(malformedShortlist, {
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const provider = new AnthropicProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      LLMOutputValidationError,
    );
    expect(provider.lastUsage).toEqual({ promptEvalCount: 10, evalCount: 5 });
  });

  it("resets usage to undefined after a transport failure", async () => {
    const client: AnthropicMessagesClient = {
      createMessage: () => Promise.reject(new Error("ECONNRESET")),
    };
    const provider = new AnthropicProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      LLMTransportError,
    );
    expect(provider.lastUsage).toBeUndefined();
  });
});

describe("AnthropicProvider — API key configuration", () => {
  it("throws AnthropicConfigError when no client and no api key are provided", () => {
    expect(() => new AnthropicProvider({ config })).toThrow(AnthropicConfigError);
  });

  it("constructs an SDK-backed client (no throw) when an api key is present", () => {
    expect(
      () => new AnthropicProvider({ config: { ...config, anthropicApiKey: "sk-ant-test" } }),
    ).not.toThrow();
  });
});

describe("createAnthropicSdkClient — default SDK client factory", () => {
  it("returns a client exposing createMessage", () => {
    const client = createAnthropicSdkClient("sk-ant-test", { timeoutMs: 1_000, maxRetries: 0 });
    expect(typeof client.createMessage).toBe("function");
  });
});
