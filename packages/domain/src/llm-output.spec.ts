import { describe, expect, it } from "vitest";

import {
  type ConsumerProviderFieldSuggestion,
  type ConsumerProviderMappingSuggestionSet,
  mappingSuggestionSetSchema,
  type OperationSuggestion,
  type PeerPeerFieldSuggestion,
  type PeerPeerMappingSuggestionSet,
  resourceShortlistSchema,
} from "./index.js";

// ── Stage 1: ResourceShortlist ───────────────────────────────────────────────

describe("ResourceShortlist schema", () => {
  it("accepts a valid shortlist of candidate pairs", () => {
    const result = resourceShortlistSchema.safeParse({
      candidatePairs: [
        {
          sourceResource: "issues",
          targetResource: "tasks",
          confidence: 0.92,
          rationale: "both track work items",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty candidatePairs list (no plausible correspondences)", () => {
    expect(resourceShortlistSchema.safeParse({ candidatePairs: [] }).success).toBe(true);
  });

  it("rejects a candidate pair with confidence out of the 0..1 range", () => {
    const result = resourceShortlistSchema.safeParse({
      candidatePairs: [
        { sourceResource: "issues", targetResource: "tasks", confidence: 1.5, rationale: "x" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a shortlist missing candidatePairs", () => {
    expect(resourceShortlistSchema.safeParse({}).success).toBe(false);
  });
});

// ── Stage 2: builders ─────────────────────────────────────────────────────────

function operationSuggestion(): OperationSuggestion {
  return {
    sourceOperationId: "issueSearchIssues",
    targetOperationId: "tasks_list",
    confidence: 0.8,
    rationale: "both list work items",
    ambiguousAlternatives: [],
    unmapped: false,
  };
}

function peerPeerIdentityField(): PeerPeerFieldSuggestion {
  return {
    sourceField: "title",
    targetField: "title",
    transform: "rename",
    transformDetail: "identity",
    identityCandidate: true,
    confidence: 0.95,
    rationale: "same business title",
    ambiguousAlternatives: [{ targetField: "name", confidence: 0.4 }],
    unmapped: false,
  };
}

function consumerProviderResponseField(): ConsumerProviderFieldSuggestion {
  return {
    sourceField: "name",
    targetField: "label",
    phase: "response",
    transform: "rename",
    transformDetail: "identity",
    confidence: 0.8,
    rationale: "same label",
    ambiguousAlternatives: [],
    unmapped: false,
  };
}

function peerPeerSet(): PeerPeerMappingSuggestionSet {
  return {
    variant: "peer-peer",
    operationMappings: [operationSuggestion()],
    fieldMappings: [peerPeerIdentityField()],
  };
}

function consumerProviderSet(): ConsumerProviderMappingSuggestionSet {
  return {
    variant: "consumer-provider",
    operationMappings: [operationSuggestion()],
    fieldMappings: [consumerProviderResponseField()],
    parameterMappings: [
      {
        sourceOperationId: "getWidget",
        targetOperationId: "backendGetWidget",
        sourceParam: "id",
        targetParam: "widgetId",
        confidence: 0.9,
        rationale: "path id",
        unmapped: false,
      },
    ],
  };
}

// ── Stage 2: peer-peer ────────────────────────────────────────────────────────

describe("MappingSuggestionSet — peer-peer", () => {
  it("accepts a valid peer-peer set (identityCandidate on a rename, no phase)", () => {
    expect(mappingSuggestionSetSchema.safeParse(peerPeerSet()).success).toBe(true);
  });

  it("rejects a peer-peer field suggestion that carries a phase", () => {
    const withPhase: Record<string, unknown> = { ...peerPeerIdentityField(), phase: "request" };
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "peer-peer",
      operationMappings: [operationSuggestion()],
      fieldMappings: [withPhase],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a peer-peer set that carries parameterMappings", () => {
    const result = mappingSuggestionSetSchema.safeParse({
      ...peerPeerSet(),
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects identityCandidate on a non-rename (non-value-preserving) pairing", () => {
    const bad: PeerPeerFieldSuggestion = {
      ...peerPeerIdentityField(),
      transform: "expression",
      identityCandidate: true,
    };
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "peer-peer",
      operationMappings: [operationSuggestion()],
      fieldMappings: [bad],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than one identityCandidate: true per resource pair", () => {
    const second: PeerPeerFieldSuggestion = {
      sourceField: "ref",
      targetField: "externalRef",
      transform: "rename",
      transformDetail: "identity",
      identityCandidate: true,
      confidence: 0.9,
      rationale: "also unique",
      ambiguousAlternatives: [],
      unmapped: false,
    };
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "peer-peer",
      operationMappings: [operationSuggestion()],
      fieldMappings: [peerPeerIdentityField(), second],
    });
    expect(result.success).toBe(false);
  });
});

// ── Stage 2: consumer-provider ────────────────────────────────────────────────

describe("MappingSuggestionSet — consumer-provider", () => {
  it("accepts a valid consumer-provider set (phased fields + parameterMappings)", () => {
    expect(mappingSuggestionSetSchema.safeParse(consumerProviderSet()).success).toBe(true);
  });

  it("rejects a consumer-provider field suggestion that carries identityCandidate", () => {
    const withIdentity: Record<string, unknown> = {
      ...consumerProviderResponseField(),
      identityCandidate: true,
    };
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "consumer-provider",
      operationMappings: [operationSuggestion()],
      fieldMappings: [withIdentity],
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a consumer-provider field suggestion missing its required phase", () => {
    const withoutPhase: Record<string, unknown> = {
      sourceField: "name",
      targetField: "label",
      transform: "rename",
      transformDetail: "identity",
      confidence: 0.8,
      rationale: "same label",
      ambiguousAlternatives: [],
      unmapped: false,
    };
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "consumer-provider",
      operationMappings: [operationSuggestion()],
      fieldMappings: [withoutPhase],
      parameterMappings: [],
    });
    expect(result.success).toBe(false);
  });
});

// ── Stage 2: discriminant ─────────────────────────────────────────────────────

describe("MappingSuggestionSet — discriminant", () => {
  it("rejects a set with no variant discriminant", () => {
    const anon: Record<string, unknown> = {
      operationMappings: [operationSuggestion()],
      fieldMappings: [peerPeerIdentityField()],
    };
    expect(mappingSuggestionSetSchema.safeParse(anon).success).toBe(false);
  });

  it("rejects an unknown variant", () => {
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "hybrid",
      operationMappings: [operationSuggestion()],
      fieldMappings: [peerPeerIdentityField()],
    });
    expect(result.success).toBe(false);
  });

  it("supports an unmapped operation suggestion with a null target", () => {
    const result = mappingSuggestionSetSchema.safeParse({
      variant: "peer-peer",
      operationMappings: [
        {
          sourceOperationId: "issueDelete",
          targetOperationId: null,
          confidence: 0.2,
          rationale: "no counterpart",
          ambiguousAlternatives: [],
          unmapped: true,
        },
      ],
      fieldMappings: [],
    });
    expect(result.success).toBe(true);
  });
});
