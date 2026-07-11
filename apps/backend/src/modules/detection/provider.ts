import type { MappingLlmConfig } from "@mediator/config";
import { OllamaProvider, type LLMMappingProvider } from "@mediator/llm";

/** Thrown when `config.mappingLlm.provider` names a provider that is not wired. */
export class UnsupportedMappingProviderError extends Error {
  public constructor(provider: string) {
    super(`Unsupported mapping LLM provider: ${provider}`);
    this.name = "UnsupportedMappingProviderError";
  }
}

/**
 * Build the active {@link LLMMappingProvider} from config (LP-2 wiring). Provider
 * selection is config-driven (`config.mappingLlm.provider`): `ollama` is the only
 * one wired today, but the interface stays pluggable — a new provider is one more
 * `case` here, nothing else in the engine changes.
 */
export function createMappingProvider(config: MappingLlmConfig): LLMMappingProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider({ config });
    default:
      throw new UnsupportedMappingProviderError(config.provider);
  }
}
