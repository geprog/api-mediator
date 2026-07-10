import type { MappingLlmConfig } from "@mediator/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LLMOutputValidationError, LLMTransportError } from "./errors.js";
import {
  createFetchOllamaClient,
  OllamaProvider,
  type OllamaChatRequest,
  type OllamaHttpClient,
} from "./ollama-provider.js";
import { buildShortlistPrompt } from "./prompt.js";
import { consumerProviderDetailFormat, peerPeerDetailFormat, shortlistFormat } from "./schemas.js";
import {
  consumerProviderDetailContext,
  malformedShortlist,
  peerPeerDetailContext,
  shortlistContext,
  validConsumerProviderSet,
  validPeerPeerSet,
  validShortlist,
} from "./fixtures.js";

const config: MappingLlmConfig = {
  provider: "ollama",
  ollamaBaseUrl: "http://localhost:11434",
  model: "test-model",
  temperature: 0,
  thinking: true,
  requestTimeoutMs: 5_000,
  maxRetries: 3,
};

/** A mock client that records the last request and replies with a fixed content string. */
function replyClient(
  content: string,
  extraMessageFields: Record<string, unknown> = {},
): {
  client: OllamaHttpClient;
  lastRequest: () => OllamaChatRequest | undefined;
} {
  let last: OllamaChatRequest | undefined;
  const client: OllamaHttpClient = {
    chat(request) {
      last = request;
      return Promise.resolve({ message: { role: "assistant", content, ...extraMessageFields } });
    },
  };
  return { client, lastRequest: () => last };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("OllamaProvider — request shape (LP-2)", () => {
  it("sends one shortlist call with the shortlist format, temperature, think, and model", async () => {
    const { client, lastRequest } = replyClient(JSON.stringify(validShortlist));
    const provider = new OllamaProvider({ config, client });

    await provider.shortlistResourcePairs(shortlistContext);

    const request = lastRequest();
    expect(request?.model).toBe("test-model");
    expect(request?.stream).toBe(false);
    expect(request?.options.temperature).toBe(0);
    expect(request?.think).toBe(true);
    expect(request?.format).toBe(shortlistFormat);
    expect(request?.messages).toEqual(buildShortlistPrompt(shortlistContext));
  });

  it("uses the variant-correct detail format for each variant", async () => {
    const peer = replyClient(JSON.stringify(validPeerPeerSet));
    await new OllamaProvider({ config, client: peer.client }).generateMappingProposal(
      peerPeerDetailContext,
    );
    expect(peer.lastRequest()?.format).toBe(peerPeerDetailFormat);

    const consumer = replyClient(JSON.stringify(validConsumerProviderSet));
    await new OllamaProvider({ config, client: consumer.client }).generateMappingProposal(
      consumerProviderDetailContext,
    );
    expect(consumer.lastRequest()?.format).toBe(consumerProviderDetailFormat);
  });

  it("reports its provider identity for provenance", () => {
    const provider = new OllamaProvider({ config, client: replyClient("{}").client });
    expect(provider.providerId).toBe("ollama");
    expect(provider.model).toBe("test-model");
  });
});

describe("OllamaProvider — parse/validate contract (LP-2, TD-3)", () => {
  it("parses and returns a valid response", async () => {
    const { client } = replyClient(JSON.stringify(validShortlist));
    const provider = new OllamaProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
      validShortlist,
    );
  });

  it("strips the thinking channel and reads only message.content", async () => {
    const { client } = replyClient(JSON.stringify(validShortlist), {
      thinking: "Let me reason... { this would break JSON if it were the answer }",
    });
    const provider = new OllamaProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
      validShortlist,
    );
  });

  it("throws LLMOutputValidationError (carrying raw output) on a malformed answer", async () => {
    const raw = JSON.stringify(malformedShortlist);
    const { client } = replyClient(raw);
    const provider = new OllamaProvider({ config, client });

    const error = await provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMOutputValidationError);
    if (error instanceof LLMOutputValidationError) {
      expect(error.rawOutput).toBe(raw);
    }
  });
});

describe("OllamaProvider — transport failures (LP-2)", () => {
  it("throws LLMTransportError when the client fails (network error)", async () => {
    const client: OllamaHttpClient = {
      chat: () => Promise.reject(new Error("ECONNREFUSED")),
    };
    const provider = new OllamaProvider({ config, client });

    const error = await provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMTransportError);
    if (error instanceof LLMTransportError) {
      expect(error.timedOut).toBe(false);
    }
  });

  it("aborts and throws a timed-out LLMTransportError past requestTimeoutMs", async () => {
    vi.useFakeTimers();
    const client: OllamaHttpClient = {
      chat: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    const provider = new OllamaProvider({ config: { ...config, requestTimeoutMs: 1_000 }, client });

    const settled = provider.shortlistResourcePairs(shortlistContext).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(error).toBeInstanceOf(LLMTransportError);
    if (error instanceof LLMTransportError) {
      expect(error.timedOut).toBe(true);
    }
  });

  it("passes an envelope without message.content through as a transport failure", async () => {
    const client: OllamaHttpClient = {
      chat: () => Promise.resolve({ message: { role: "assistant" } }),
    };
    const provider = new OllamaProvider({ config, client });
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      LLMTransportError,
    );
  });
});

describe("createFetchOllamaClient — default fetch client", () => {
  const request: OllamaChatRequest = {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    format: shortlistFormat,
    options: { temperature: 0 },
    think: false,
    stream: false,
  };

  it("POSTs to /api/chat and returns the parsed body", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      capturedUrl =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        new Response(JSON.stringify({ message: { content: "{}" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };

    const client = createFetchOllamaClient("http://localhost:11434/", fetchImpl);
    const payload = await client.chat(request, new AbortController().signal);

    expect(capturedUrl).toBe("http://localhost:11434/api/chat");
    expect(capturedBody).toContain("test-model");
    expect(payload).toEqual({ message: { content: "{}" } });
  });

  it("throws LLMTransportError on a non-2xx response", async () => {
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response("nope", { status: 500 }));
    const client = createFetchOllamaClient("http://localhost:11434", fetchImpl);
    await expect(client.chat(request, new AbortController().signal)).rejects.toBeInstanceOf(
      LLMTransportError,
    );
  });

  it("throws LLMTransportError when fetch rejects", async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("network down"));
    const client = createFetchOllamaClient("http://localhost:11434", fetchImpl);
    await expect(client.chat(request, new AbortController().signal)).rejects.toBeInstanceOf(
      LLMTransportError,
    );
  });
});
