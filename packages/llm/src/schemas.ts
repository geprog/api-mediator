import {
  consumerProviderMappingSuggestionSetSchema,
  peerPeerMappingSuggestionSetSchema,
  resourceShortlistSchema,
  type MappingSuggestionSet,
  type MappingVariant,
  type ResourceShortlist,
} from "@mediator/domain";
import { z } from "zod";

import { LLMOutputValidationError, type ValidationIssue } from "./errors.js";

/**
 * The shared response schemas and their Ollama `format` derivations, owned here
 * so **every** provider (and every test) validates identically (TD-3). The Zod
 * schemas themselves are the domain kernel's `resourceShortlistSchema` /
 * `peerPeerMappingSuggestionSetSchema` / `consumerProviderMappingSuggestionSetSchema`
 * — glossary entities live only in `@mediator/domain`; this module derives the
 * JSON Schema handed to Ollama's schema-constrained decoder from them and wraps
 * validation into the provider contract's typed failure.
 *
 * The per-`variant` detail schemas are what make the `format` shape-correct:
 * the peer-peer schema requires `variant: "peer-peer"`, carries `identityCandidate`
 * and forbids `phase`/`parameterMappings` (`additionalProperties: false`); the
 * consumer-provider schema requires `phase` + `parameterMappings` and forbids
 * `identityCandidate`. Constrained decoding therefore cannot emit the wrong shape.
 */

/**
 * The JSON-Schema object type Ollama's `format` field accepts. `z.toJSONSchema`'s
 * single-schema overload returns a `ZodStandardJSONSchemaPayload<T>` that extends
 * this base type; widening to the base keeps the three derived formats one type.
 */
export type OllamaFormat = z.core.JSONSchema.BaseSchema;

/**
 * `draft-7` + inlined reuse: llama.cpp's JSON-Schema→grammar builder (what Ollama
 * uses for `format`) handles draft-07 constructs reliably, and inlining reused
 * sub-schemas avoids `$ref`/`$defs` indirection in the grammar.
 */
const jsonSchemaOptions = { target: "draft-7", reused: "inline" } as const;

/** Stage-1 `format`: derived from the domain `ResourceShortlist` schema. */
export const shortlistFormat: OllamaFormat = z.toJSONSchema(
  resourceShortlistSchema,
  jsonSchemaOptions,
);

/** Stage-2 peer-peer `format`: `identityCandidate`, no `phase`/`parameterMappings`. */
export const peerPeerDetailFormat: OllamaFormat = z.toJSONSchema(
  peerPeerMappingSuggestionSetSchema,
  jsonSchemaOptions,
);

/** Stage-2 consumer-provider `format`: `phase` + `parameterMappings`, no `identityCandidate`. */
export const consumerProviderDetailFormat: OllamaFormat = z.toJSONSchema(
  consumerProviderMappingSuggestionSetSchema,
  jsonSchemaOptions,
);

/** The variant-correct detail `format` for the stage-2 call. */
export function detailFormatFor(variant: MappingVariant): OllamaFormat {
  return variant === "peer-peer" ? peerPeerDetailFormat : consumerProviderDetailFormat;
}

// ── Validation (the provider contract's parse-then-validate step) ────────────

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

/**
 * Parse the model's raw answer string as JSON. With schema-constrained decoding
 * the content is always syntactically valid JSON, so a parse failure is itself a
 * malformed-output condition the engine should re-prompt on — hence it surfaces
 * as {@link LLMOutputValidationError}, not a transport error.
 */
function parseJsonContent(rawContent: string): unknown {
  try {
    return JSON.parse(rawContent);
  } catch (cause) {
    throw new LLMOutputValidationError(
      "model output was not valid JSON",
      rawContent,
      [{ path: "", message: cause instanceof Error ? cause.message : "invalid JSON" }],
      cause,
    );
  }
}

/**
 * Validate a stage-1 answer string into a {@link ResourceShortlist}, or throw
 * {@link LLMOutputValidationError} carrying the raw output + issues. Shared by
 * both the Ollama and fake providers so their validate boundary is identical.
 */
export function validateShortlistContent(rawContent: string): ResourceShortlist {
  const parsed = parseJsonContent(rawContent);
  const result = resourceShortlistSchema.safeParse(parsed);
  if (!result.success) {
    throw new LLMOutputValidationError(
      "shortlist output failed schema validation",
      rawContent,
      toIssues(result.error),
    );
  }
  return result.data;
}

/**
 * Validate a stage-2 answer string into the variant's `MappingSuggestionSet`, or
 * throw {@link LLMOutputValidationError}. The variant selects the per-variant
 * schema, so a wrong-variant answer (e.g. a `phase` on a peer-peer field, a
 * `parameterMappings` on a peer-peer set) is rejected here, not silently kept.
 */
export function validateSuggestionSetContent(
  rawContent: string,
  variant: MappingVariant,
): MappingSuggestionSet {
  const parsed = parseJsonContent(rawContent);
  if (variant === "peer-peer") {
    const result = peerPeerMappingSuggestionSetSchema.safeParse(parsed);
    if (!result.success) {
      throw new LLMOutputValidationError(
        "peer-peer detail output failed schema validation",
        rawContent,
        toIssues(result.error),
      );
    }
    return result.data;
  }
  const result = consumerProviderMappingSuggestionSetSchema.safeParse(parsed);
  if (!result.success) {
    throw new LLMOutputValidationError(
      "consumer-provider detail output failed schema validation",
      rawContent,
      toIssues(result.error),
    );
  }
  return result.data;
}
