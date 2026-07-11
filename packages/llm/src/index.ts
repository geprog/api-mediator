/**
 * `@mediator/llm` — the pluggable LLM provider slice of the Mapping Engine.
 *
 * It provides the provider abstraction (`LLMMappingProvider` + the two prompt
 * contexts), the shared response schemas + Ollama `format` derivations + prompt
 * templating that every provider behaves identically through, and two providers:
 * the real `OllamaProvider` and the deterministic `FakeProvider`. Each provider
 * call performs exactly ONE model call, then validates the output — resolving
 * with the typed value or rejecting with `LLMOutputValidationError` /
 * `LLMTransportError`.
 *
 * This slice is deliberately I/O-scoped to "call a model, get validated
 * structured output". It does NOT run the two-stage engine: candidate
 * enumeration, the corrective-retry LOOP, the two failure blast radii,
 * `shortlistResult` enrichment, and persistence are the mapping-engine slice.
 * It depends only on `@mediator/domain` (the structured-output shapes) and
 * `@mediator/config` (the LLM config type), plus `zod` (JSON-Schema derivation).
 */

export {
  LLMError,
  LLMOutputValidationError,
  LLMTransportError,
  type ValidationIssue,
} from "./errors.js";

export {
  buildGeneratedBy,
  type LLMMappingProvider,
  type LlmUsage,
  type MappingPromptContext,
  type PriorMappingFeedback,
  type ResourceSummary,
  type ShortlistPromptContext,
  type SpecSummaryIR,
} from "./provider.js";

export {
  consumerProviderDetailFormat,
  detailFormatFor,
  peerPeerDetailFormat,
  shortlistFormat,
  validateShortlistContent,
  validateSuggestionSetContent,
  type OllamaFormat,
} from "./schemas.js";

export {
  buildDetailPrompt,
  buildShortlistPrompt,
  PROMPT_VERSION,
  type ChatMessage,
} from "./prompt.js";

export {
  createFetchOllamaClient,
  OllamaProvider,
  type OllamaChatRequest,
  type OllamaHttpClient,
  type OllamaProviderOptions,
} from "./ollama-provider.js";

export {
  AnthropicConfigError,
  AnthropicProvider,
  createAnthropicSdkClient,
  type AnthropicContentBlock,
  type AnthropicMessagesClient,
  type AnthropicOtherBlock,
  type AnthropicProviderOptions,
  type AnthropicResponse,
  type AnthropicToolDef,
  type AnthropicToolRequest,
  type AnthropicToolUseBlock,
  type AnthropicUsage,
} from "./anthropic-provider.js";

export {
  FakeProvider,
  FakeProviderScriptError,
  type FakeProviderScript,
  type ScriptedOutput,
} from "./fake-provider.js";
