import type { MappingLlmConfig } from "@mediator/config";
import type { MappingSuggestionSet, ResourceShortlist } from "@mediator/domain";

import { LLMTransportError } from "./errors.js";
import { buildDetailPrompt, buildShortlistPrompt, type ChatMessage } from "./prompt.js";
import type {
  LLMMappingProvider,
  LlmUsage,
  MappingPromptContext,
  ShortlistPromptContext,
} from "./provider.js";
import {
  detailFormatFor,
  shortlistFormat,
  validateShortlistContent,
  validateSuggestionSetContent,
  type OllamaFormat,
} from "./schemas.js";

/**
 * `OllamaProvider` (LP-2) — the real `LLMMappingProvider` backed by a self-hosted
 * Ollama model. Each method issues exactly ONE `/api/chat` call with the stage's
 * derived JSON Schema as Ollama's `format` (schema-constrained decoding), reads
 * only `message.content` (ignoring the model's separate `thinking` channel),
 * validates it, and returns the typed value or throws per the provider contract.
 *
 * The HTTP client is injectable so the provider is unit-testable without a live
 * server (the default is a `fetch`-based client). The request-timeout
 * (`config.requestTimeoutMs`) is owned by the provider via an `AbortController`,
 * so timeout behavior is testable independently of the client.
 */

/** The Ollama `/api/chat` request body this provider sends (`stream: false`). */
export interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly format: OllamaFormat;
  readonly options: { readonly temperature: number };
  /** Ollama's thinking-model toggle; the returned `thinking` channel is ignored. */
  readonly think: boolean;
  readonly stream: false;
}

/**
 * The seam the provider calls to reach Ollama. Resolve with the parsed JSON
 * response body (`unknown`, narrowed by the provider); reject to signal a
 * transport failure. Injectable so tests never touch the network.
 */
export interface OllamaHttpClient {
  chat(request: OllamaChatRequest, signal: AbortSignal): Promise<unknown>;
}

export interface OllamaProviderOptions {
  readonly config: MappingLlmConfig;
  /** Defaults to a `fetch`-based client pointed at `config.ollamaBaseUrl`. */
  readonly client?: OllamaHttpClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow the Ollama response envelope to `message.content`. A missing/misshaped
 * envelope is a protocol/transport problem (the server did not speak Ollama),
 * distinct from a schema-invalid model answer — hence {@link LLMTransportError},
 * not a validation error. The `thinking` channel, if present, is deliberately
 * ignored here.
 */
function extractContent(payload: unknown): string {
  if (!isRecord(payload)) {
    throw new LLMTransportError("Ollama response was not a JSON object");
  }
  const message = payload["message"];
  if (!isRecord(message)) {
    throw new LLMTransportError("Ollama response was missing `message`");
  }
  const content = message["content"];
  if (typeof content !== "string") {
    throw new LLMTransportError("Ollama response was missing `message.content`");
  }
  return content;
}

/**
 * Read the token/timing counters from an Ollama `/api/chat` response envelope
 * into an {@link LlmUsage}. The counters are best-effort: a model/version that
 * omits one yields `0` for that count (never throws — usage is observability, not
 * a business-critical path). `total_duration` is nanoseconds in the envelope, so
 * it is divided down to milliseconds; it is omitted from the result when absent.
 */
function extractUsage(payload: unknown): LlmUsage {
  const envelope = isRecord(payload) ? payload : {};
  const promptEvalCount =
    typeof envelope["prompt_eval_count"] === "number" ? envelope["prompt_eval_count"] : 0;
  const evalCount = typeof envelope["eval_count"] === "number" ? envelope["eval_count"] : 0;
  const totalDurationNs =
    typeof envelope["total_duration"] === "number" ? envelope["total_duration"] : undefined;
  return totalDurationNs === undefined
    ? { promptEvalCount, evalCount }
    : { promptEvalCount, evalCount, totalDurationMs: totalDurationNs / 1_000_000 };
}

/**
 * The default `fetch`-based {@link OllamaHttpClient}. POSTs to `${baseUrl}/api/chat`
 * and returns the parsed JSON body; every failure mode (network, non-2xx, invalid
 * body) becomes an {@link LLMTransportError}.
 */
export function createFetchOllamaClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): OllamaHttpClient {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
  return {
    async chat(request: OllamaChatRequest, signal: AbortSignal): Promise<unknown> {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal,
        });
      } catch (cause) {
        throw new LLMTransportError("Ollama request failed", { cause, timedOut: signal.aborted });
      }
      if (!response.ok) {
        throw new LLMTransportError(`Ollama responded with HTTP ${String(response.status)}`);
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new LLMTransportError("Ollama response body was not valid JSON", { cause });
      }
    },
  };
}

export class OllamaProvider implements LLMMappingProvider {
  public readonly providerId = "ollama";
  public readonly model: string;
  /** Usage/timing of the most recent call — see {@link LLMMappingProvider.lastUsage}. */
  public lastUsage: LlmUsage | undefined = undefined;
  private readonly config: MappingLlmConfig;
  private readonly client: OllamaHttpClient;

  public constructor(options: OllamaProviderOptions) {
    this.config = options.config;
    this.model = options.config.model;
    this.client = options.client ?? createFetchOllamaClient(options.config.ollamaBaseUrl);
  }

  public async shortlistResourcePairs(context: ShortlistPromptContext): Promise<ResourceShortlist> {
    const content = await this.call(buildShortlistPrompt(context), shortlistFormat);
    return validateShortlistContent(content);
  }

  public async generateMappingProposal(
    context: MappingPromptContext,
  ): Promise<MappingSuggestionSet> {
    const content = await this.call(buildDetailPrompt(context), detailFormatFor(context.variant));
    return validateSuggestionSetContent(content, context.variant);
  }

  /**
   * One model call: build the request, enforce `requestTimeoutMs` via an
   * `AbortController`, and return the raw `message.content`. Any client failure
   * (or the timeout abort) is normalized to {@link LLMTransportError}; validation
   * of the content is the caller's step.
   */
  private async call(messages: readonly ChatMessage[], format: OllamaFormat): Promise<string> {
    const request: OllamaChatRequest = {
      model: this.config.model,
      messages,
      format,
      options: { temperature: this.config.temperature },
      think: this.config.thinking,
      stream: false,
    };

    // Reset before the call so a transport failure leaves no stale usage behind.
    this.lastUsage = undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs);

    let payload: unknown;
    try {
      payload = await this.client.chat(request, controller.signal);
    } catch (cause) {
      if (cause instanceof LLMTransportError) {
        throw cause;
      }
      throw new LLMTransportError("Ollama request failed", {
        cause,
        timedOut: controller.signal.aborted,
      });
    } finally {
      clearTimeout(timer);
    }

    const content = extractContent(payload);
    // Record usage before the caller validates: a validation-failing attempt
    // still consumed tokens, so its usage must survive the thrown error.
    this.lastUsage = extractUsage(payload);
    return content;
  }
}
