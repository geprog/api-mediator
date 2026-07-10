import { describe, expect, it } from "vitest";

import { LLMOutputValidationError } from "./errors.js";
import {
  consumerProviderDetailFormat,
  detailFormatFor,
  peerPeerDetailFormat,
  shortlistFormat,
  validateShortlistContent,
  validateSuggestionSetContent,
} from "./schemas.js";
import {
  malformedShortlist,
  twoIdentityCandidatesSet,
  validConsumerProviderSet,
  validPeerPeerSet,
  validShortlist,
  wrongVariantPeerPeerSet,
} from "./fixtures.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Property names of an object schema (`{ properties: {...} }`), or `[]`. */
function objectSchemaProps(schema: unknown): readonly string[] {
  if (!isRecord(schema)) return [];
  const props = schema["properties"];
  return isRecord(props) ? Object.keys(props) : [];
}

/** Property names of the `items` object schema of an array schema, or `[]`. */
function fieldSchemaProps(arraySchema: unknown): readonly string[] {
  return isRecord(arraySchema) ? objectSchemaProps(arraySchema["items"]) : [];
}

describe("validateShortlistContent", () => {
  it("accepts a valid ResourceShortlist answer", () => {
    expect(validateShortlistContent(JSON.stringify(validShortlist))).toEqual(validShortlist);
  });

  it("throws LLMOutputValidationError with raw output + issues on a malformed answer", () => {
    const raw = JSON.stringify(malformedShortlist);
    try {
      validateShortlistContent(raw);
      expect.unreachable("expected validation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LLMOutputValidationError);
      if (error instanceof LLMOutputValidationError) {
        expect(error.rawOutput).toBe(raw);
        expect(error.issues.length).toBeGreaterThan(0);
      }
    }
  });

  it("treats non-JSON content as a malformed output (not a transport failure)", () => {
    try {
      validateShortlistContent("this is not json");
      expect.unreachable("expected validation to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LLMOutputValidationError);
      if (error instanceof LLMOutputValidationError) {
        expect(error.rawOutput).toBe("this is not json");
        expect(error.issues[0]?.path).toBe("");
      }
    }
  });
});

describe("validateSuggestionSetContent", () => {
  it("accepts a valid peer-peer set under the peer-peer variant", () => {
    expect(validateSuggestionSetContent(JSON.stringify(validPeerPeerSet), "peer-peer")).toEqual(
      validPeerPeerSet,
    );
  });

  it("accepts a valid consumer-provider set under the consumer-provider variant", () => {
    expect(
      validateSuggestionSetContent(JSON.stringify(validConsumerProviderSet), "consumer-provider"),
    ).toEqual(validConsumerProviderSet);
  });

  it("rejects a peer-peer answer carrying a wrong-variant `phase` field", () => {
    expect(() =>
      validateSuggestionSetContent(JSON.stringify(wrongVariantPeerPeerSet), "peer-peer"),
    ).toThrow(LLMOutputValidationError);
  });

  it("rejects more than one identityCandidate per resource pair", () => {
    expect(() =>
      validateSuggestionSetContent(JSON.stringify(twoIdentityCandidatesSet), "peer-peer"),
    ).toThrow(LLMOutputValidationError);
  });

  it("rejects a consumer-provider answer validated under the peer-peer variant", () => {
    expect(() =>
      validateSuggestionSetContent(JSON.stringify(validConsumerProviderSet), "peer-peer"),
    ).toThrow(LLMOutputValidationError);
  });
});

describe("derived Ollama `format` schemas", () => {
  it("shortlist format is a well-formed object schema over candidatePairs", () => {
    expect(isRecord(shortlistFormat)).toBe(true);
    expect(shortlistFormat.type).toBe("object");
    expect(objectSchemaProps(shortlistFormat)).toContain("candidatePairs");
  });

  it("peer-peer detail format constrains to the peer-peer shape", () => {
    expect(peerPeerDetailFormat.additionalProperties).toBe(false);
    const props = objectSchemaProps(peerPeerDetailFormat);
    expect(props).toContain("fieldMappings");
    expect(props).not.toContain("parameterMappings");

    const fieldProps = fieldSchemaProps(
      isRecord(peerPeerDetailFormat.properties)
        ? peerPeerDetailFormat.properties["fieldMappings"]
        : undefined,
    );
    expect(fieldProps).toContain("identityCandidate");
    expect(fieldProps).not.toContain("phase");
  });

  it("consumer-provider detail format constrains to the consumer-provider shape", () => {
    const props = objectSchemaProps(consumerProviderDetailFormat);
    expect(props).toContain("parameterMappings");

    const fieldProps = fieldSchemaProps(
      isRecord(consumerProviderDetailFormat.properties)
        ? consumerProviderDetailFormat.properties["fieldMappings"]
        : undefined,
    );
    expect(fieldProps).toContain("phase");
    expect(fieldProps).not.toContain("identityCandidate");
  });

  it("detailFormatFor returns the variant-correct format", () => {
    expect(detailFormatFor("peer-peer")).toBe(peerPeerDetailFormat);
    expect(detailFormatFor("consumer-provider")).toBe(consumerProviderDetailFormat);
  });
});
