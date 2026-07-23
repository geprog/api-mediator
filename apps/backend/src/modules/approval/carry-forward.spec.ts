import type { MappingArtifacts } from "@mediator/db";
import type { FieldMapping, OperationMapping, ParameterMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { carryForwardUnaffectedCorrespondences } from "./carry-forward.js";

function field(input: {
  id: string;
  mappingId: string;
  sourcePath: string;
  targetPath: string;
  phase?: FieldMapping["phase"];
  isIdentityKey?: true;
}): FieldMapping {
  return {
    id: input.id,
    mappingId: input.mappingId,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    transform: "rename",
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    ...(input.isIdentityKey !== undefined ? { isIdentityKey: input.isIdentityKey } : {}),
  };
}

function operation(input: {
  id: string;
  mappingId: string;
  sourceOperationRef: string;
  targetOperationRef: string;
}): OperationMapping {
  return {
    id: input.id,
    mappingId: input.mappingId,
    sourceOperationRef: input.sourceOperationRef,
    targetOperationRef: input.targetOperationRef,
    action: "read",
  };
}

function parameter(input: {
  id: string;
  operationMappingId: string;
  sourceParamRef: string;
  targetParamRef: string;
}): ParameterMapping {
  return {
    id: input.id,
    operationMappingId: input.operationMappingId,
    sourceParamRef: input.sourceParamRef,
    targetParamRef: input.targetParamRef,
  };
}

function empty(): MappingArtifacts {
  return { fieldMappings: [], operationMappings: [], parameterMappings: [] };
}

/** A deterministic id factory so carried-forward rows get stable, assertable ids. */
function ids(prefix = "carried"): () => string {
  let n = 0;
  return (): string => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}

describe("carryForwardUnaffectedCorrespondences (SL-7.6)", () => {
  it("carries forward the predecessor's UNAFFECTED resource pairs, re-parented onto the successor", () => {
    // Predecessor covered two peer-peer resource pairs: issues↔tasks and comments↔notes.
    // The re-review (successor) touched ONLY issues↔tasks; comments↔notes is unaffected.
    const predecessorFields: FieldMapping[] = [
      field({
        id: "p-f1",
        mappingId: "pred",
        sourcePath: "issues/title",
        targetPath: "tasks/name",
      }),
      field({
        id: "p-f2",
        mappingId: "pred",
        sourcePath: "comments/body",
        targetPath: "notes/text",
      }),
      field({
        id: "p-f3",
        mappingId: "pred",
        sourcePath: "comments/author",
        targetPath: "notes/author",
      }),
    ];
    const reReviewed: MappingArtifacts = {
      fieldMappings: [
        // re-reviewed content for the touched pair (a renamed target field)
        field({
          id: "s-f1",
          mappingId: "succ",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
      ],
      operationMappings: [],
      parameterMappings: [],
    };

    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed,
      predecessorFields,
      predecessorOperations: [],
      predecessorParameters: [],
      newId: ids(),
    });

    // The successor now covers BOTH pairs: its own re-reviewed issues↔tasks field, plus the
    // predecessor's two comments↔notes fields carried forward.
    const pairs = merged.fieldMappings.map((f) => `${f.sourcePath}=>${f.targetPath}`).sort();
    expect(pairs).toEqual([
      "comments/author=>notes/author",
      "comments/body=>notes/text",
      "issues/title=>tasks/title",
    ]);
    // Carried-forward fields are re-parented onto the successor with fresh ids.
    const carried = merged.fieldMappings.filter((f) => f.sourcePath.startsWith("comments/"));
    expect(carried.every((f) => f.mappingId === "succ")).toBe(true);
    expect(carried.map((f) => f.id).sort()).toEqual(["carried-1", "carried-2"]);
    // The re-reviewed field keeps its own id.
    expect(merged.fieldMappings.find((f) => f.id === "s-f1")).toBeDefined();
  });

  it("does NOT carry forward a field the re-review DROPPED from a TOUCHED pair (genuinely removed)", () => {
    // Predecessor mapped two fields in the (single) issues↔tasks pair; the re-review kept
    // only `title` and dropped `description`. The pair is covered, so the dropped field is
    // gone — not resurrected by carry-forward.
    const predecessorFields: FieldMapping[] = [
      field({
        id: "p-f1",
        mappingId: "pred",
        sourcePath: "issues/title",
        targetPath: "tasks/title",
      }),
      field({
        id: "p-f2",
        mappingId: "pred",
        sourcePath: "issues/description",
        targetPath: "tasks/description",
      }),
    ];
    const reReviewed: MappingArtifacts = {
      fieldMappings: [
        field({
          id: "s-f1",
          mappingId: "succ",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
      ],
      operationMappings: [],
      parameterMappings: [],
    };

    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed,
      predecessorFields,
      predecessorOperations: [],
      predecessorParameters: [],
      newId: ids(),
    });

    expect(merged.fieldMappings.map((f) => f.sourcePath)).toEqual(["issues/title"]);
    expect(merged.fieldMappings.some((f) => f.sourcePath === "issues/description")).toBe(false);
  });

  it("carries forward an unaffected operation pair WITH its parameters, re-pointing ids", () => {
    // consumer-provider: predecessor covered two operation pairs; re-review touched only the
    // `listIssues` pair, leaving `getIssue` (with its id parameter) unaffected.
    const predecessorOperations: OperationMapping[] = [
      operation({
        id: "p-op1",
        mappingId: "pred",
        sourceOperationRef: "issues/listIssues",
        targetOperationRef: "tasks/listTasks",
      }),
      operation({
        id: "p-op2",
        mappingId: "pred",
        sourceOperationRef: "single/getIssue",
        targetOperationRef: "single/getTask",
      }),
    ];
    const predecessorParameters: ParameterMapping[] = [
      parameter({
        id: "p-pm1",
        operationMappingId: "p-op2",
        sourceParamRef: "single/getIssue#id",
        targetParamRef: "single/getTask#taskId",
      }),
    ];
    const reReviewed: MappingArtifacts = {
      fieldMappings: [],
      operationMappings: [
        operation({
          id: "s-op1",
          mappingId: "succ",
          sourceOperationRef: "issues/listIssues",
          targetOperationRef: "tasks/listTasks",
        }),
      ],
      parameterMappings: [],
    };

    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed,
      predecessorFields: [],
      predecessorOperations,
      predecessorParameters,
      newId: ids(),
    });

    // The successor covers both operation pairs.
    expect(merged.operationMappings.map((o) => o.sourceOperationRef).sort()).toEqual([
      "issues/listIssues",
      "single/getIssue",
    ]);
    const carriedOp = merged.operationMappings.find(
      (o) => o.sourceOperationRef === "single/getIssue",
    );
    expect(carriedOp).toBeDefined();
    expect(carriedOp?.mappingId).toBe("succ");
    // Its parameter carried forward and re-points at the NEW operation id (not the old one).
    expect(merged.parameterMappings).toHaveLength(1);
    const carriedParam = merged.parameterMappings[0];
    expect(carriedParam?.operationMappingId).toBe(carriedOp?.id);
    expect(carriedParam?.operationMappingId).not.toBe("p-op2");
  });

  it("groups a response-phase field with its operation's pair (no spurious carry-forward)", () => {
    // A consumer-provider response field inverts source/target; it must group with the SAME
    // (consumer→backend) pair the re-review covered, so it is NOT carried forward when that
    // pair is covered.
    const predecessorFields: FieldMapping[] = [
      field({
        id: "p-rf",
        mappingId: "pred",
        // response: backend `tasks/*` flows to consumer `issues/*`
        sourcePath: "tasks/name",
        targetPath: "issues/title",
        phase: "response",
      }),
    ];
    const reReviewed: MappingArtifacts = {
      fieldMappings: [
        field({
          id: "s-rf",
          mappingId: "succ",
          sourcePath: "tasks/name",
          targetPath: "issues/title",
          phase: "response",
        }),
      ],
      operationMappings: [],
      parameterMappings: [],
    };

    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed,
      predecessorFields,
      predecessorOperations: [],
      predecessorParameters: [],
      newId: ids(),
    });

    // Only the re-reviewed response field survives; the predecessor's identical response
    // field is not carried (its pair is covered).
    expect(merged.fieldMappings).toHaveLength(1);
    expect(merged.fieldMappings[0]?.id).toBe("s-rf");
  });

  it("is idempotent under a re-run once the successor already covers the pair", () => {
    // A second incremental re-review approve: the successor's re-reviewed set now already
    // includes what a prior run carried; carry-forward adds nothing more for covered pairs.
    const predecessorFields: FieldMapping[] = [
      field({ id: "p-f1", mappingId: "pred", sourcePath: "issues/title", targetPath: "tasks/t" }),
    ];
    const reReviewedCoveringAll: MappingArtifacts = {
      fieldMappings: [
        field({ id: "s-f1", mappingId: "succ", sourcePath: "issues/title", targetPath: "tasks/t" }),
      ],
      operationMappings: [],
      parameterMappings: [],
    };
    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed: reReviewedCoveringAll,
      predecessorFields,
      predecessorOperations: [],
      predecessorParameters: [],
      newId: ids(),
    });
    expect(merged.fieldMappings).toHaveLength(1);
    expect(merged.fieldMappings[0]?.id).toBe("s-f1");
  });

  it("leaves an ordinary (empty-predecessor) assembly untouched", () => {
    const reReviewed: MappingArtifacts = {
      fieldMappings: [
        field({ id: "s-f1", mappingId: "succ", sourcePath: "issues/title", targetPath: "tasks/t" }),
      ],
      operationMappings: [],
      parameterMappings: [],
    };
    const merged = carryForwardUnaffectedCorrespondences({
      successorMappingId: "succ",
      reReviewed,
      predecessorFields: [],
      predecessorOperations: [],
      predecessorParameters: [],
      newId: ids(),
    });
    expect(merged).toEqual(reReviewed);
    expect(merged.fieldMappings).not.toBe(empty().fieldMappings);
  });
});
