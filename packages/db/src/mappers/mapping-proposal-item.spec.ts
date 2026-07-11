import type {
  MappingProposalItem,
  ProposalElementRef,
  TransformSuggestion,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapMappingProposalItemRow,
  toMappingProposalItemInsert,
  type MappingProposalItemRow,
} from "./mapping-proposal-item.js";

const opRef = (operationId: string): ProposalElementRef => ({
  resourceRef: "issues",
  target: { kind: "operation", operationId },
});
const fieldRef = (path: string): ProposalElementRef => ({
  resourceRef: "issues",
  target: { kind: "field", path },
});

const renameSuggestion: TransformSuggestion = { transform: "rename" };
const coerceSuggestion: TransformSuggestion = { transform: "coerce", detail: "string→number" };

function itemRow(overrides: Partial<MappingProposalItemRow> = {}): MappingProposalItemRow {
  return {
    id: "item-1",
    proposalId: "prop-1",
    kind: "field",
    sourceRef: fieldRef("title"),
    targetRef: fieldRef("name"),
    phase: null,
    transformSuggestion: renameSuggestion,
    confidenceScore: 0.9,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "same concept",
    reviewState: "pending",
    identityCandidate: null,
    targetLookupParamRef: null,
    ...overrides,
  };
}

describe("mapMappingProposalItemRow — transformSuggestion absent vs null vs object", () => {
  it("mapped operation item: NULL column with unmapped=false becomes domain `null` (present)", () => {
    const item = mapMappingProposalItemRow(
      itemRow({
        kind: "operation",
        sourceRef: opRef("listIssues"),
        targetRef: opRef("listTasks"),
        transformSuggestion: null,
        unmapped: false,
      }),
    );

    expect("transformSuggestion" in item).toBe(true);
    expect(item.transformSuggestion).toBeNull();
  });

  it("unmapped item: NULL column with unmapped=true becomes an ABSENT key (not null)", () => {
    const item = mapMappingProposalItemRow(
      itemRow({
        sourceRef: fieldRef("legacyCode"),
        targetRef: null,
        transformSuggestion: null,
        unmapped: true,
      }),
    );

    // Both targetRef and transformSuggestion are omitted for an unmapped item.
    expect("transformSuggestion" in item).toBe(false);
    expect("targetRef" in item).toBe(false);
    expect(item.unmapped).toBe(true);
  });

  it("mapped field item: an object column round-trips as the suggestion object", () => {
    const item = mapMappingProposalItemRow(
      itemRow({ transformSuggestion: coerceSuggestion, unmapped: false }),
    );

    expect(item.transformSuggestion).toStrictEqual(coerceSuggestion);
  });
});

describe("mapMappingProposalItemRow — phase, targetRef, confidence", () => {
  it("omits a NULL phase (peer-peer field item)", () => {
    const item = mapMappingProposalItemRow(itemRow({ phase: null }));
    expect("phase" in item).toBe(false);
  });

  it("keeps a set phase (consumer-provider field item)", () => {
    const item = mapMappingProposalItemRow(itemRow({ phase: "response" }));
    expect(item.phase).toBe("response");
  });

  it("omits NULL identityCandidate/targetLookupParamRef (non-identity field item)", () => {
    const item = mapMappingProposalItemRow(
      itemRow({ identityCandidate: null, targetLookupParamRef: null }),
    );
    expect("identityCandidate" in item).toBe(false);
    expect("targetLookupParamRef" in item).toBe(false);
  });

  it("round-trips identityCandidate=true + targetLookupParamRef (identity field item)", () => {
    const item = mapMappingProposalItemRow(
      itemRow({ identityCandidate: true, targetLookupParamRef: "filter" }),
    );
    expect(item.identityCandidate).toBe(true);
    expect(item.targetLookupParamRef).toBe("filter");
  });

  it("preserves a stored identityCandidate=false (not collapsed to absent)", () => {
    const item = mapMappingProposalItemRow(itemRow({ identityCandidate: false }));
    expect("identityCandidate" in item).toBe(true);
    expect(item.identityCandidate).toBe(false);
  });

  it("reads confidence_score back as a plain number, preserving full float64 precision", () => {
    // Non-binary-exact values that a float32 (`real`) column would truncate; the
    // `double precision` column preserves them (the DB-boundary proof is in the
    // integration spec — the mapper itself is an identity pass-through).
    for (const confidenceScore of [0.42, 0.7, 0.123456789]) {
      const item = mapMappingProposalItemRow(itemRow({ confidenceScore }));
      expect(typeof item.confidenceScore).toBe("number");
      expect(item.confidenceScore).toBe(confidenceScore);
    }
  });
});

describe("toMappingProposalItemInsert", () => {
  it("operation item: an explicit null transformSuggestion stays a NULL column", () => {
    const item: MappingProposalItem = {
      id: "item-op",
      proposalId: "prop-1",
      kind: "operation",
      sourceRef: opRef("listIssues"),
      targetRef: opRef("listTasks"),
      transformSuggestion: null,
      confidenceScore: 0.7,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "list ↔ list",
      reviewState: "pending",
    };

    const insert = toMappingProposalItemInsert(item);
    expect(insert.transformSuggestion).toBeNull();
    expect(insert.phase).toBeNull();
    expect(insert.targetRef).toStrictEqual(opRef("listTasks"));
  });

  it("unmapped item: an absent transformSuggestion/targetRef become NULL columns", () => {
    const item: MappingProposalItem = {
      id: "item-unmapped",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("legacyCode"),
      confidenceScore: 0.1,
      ambiguousAlternatives: [],
      unmapped: true,
      rationale: "no counterpart",
      reviewState: "pending",
    };

    const insert = toMappingProposalItemInsert(item);
    expect(insert.transformSuggestion).toBeNull();
    expect(insert.targetRef).toBeNull();
    expect(insert.phase).toBeNull();
  });

  it("field item: an object transformSuggestion is stored verbatim", () => {
    const insert = toMappingProposalItemInsert({
      id: "item-field",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("title"),
      targetRef: fieldRef("name"),
      transformSuggestion: coerceSuggestion,
      confidenceScore: 0.9,
      ambiguousAlternatives: [{ targetRef: fieldRef("label"), confidence: 0.4 }],
      unmapped: false,
      rationale: "same concept",
      reviewState: "pending",
    });

    expect(insert.transformSuggestion).toStrictEqual(coerceSuggestion);
    expect(insert.ambiguousAlternatives).toStrictEqual([
      { targetRef: fieldRef("label"), confidence: 0.4 },
    ]);
  });

  it("identity field item: identityCandidate/targetLookupParamRef are written verbatim", () => {
    const insert = toMappingProposalItemInsert({
      id: "item-identity",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("email"),
      targetRef: fieldRef("email"),
      transformSuggestion: renameSuggestion,
      confidenceScore: 0.95,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "shared identity value",
      reviewState: "pending",
      identityCandidate: true,
      targetLookupParamRef: "filter",
    });
    expect(insert.identityCandidate).toBe(true);
    expect(insert.targetLookupParamRef).toBe("filter");
  });

  it("non-identity field item: absent identityCandidate/targetLookupParamRef become NULL columns", () => {
    const insert = toMappingProposalItemInsert({
      id: "item-field",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("title"),
      targetRef: fieldRef("name"),
      transformSuggestion: renameSuggestion,
      confidenceScore: 0.9,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "same concept",
      reviewState: "pending",
    });
    expect(insert.identityCandidate).toBeNull();
    expect(insert.targetLookupParamRef).toBeNull();
  });

  it("preserves a present identityCandidate=false (not collapsed to a NULL column)", () => {
    const insert = toMappingProposalItemInsert({
      id: "item-field-false",
      proposalId: "prop-1",
      kind: "field",
      sourceRef: fieldRef("title"),
      targetRef: fieldRef("name"),
      transformSuggestion: renameSuggestion,
      confidenceScore: 0.9,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "same concept",
      reviewState: "pending",
      identityCandidate: false,
    });
    expect(insert.identityCandidate).toBe(false);
    expect(insert.targetLookupParamRef).toBeNull();
  });
});

describe("insert → row → domain round-trip preserves the three transformSuggestion states", () => {
  // A persisted row is what the DB stores: the insert's nullable columns, with an
  // omitted (undefined) column materializing as NULL — exactly what the read path
  // then reconstructs. Uses the REAL toInsert for the interesting columns.
  function persistedRow(item: MappingProposalItem): MappingProposalItemRow {
    const insert = toMappingProposalItemInsert(item);
    return {
      id: item.id,
      proposalId: item.proposalId,
      kind: item.kind,
      sourceRef: item.sourceRef,
      targetRef: insert.targetRef ?? null,
      phase: insert.phase ?? null,
      transformSuggestion: insert.transformSuggestion ?? null,
      confidenceScore: insert.confidenceScore,
      ambiguousAlternatives: item.ambiguousAlternatives,
      unmapped: item.unmapped,
      rationale: item.rationale,
      reviewState: item.reviewState,
      identityCandidate: insert.identityCandidate ?? null,
      targetLookupParamRef: insert.targetLookupParamRef ?? null,
    };
  }

  const cases: ReadonlyArray<[string, MappingProposalItem]> = [
    [
      "operation (transformSuggestion = null)",
      {
        id: "rt-op",
        proposalId: "prop-1",
        kind: "operation",
        sourceRef: opRef("listIssues"),
        targetRef: opRef("listTasks"),
        transformSuggestion: null,
        confidenceScore: 0.75,
        ambiguousAlternatives: [],
        unmapped: false,
        rationale: "list ↔ list",
        reviewState: "pending",
      },
    ],
    [
      "consumer-provider field (transformSuggestion = object, phase set)",
      {
        id: "rt-field",
        proposalId: "prop-1",
        kind: "field",
        sourceRef: fieldRef("title"),
        targetRef: fieldRef("name"),
        phase: "request",
        transformSuggestion: renameSuggestion,
        confidenceScore: 0.9,
        ambiguousAlternatives: [{ targetRef: fieldRef("label"), confidence: 0.3 }],
        unmapped: false,
        rationale: "same concept",
        reviewState: "accepted",
      },
    ],
    [
      "unmapped (transformSuggestion + targetRef absent)",
      {
        id: "rt-unmapped",
        proposalId: "prop-1",
        kind: "field",
        sourceRef: fieldRef("legacyCode"),
        confidenceScore: 0.1,
        ambiguousAlternatives: [],
        unmapped: true,
        rationale: "no counterpart",
        reviewState: "rejected",
      },
    ],
    [
      "peer-peer identity field (identityCandidate=true + targetLookupParamRef)",
      {
        id: "rt-identity",
        proposalId: "prop-1",
        kind: "field",
        sourceRef: fieldRef("email"),
        targetRef: fieldRef("email"),
        transformSuggestion: renameSuggestion,
        confidenceScore: 0.95,
        ambiguousAlternatives: [],
        unmapped: false,
        rationale: "shared identity value",
        reviewState: "pending",
        identityCandidate: true,
        targetLookupParamRef: "filter",
      },
    ],
  ];

  it.each(cases)("round-trips %s", (_name, item) => {
    expect(mapMappingProposalItemRow(persistedRow(item))).toStrictEqual(item);
  });
});
