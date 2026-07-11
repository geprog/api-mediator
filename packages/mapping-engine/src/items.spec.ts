import {
  type MappingProposalItem,
  mappingProposalItemSchema,
  mappingSuggestionSetSchema,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { issuesToTasksPeerPeer, todosToTasksConsumerProvider } from "./fixtures.js";
import { buildItems, type ItemBuildDeps, type ItemResourceRefs } from "./items.js";

/** Sequential id factory for deterministic item ids. */
function makeIds(): () => string {
  let n = 0;
  return () => `item-${String((n += 1))}`;
}

function deps(): ItemBuildDeps {
  return { proposalId: "prop-1", newId: makeIds() };
}

const peerRefs: ItemResourceRefs = { sourceResourceRef: "issues", targetResourceRef: "tasks" };
const adapterRefs: ItemResourceRefs = { sourceResourceRef: "todos", targetResourceRef: "tasks" };

function byKind(
  items: readonly MappingProposalItem[],
  kind: MappingProposalItem["kind"],
): MappingProposalItem[] {
  return items.filter((item) => item.kind === kind);
}

describe("buildItems — peer-peer (PP-2)", () => {
  const set = mappingSuggestionSetSchema.parse(issuesToTasksPeerPeer);
  const items = buildItems(set, peerRefs, deps());

  it("produces one item per operation/field correspondence", () => {
    expect(byKind(items, "operation")).toHaveLength(2);
    expect(byKind(items, "field")).toHaveLength(3);
    expect(byKind(items, "parameter")).toHaveLength(0);
  });

  it("every constructed item satisfies the MappingProposalItem schema", () => {
    for (const item of items) {
      expect(mappingProposalItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it("operation items carry a null transformSuggestion and a resource-qualified targetRef", () => {
    const op = byKind(items, "operation")[0];
    expect(op?.transformSuggestion).toBeNull();
    expect(op?.sourceRef).toEqual({
      resourceRef: "issues",
      target: { kind: "operation", operationId: "issueListIssues" },
    });
    expect(op?.targetRef).toEqual({
      resourceRef: "tasks",
      target: { kind: "operation", operationId: "vikunjaListTasks" },
    });
  });

  it("a mapped field item carries a transformSuggestion object and NO phase", () => {
    const title = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "title",
    );
    expect(title?.transformSuggestion).toEqual({ transform: "rename" });
    expect(title && "phase" in title).toBe(false);
  });

  it("threads the identity suggestion onto the identity field item (identityCandidate + targetLookupParamRef)", () => {
    // The scenario-1 Gitea↔Vikunja title↔title pairing is the flagged identity
    // candidate — its suggestion survives construction as detection metadata.
    const title = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "title",
    );
    expect(title?.identityCandidate).toBe(true);
    expect(title?.targetLookupParamRef).toBe("filter");
  });

  it("a non-identity peer-peer field item carries no identity detection metadata", () => {
    const body = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "body",
    );
    expect(body && "identityCandidate" in body).toBe(false);
    expect(body && "targetLookupParamRef" in body).toBe(false);
  });

  it("normalizes ambiguousAlternatives to { targetRef, confidence }", () => {
    const body = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "body",
    );
    expect(body?.ambiguousAlternatives).toEqual([
      {
        targetRef: { resourceRef: "tasks", target: { kind: "field", path: "done" } },
        confidence: 0.2,
      },
    ]);
  });

  it("an unmapped field item has no targetRef and no transformSuggestion", () => {
    const state = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "state",
    );
    expect(state?.unmapped).toBe(true);
    expect(state && "targetRef" in state).toBe(false);
    expect(state && "transformSuggestion" in state).toBe(false);
  });
});

describe("buildItems — consumer-provider (PP-2)", () => {
  const set = mappingSuggestionSetSchema.parse(todosToTasksConsumerProvider);
  const items = buildItems(set, adapterRefs, deps());

  it("every constructed item satisfies the MappingProposalItem schema", () => {
    for (const item of items) {
      expect(mappingProposalItemSchema.safeParse(item).success).toBe(true);
    }
  });

  it("field items carry a phase; parameter items exist and carry no phase", () => {
    const fields = byKind(items, "field");
    expect(fields.every((item) => item.phase !== undefined)).toBe(true);
    const params = byKind(items, "parameter");
    expect(params).toHaveLength(1);
    expect(params[0] && "phase" in params[0]).toBe(false);
  });

  it("consumer-provider field items never carry identity detection metadata", () => {
    for (const field of byKind(items, "field")) {
      expect("identityCandidate" in field).toBe(false);
      expect("targetLookupParamRef" in field).toBe(false);
    }
  });

  it("a pass-through parameter (no proposed transform) carries a null transformSuggestion", () => {
    const param = byKind(items, "parameter")[0];
    expect(param?.transformSuggestion).toBeNull();
    expect(param?.sourceRef).toEqual({
      resourceRef: "todos",
      target: { kind: "parameter", operationId: "listTodos", parameter: "owner" },
    });
    expect(param?.targetRef).toEqual({
      resourceRef: "tasks",
      target: { kind: "parameter", operationId: "vikunjaListTasks", parameter: "project" },
    });
  });

  it("a transforming field carries its transform object with detail", () => {
    const stateField = byKind(items, "field").find(
      (item) => item.sourceRef.target.kind === "field" && item.sourceRef.target.path === "state",
    );
    expect(stateField?.transformSuggestion).toEqual({
      transform: "coerce",
      detail: "map open/closed to a filter expression",
    });
    expect(stateField?.phase).toBe("request");
  });
});
