import Anthropic from "@anthropic-ai/sdk";
import type { MappingLlmConfig } from "@mediator/config";
import type { MappingSuggestionSet, ResourceShortlist } from "@mediator/domain";

import { LLMError, LLMTransportError } from "./errors.js";
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
 * `AnthropicProvider` (LP-2, second provider) — an `LLMMappingProvider` backed by
 * the Claude Messages API. It exists to validate the two-stage detection concept
 * with a capable hosted model where a self-hosted CPU model is too slow to measure
 * stage-2 accuracy.
 *
 * Structured output is obtained through **forced tool use**, the Anthropic
 * equivalent of Ollama's schema-constrained `format`: each call declares ONE tool
 * whose `input_schema` is the stage's shared JSON Schema
 * ({@link shortlistFormat} / {@link detailFormatFor}), forces `tool_choice` to that
 * tool, and reads the tool_use block's `input` as the structured answer. Because
 * the schemas, the prompt templates, the repair pass, and the validators are all
 * owned by this package and shared with `OllamaProvider`, both providers behave
 * identically through the provider contract (LP-1 crit 5): one model call, then
 * parse + repair + validate into the typed value, resolving with it or rejecting
 * with `LLMOutputValidationError` / `LLMTransportError`.
 *
 * The Messages client is injectable so the provider is unit-testable without the
 * SDK or the network (the default wraps `@anthropic-ai/sdk`). Like `OllamaProvider`,
 * the request-timeout (`config.requestTimeoutMs`) is owned here via an
 * `AbortController`, so timeout behavior is testable independently of the client.
 *
 * Two config fields carry Ollama-specific semantics that do NOT apply to a forced-
 * tool Claude call and are deliberately not forwarded: `temperature` (a non-default
 * value is rejected by the Sonnet/Opus request surface, so none is sent) and
 * `thinking` (extended thinking is incompatible with a forced `tool_choice`, so it
 * is disabled). Determinism/quality are steered by the prompt instead.
 */

/** The maximum output tokens for a detection call — generous headroom for a large
 * detail set while staying under the SDK's non-streaming HTTP-timeout ceiling. */
const MAX_OUTPUT_TOKENS = 16000;

const SHORTLIST_TOOL_NAME = "emit_resource_shortlist";
const SHORTLIST_TOOL_DESCRIPTION =
  "Emit the resource shortlist as a structured object conforming to the required schema. " +
  "Call this tool exactly once with the complete shortlist.";
const MAPPING_TOOL_NAME = "emit_mapping_suggestions";
const MAPPING_TOOL_DESCRIPTION =
  "Emit the operation-, field-, and (where applicable) parameter-level mapping suggestions as a " +
  "structured object conforming to the required schema. Call this tool exactly once with the " +
  "complete suggestion set.";

/** One tool declaration in an {@link AnthropicToolRequest}. */
export interface AnthropicToolDef {
  readonly name: string;
  readonly description: string;
  /** The stage's shared JSON Schema, used verbatim as the tool's `input_schema`. */
  readonly inputSchema: OllamaFormat;
}

/**
 * The Messages request this provider sends. Carries the FULL request shape — a
 * single tool, a forced `tool_choice`, disabled thinking, and no temperature — so
 * the shape is asserted in unit tests and the client is a dumb serializer (mirrors
 * `OllamaChatRequest`). `system` is the top-level system prompt; `messages` are the
 * user turns (Claude keeps the system prompt out of the `messages` array).
 */
export interface AnthropicToolRequest {
  readonly model: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly [AnthropicToolDef];
  readonly toolChoice: { readonly type: "tool"; readonly name: string };
  readonly thinking: { readonly type: "disabled" };
}

/** A `tool_use` content block in an {@link AnthropicResponse}. */
export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly name: string;
  /** The structured tool input (already parsed to a JS value by the SDK). */
  readonly input: unknown;
}

/** Any non-tool_use content block — carried opaquely; only its `type` is read. */
export interface AnthropicOtherBlock {
  readonly type: string;
}

export type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicOtherBlock;

/** The token counters this provider reads from the Messages response. */
export interface AnthropicUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The minimal Messages response this provider consumes. */
export interface AnthropicResponse {
  readonly content: readonly AnthropicContentBlock[];
  readonly usage: AnthropicUsage;
  readonly stopReason: string | null;
}

/**
 * The seam the provider calls to reach the Messages API. Resolve with the parsed
 * {@link AnthropicResponse}; reject to signal a transport failure. Injectable so
 * tests never touch the SDK or the network.
 */
export interface AnthropicMessagesClient {
  createMessage(request: AnthropicToolRequest, signal: AbortSignal): Promise<AnthropicResponse>;
}

export interface AnthropicProviderOptions {
  readonly config: MappingLlmConfig;
  /** Defaults to an SDK-backed client using `config.anthropicApiKey`. */
  readonly client?: AnthropicMessagesClient;
}

/**
 * Thrown when an SDK-backed {@link AnthropicProvider} is constructed without an
 * API key (`config.anthropicApiKey` / `ANTHROPIC_API_KEY`). A configuration
 * error, distinct from the per-call transport/validation failures.
 */
export class AnthropicConfigError extends LLMError {
  public constructor() {
    super(
      "AnthropicProvider requires an API key: set ANTHROPIC_API_KEY (config.mappingLlm.anthropicApiKey).",
    );
    this.name = "AnthropicConfigError";
  }
}

function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === "tool_use" && "input" in block;
}

/**
 * Narrow the response to the forced tool's `input`, serialized back to a JSON
 * string so the shared validators (which parse-then-repair-then-validate a raw
 * string, identically for every provider) run unchanged. A response with no
 * matching tool_use block means the model did not produce structured output — a
 * protocol/transport problem (e.g. a `max_tokens` truncation or a bare refusal),
 * distinct from a schema-invalid answer — hence {@link LLMTransportError}.
 */
function extractToolInput(response: AnthropicResponse, toolName: string): string {
  const block = response.content.find(
    (candidate): candidate is AnthropicToolUseBlock =>
      isToolUseBlock(candidate) && candidate.name === toolName,
  );
  if (block === undefined) {
    throw new LLMTransportError(
      `Anthropic response contained no \`${toolName}\` tool_use block (stop_reason: ${
        response.stopReason ?? "null"
      })`,
    );
  }
  return JSON.stringify(block.input);
}

/**
 * Read the token counters into an {@link LlmUsage}. Anthropic reports no model
 * wall-clock time, so `totalDurationMs` is omitted (the field is optional).
 */
function extractUsage(response: AnthropicResponse): LlmUsage {
  return { promptEvalCount: response.usage.inputTokens, evalCount: response.usage.outputTokens };
}

/**
 * Split the shared prompt (a system message followed by user messages) into the
 * Messages API shape: the system content becomes the top-level `system` string;
 * the user messages become the `messages` array. Multiple system messages (never
 * produced today) are joined; the corrective-feedback user message flows through.
 */
function splitPrompt(messages: readonly ChatMessage[]): {
  system: string;
  userMessages: readonly ChatMessage[];
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const userMessages = messages.filter((message) => message.role === "user");
  return { system, userMessages };
}

/**
 * The default {@link AnthropicMessagesClient}, wrapping `@anthropic-ai/sdk`. Sends
 * exactly the {@link AnthropicToolRequest} shape (forced tool, disabled thinking,
 * no temperature) and maps the SDK `Message` back to the minimal
 * {@link AnthropicResponse}. Timeout and HTTP retries are configured on the SDK
 * client; the per-request abort signal is forwarded so the provider's own
 * request-timeout still fires. Every failure becomes an {@link LLMTransportError}.
 */
export function createAnthropicSdkClient(
  apiKey: string,
  options: { readonly timeoutMs: number; readonly maxRetries: number },
): AnthropicMessagesClient {
  const client = new Anthropic({
    apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
  });
  return {
    async createMessage(
      request: AnthropicToolRequest,
      signal: AbortSignal,
    ): Promise<AnthropicResponse> {
      let message: Anthropic.Messages.Message;
      try {
        message = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: request.messages.map((turn) => ({
              role: "user" as const,
              content: turn.content,
            })),
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              // Bridge `OllamaFormat` (z.core.JSONSchema.BaseSchema, `type` optional) to
              // the SDK's `Tool.InputSchema` (`type: "object"` required). Runtime-safe:
              // every stage format is a `z.object(...)` derivation, so `type` is always
              // `"object"`; the cast only reconciles the optional-vs-required `type`.
              input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
            })),
            tool_choice: { type: "tool", name: request.toolChoice.name },
            thinking: { type: "disabled" },
          },
          { signal },
        );
      } catch (cause) {
        throw new LLMTransportError("Anthropic request failed", {
          cause,
          timedOut: signal.aborted,
        });
      }
      return {
        content: message.content.map((block) =>
          block.type === "tool_use"
            ? { type: "tool_use", name: block.name, input: block.input }
            : { type: block.type },
        ),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
        stopReason: message.stop_reason,
      };
    },
  };
}

export class AnthropicProvider implements LLMMappingProvider {
  public readonly providerId = "anthropic";
  public readonly model: string;
  /** Usage of the most recent call — see {@link LLMMappingProvider.lastUsage}. */
  public lastUsage: LlmUsage | undefined = undefined;
  private readonly config: MappingLlmConfig;
  private readonly client: AnthropicMessagesClient;

  public constructor(options: AnthropicProviderOptions) {
    this.config = options.config;
    this.model = options.config.model;
    if (options.client !== undefined) {
      this.client = options.client;
    } else {
      const apiKey = options.config.anthropicApiKey;
      if (apiKey === undefined || apiKey === "") {
        throw new AnthropicConfigError();
      }
      this.client = createAnthropicSdkClient(apiKey, {
        timeoutMs: options.config.requestTimeoutMs,
        maxRetries: options.config.maxRetries,
      });
    }
  }

  public async shortlistResourcePairs(context: ShortlistPromptContext): Promise<ResourceShortlist> {
    const content = await this.call(
      buildShortlistPrompt(context),
      SHORTLIST_TOOL_NAME,
      SHORTLIST_TOOL_DESCRIPTION,
      shortlistFormat,
    );
    return validateShortlistContent(content);
  }

  public async generateMappingProposal(
    context: MappingPromptContext,
  ): Promise<MappingSuggestionSet> {
    const content = await this.call(
      buildDetailPrompt(context),
      MAPPING_TOOL_NAME,
      MAPPING_TOOL_DESCRIPTION,
      detailFormatFor(context.variant),
    );
    return validateSuggestionSetContent(content, context.variant);
  }

  /**
   * One model call: build the forced-tool request, enforce `requestTimeoutMs` via
   * an `AbortController`, and return the tool input as a JSON string. Any client
   * failure (or the timeout abort) is normalized to {@link LLMTransportError};
   * repair + validation of the content is the caller's step.
   */
  private async call(
    messages: readonly ChatMessage[],
    toolName: string,
    toolDescription: string,
    inputSchema: OllamaFormat,
  ): Promise<string> {
    const { system, userMessages } = splitPrompt(messages);
    const request: AnthropicToolRequest = {
      model: this.config.model,
      maxTokens: MAX_OUTPUT_TOKENS,
      system,
      messages: userMessages,
      tools: [{ name: toolName, description: toolDescription, inputSchema }],
      toolChoice: { type: "tool", name: toolName },
      thinking: { type: "disabled" },
    };

    // Reset before the call so a transport failure leaves no stale usage behind.
    this.lastUsage = undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.config.requestTimeoutMs);

    let response: AnthropicResponse;
    try {
      response = await this.client.createMessage(request, controller.signal);
    } catch (cause) {
      if (cause instanceof LLMTransportError) {
        throw cause;
      }
      throw new LLMTransportError("Anthropic request failed", {
        cause,
        timedOut: controller.signal.aborted,
      });
    } finally {
      clearTimeout(timer);
    }

    const toolInputJson = extractToolInput(response, toolName);
    // Record usage before the caller validates: a validation-failing attempt still
    // consumed tokens, so its usage must survive the thrown error.
    this.lastUsage = extractUsage(response);
    return toolInputJson;
  }
}
