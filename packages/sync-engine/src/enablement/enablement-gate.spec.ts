import type {
  AppCapabilities,
  ConfirmableRef,
  FieldMapping,
  IrRefTarget,
  OperationMapping,
  ResourceBinding,
  ScopePathBinding,
  SourceScopeRef,
  SyncRule,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { evaluateEnablement } from "./enablement-gate.js";
import type { EnablementDecision, EnablementInput, ScopeBindingRequirement } from "./types.js";

/**
 * Unit tests for the `SyncRule` enablement gate (BE-1 all 6 criteria, BE-2 all 5).
 * Every test builds hand-made domain fixtures over the pure {@link evaluateEnablement}
 * (no I/O, no fakes) and starts from a fully-enable-able {@link validInput}, tweaking
 * exactly the one datum the criterion is about. The identity-key and required-ref
 * cases assert the **structured** `stillNeeds` contents, not just the count — this is
 * the record-merge-prevention boundary.
 */

const T0 = new Date("2026-07-13T00:00:00.000Z");

// ── ConfirmableRef builders (kind is irrelevant to the gate; it only reads confirmation) ─
function confirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "op-alice", confirmedAt: T0 };
}
function unconfirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: null, confirmedAt: null };
}
const opTarget = (operationId: string): IrRefTarget => ({ kind: "operation", operationId });
const fieldTarget = (path: string): IrRefTarget => ({ kind: "field", path });
const paramTarget = (operationId: string, parameter: string): IrRefTarget => ({
  kind: "parameter",
  operationId,
  parameter,
});

// ── Domain fixtures ──────────────────────────────────────────────────────────

const identityKey: FieldMapping = {
  id: "fm-email",
  mappingId: "map-1",
  sourcePath: "email",
  targetPath: "email",
  transform: "rename",
  isIdentityKey: true,
  targetLookupParamRef: "emailFilter", // filtered-read lookup path available
};

const plainField: FieldMapping = {
  id: "fm-name",
  mappingId: "map-1",
  sourcePath: "name",
  targetPath: "name",
  transform: "rename",
};

const createOp: OperationMapping = {
  id: "om-create",
  mappingId: "map-1",
  sourceOperationRef: "src.createUser",
  targetOperationRef: "tgt.createUser",
  action: "create",
};

const updateOp: OperationMapping = {
  id: "om-update",
  mappingId: "map-1",
  sourceOperationRef: "src.updateUser",
  targetOperationRef: "tgt.updateUser",
  action: "update",
  targetIdParamRef: "id",
};

const deleteOp: OperationMapping = {
  id: "om-delete",
  mappingId: "map-1",
  sourceOperationRef: "src.deleteUser",
  targetOperationRef: "tgt.deleteUser",
  action: "delete",
  targetIdParamRef: "id",
};

const capabilities = (overrides: Partial<AppCapabilities> = {}): AppCapabilities => ({
  supportsPolling: true,
  supportsDeltaQuery: false,
  supportsChangeTimestamps: false,
  defaultPollInterval: 60_000,
  ...overrides,
});

function makeRule(overrides: Partial<SyncRule> = {}): SyncRule {
  return {
    id: "rule-1",
    approvedMappingId: "map-1",
    resourcePairRef: "pair-1",
    status: "disabled",
    pollOperationRef: "src.listUsers",
    deletePropagation: "ignore",
    backfillMode: "link-only",
    backfillStatus: "pending",
    ...overrides,
  };
}

/** A confirmed full-fetch source binding (native id + collection read + pagination). */
function fullFetchSourceBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  return {
    id: "rb-src",
    apiSpecId: "spec-src",
    resourceRef: "users",
    nativeIdRef: confirmed(fieldTarget("id")),
    collectionReadRef: confirmed(opTarget("src.listUsers")),
    paginationRef: confirmed(paramTarget("src.listUsers", "page")),
    ...overrides,
  };
}

/** A confirmed target binding (native id + enumerable collection read for fetch-and-match). */
function targetBinding(overrides: Partial<ResourceBinding> = {}): ResourceBinding {
  return {
    id: "rb-tgt",
    apiSpecId: "spec-tgt",
    resourceRef: "users",
    nativeIdRef: confirmed(fieldTarget("id")),
    collectionReadRef: confirmed(opTarget("tgt.listUsers")),
    ...overrides,
  };
}

/** The base fully-enable-able input: full-fetch rule, all refs confirmed, filtered-read lookup. */
function validInput(overrides: Partial<EnablementInput> = {}): EnablementInput {
  return {
    rule: makeRule(),
    fieldMappings: [identityKey, plainField],
    operationMappings: [createOp, updateOp],
    sourceBinding: fullFetchSourceBinding(),
    targetBinding: targetBinding(),
    sourceCapabilities: capabilities(),
    targetCapabilities: capabilities(),
    backfillSkipped: false,
    requiredScopeBindings: [],
    ...overrides,
  };
}

/** Narrow a decision to `blocked`, failing the test loudly otherwise. */
function expectBlocked(
  decision: EnablementDecision,
): asserts decision is Extract<EnablementDecision, { kind: "blocked" }> {
  expect(decision.kind).toBe("blocked");
  if (decision.kind !== "blocked") throw new Error("expected a blocked decision");
}

/** Narrow a decision to `enable`, failing the test loudly otherwise. */
function expectEnable(
  decision: EnablementDecision,
): asserts decision is Extract<EnablementDecision, { kind: "enable" }> {
  expect(decision.kind).toBe("enable");
  if (decision.kind !== "enable") throw new Error("expected an enable decision");
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("evaluateEnablement — enable", () => {
  it("enables a fully-confirmed rule (backfill runs, no degradations)", () => {
    const decision = evaluateEnablement(validInput());
    expect(decision).toEqual({ kind: "enable", backfillRequired: true, degradations: [] });
  });
});

// ── BE-1.1 — exactly one confirmed identity FieldMapping (the hard gate) ───────

describe("BE-1.1 — identity key (hard gate)", () => {
  it("zero identity keys → blocked", () => {
    const decision = evaluateEnablement(validInput({ fieldMappings: [plainField] }));
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "identity-key",
      issue: "missing",
      confirmedCount: 0,
    });
  });

  it("two identity keys → blocked (ambiguous)", () => {
    const second: FieldMapping = {
      ...identityKey,
      id: "fm-sku",
      sourcePath: "sku",
      targetPath: "sku",
    };
    const decision = evaluateEnablement(
      validInput({ fieldMappings: [identityKey, second, plainField] }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "identity-key",
      issue: "ambiguous",
      confirmedCount: 2,
    });
  });

  it("exactly one identity key → passes the identity check (enables)", () => {
    const decision = evaluateEnablement(validInput());
    expectEnable(decision);
    // No identity-key requirement is the point; the enable itself confirms it.
  });
});

// ── BE-1.2 — pollOperationRef confirmed ────────────────────────────────────────

describe("BE-1.2 — pollOperationRef", () => {
  it("unconfirmed (unset) pollOperationRef → blocked", () => {
    const decision = evaluateEnablement(
      validInput({ rule: makeRule({ pollOperationRef: undefined }) }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({ kind: "poll-operation-ref" });
  });

  it("empty-string pollOperationRef → blocked", () => {
    const decision = evaluateEnablement(validInput({ rule: makeRule({ pollOperationRef: "" }) }));
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({ kind: "poll-operation-ref" });
  });
});

// ── BE-1.3 — target operations for what the rule propagates ─────────────────────

describe("BE-1.3 — propagatable target operations", () => {
  it("create-only (no update op) → enable", () => {
    const decision = evaluateEnablement(validInput({ operationMappings: [createOp] }));
    expectEnable(decision);
  });

  it("update-only (no create op) → enable (observed creates skipped-policy)", () => {
    const decision = evaluateEnablement(validInput({ operationMappings: [updateOp] }));
    expectEnable(decision);
  });

  it("neither create nor update → blocked (nothing to propagate)", () => {
    const readOp: OperationMapping = {
      id: "om-read",
      mappingId: "map-1",
      sourceOperationRef: "src.getUser",
      targetOperationRef: "tgt.getUser",
      action: "read",
    };
    const decision = evaluateEnablement(validInput({ operationMappings: [readOp] }));
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({ kind: "propagatable-operation" });
  });

  it("update op without its targetIdParamRef → blocked", () => {
    const updateNoParam: OperationMapping = {
      id: "om-update",
      mappingId: "map-1",
      sourceOperationRef: "src.updateUser",
      targetOperationRef: "tgt.updateUser",
      action: "update",
    };
    const decision = evaluateEnablement(
      validInput({ operationMappings: [createOp, updateNoParam] }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "target-operation",
      action: "update",
      issue: "missing-target-id-param",
    });
  });
});

// ── BE-1.4 — delete propagation ────────────────────────────────────────────────

describe("BE-1.4 — delete propagation", () => {
  it("propagate without a delete op → blocked", () => {
    const decision = evaluateEnablement(
      validInput({ rule: makeRule({ deletePropagation: "propagate" }) }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "target-operation",
      action: "delete",
      issue: "missing",
    });
  });

  it("propagate with a delete op lacking targetIdParamRef → blocked", () => {
    const deleteNoParam: OperationMapping = { ...deleteOp, targetIdParamRef: undefined };
    const decision = evaluateEnablement(
      validInput({
        rule: makeRule({ deletePropagation: "propagate" }),
        operationMappings: [createOp, updateOp, deleteNoParam],
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "target-operation",
      action: "delete",
      issue: "missing-target-id-param",
    });
  });

  it("propagate on a delta rule without deltaDeletionRef → blocked", () => {
    const decision = evaluateEnablement(
      validInput({
        rule: makeRule({ deletePropagation: "propagate" }),
        operationMappings: [createOp, updateOp, deleteOp],
        sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
        sourceBinding: fullFetchSourceBinding({
          deltaCursorRef: confirmed(paramTarget("src.deltaUsers", "since")),
          // deltaDeletionRef absent — the delta API reports no deletions.
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "deltaDeletionRef",
      side: "source",
      usedFor: "delta-deletion",
    });
  });

  it("propagate on a full-fetch rule needs NO deltaDeletionRef (delete via diff)", () => {
    const decision = evaluateEnablement(
      validInput({
        rule: makeRule({ deletePropagation: "propagate" }),
        operationMappings: [createOp, updateOp, deleteOp],
      }),
    );
    expectEnable(decision);
  });
});

// ── BE-2.1 — nativeIdRef confirmed on BOTH sides ────────────────────────────────

describe("BE-2.1 — nativeIdRef on both sides", () => {
  it("source nativeIdRef unconfirmed → blocked", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceBinding: fullFetchSourceBinding({ nativeIdRef: unconfirmed(fieldTarget("id")) }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "source",
      usedFor: "native-id",
    });
  });

  it("target nativeIdRef unconfirmed → blocked", () => {
    const decision = evaluateEnablement(
      validInput({ targetBinding: targetBinding({ nativeIdRef: unconfirmed(fieldTarget("id")) }) }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "target",
      usedFor: "native-id",
    });
  });
});

// ── BE-2.2 — collectionReadRef / paginationRef where enumeration applies ────────

describe("BE-2.2 — collection read + pagination", () => {
  it("full-fetch rule with unconfirmed source collectionReadRef → blocked (polling)", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceBinding: fullFetchSourceBinding({
          collectionReadRef: unconfirmed(opTarget("src.listUsers")),
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "collectionReadRef",
      side: "source",
      usedFor: "polling-enumeration",
    });
  });

  it("present-but-unconfirmed source paginationRef → blocked", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceBinding: fullFetchSourceBinding({
          paginationRef: unconfirmed(paramTarget("src.listUsers", "page")),
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "paginationRef",
      side: "source",
      usedFor: "pagination",
    });
  });

  it("delta rule + backfill NOT skipped requires source collectionReadRef (backfill enumeration)", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
        sourceBinding: {
          id: "rb-src",
          apiSpecId: "spec-src",
          resourceRef: "users",
          nativeIdRef: confirmed(fieldTarget("id")),
          deltaCursorRef: confirmed(paramTarget("src.deltaUsers", "since")),
          // No collectionReadRef — a delta-only source. Backfill still needs to enumerate.
        },
        backfillSkipped: false,
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "collectionReadRef",
      side: "source",
      usedFor: "backfill-enumeration",
    });
  });

  it("delta rule + backfill explicitly skipped does NOT require source collectionReadRef", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
        sourceBinding: {
          id: "rb-src",
          apiSpecId: "spec-src",
          resourceRef: "users",
          nativeIdRef: confirmed(fieldTarget("id")),
          deltaCursorRef: confirmed(paramTarget("src.deltaUsers", "since")),
          // No collectionReadRef, but backfill is skipped → enumeration demand removed.
        },
        backfillSkipped: true,
      }),
    );
    expectEnable(decision);
    expect(decision.backfillRequired).toBe(false);
  });

  // Fetch-and-match is the SOLE match path (identity key has no targetLookupParamRef,
  // but the target is enumerable) → its live paging convention must be confirmed too.
  const noFilterKey: FieldMapping = { ...identityKey, targetLookupParamRef: undefined };

  it("fetch-and-match-only + unconfirmed target paginationRef → blocked (target pagination)", () => {
    const decision = evaluateEnablement(
      validInput({
        fieldMappings: [noFilterKey, plainField],
        targetBinding: targetBinding({
          paginationRef: unconfirmed(paramTarget("tgt.listUsers", "page")),
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "paginationRef",
      side: "target",
      usedFor: "pagination",
    });
    // It is the ONLY blocker — everything else in the base input is confirmed.
    expect(decision.stillNeeds).toHaveLength(1);
  });

  it("filtered-read path with an unconfirmed target paginationRef → NOT blocked", () => {
    // Filtered read returns ≤1 and never pages, so target pagination is irrelevant.
    const decision = evaluateEnablement(
      validInput({
        targetBinding: targetBinding({
          paginationRef: unconfirmed(paramTarget("tgt.listUsers", "page")),
        }),
      }),
    );
    expectEnable(decision);
  });
});

// ── BE-2.3 — delta cursor on a delta-polling rule ──────────────────────────────

describe("BE-2.3 — delta cursor", () => {
  it("delta rule without a confirmed deltaCursorRef → blocked", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceCapabilities: capabilities({ supportsDeltaQuery: true }),
        sourceBinding: fullFetchSourceBinding({
          deltaCursorRef: unconfirmed(paramTarget("src.deltaUsers", "since")),
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "deltaCursorRef",
      side: "source",
      usedFor: "delta-cursor",
    });
  });
});

// ── BE-2.4 — changeTimestampRef is NOT a hard precondition (LWW degrades) ───────

describe("BE-2.4 — changeTimestampRef degrades LWW, never blocks", () => {
  it("unconfirmed changeTimestampRef → NOT blocked; degradation surfaced", () => {
    const decision = evaluateEnablement(
      validInput({
        sourceCapabilities: capabilities({ supportsChangeTimestamps: true }),
        sourceBinding: fullFetchSourceBinding({
          changeTimestampRef: unconfirmed(fieldTarget("updatedAt")),
        }),
      }),
    );
    expectEnable(decision);
    expect(decision.degradations).toContainEqual({ kind: "lww-observation-order", side: "source" });
  });
});

// ── BE-1.6 — neither identity-lookup path ──────────────────────────────────────

describe("BE-1.6 — identity-lookup path degradation", () => {
  // A pair with neither filtered-read nor fetch-and-match: identity key has no
  // targetLookupParamRef, and the target is not enumerable (no collectionReadRef).
  const noLookupIdentityKey: FieldMapping = { ...identityKey, targetLookupParamRef: undefined };
  const nonEnumerableTarget = (): ResourceBinding => ({
    id: "rb-tgt",
    apiSpecId: "spec-tgt",
    resourceRef: "users",
    nativeIdRef: confirmed(fieldTarget("id")),
    // No collectionReadRef → fetch-and-match unavailable.
  });

  it("neither lookup path + backfill NOT skipped → blocked", () => {
    const decision = evaluateEnablement(
      validInput({
        fieldMappings: [noLookupIdentityKey, plainField],
        targetBinding: nonEnumerableTarget(),
        backfillSkipped: false,
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({ kind: "identity-lookup-path" });
  });

  it("neither lookup path + backfill explicitly skipped → enable WITH the degradation flag", () => {
    const decision = evaluateEnablement(
      validInput({
        fieldMappings: [noLookupIdentityKey, plainField],
        targetBinding: nonEnumerableTarget(),
        backfillSkipped: true,
      }),
    );
    expectEnable(decision);
    expect(decision.backfillRequired).toBe(false);
    expect(decision.degradations).toContainEqual({ kind: "match-first-unavailable" });
  });

  it("fetch-and-match available (no filter, but target enumerable) → enable, no lookup gap", () => {
    const decision = evaluateEnablement(
      validInput({ fieldMappings: [noLookupIdentityKey, plainField] }),
    );
    expectEnable(decision);
    expect(decision.degradations).toEqual([]);
  });
});

// ── BE-1.5 / BE-2.5 — the "still needs" list names EVERY specific missing item ──

describe("BE-1.5 / BE-2.5 — stillNeeds lists all missing items", () => {
  it("a multi-precondition failure lists each specific missing ref/decision", () => {
    const decision = evaluateEnablement(
      validInput({
        rule: makeRule({ pollOperationRef: undefined, deletePropagation: "propagate" }),
        fieldMappings: [plainField], // no identity key
        operationMappings: [createOp, updateOp], // propagate but no delete op
        sourceBinding: fullFetchSourceBinding({ nativeIdRef: unconfirmed(fieldTarget("id")) }),
      }),
    );
    expectBlocked(decision);
    // Assert the STRUCTURED contents of each independent failure, not just the count.
    expect(decision.stillNeeds).toContainEqual({
      kind: "identity-key",
      issue: "missing",
      confirmedCount: 0,
    });
    expect(decision.stillNeeds).toContainEqual({ kind: "poll-operation-ref" });
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "source",
      usedFor: "native-id",
    });
    expect(decision.stillNeeds).toContainEqual({
      kind: "target-operation",
      action: "delete",
      issue: "missing",
    });
    expect(decision.stillNeeds).toHaveLength(4);
  });
});

// ── SS-5 — required scope path-parameter bindings (constant) ────────────────────

describe("SS-5 — scope path-parameter bindings", () => {
  function confirmedConstant(parameterName: string, value: string): ScopePathBinding {
    return { kind: "constant", parameterName, value, confirmedBy: "op-alice", confirmedAt: T0 };
  }
  function unconfirmedConstant(parameterName: string): ScopePathBinding {
    return { kind: "constant", parameterName, value: "", confirmedBy: null, confirmedAt: null };
  }

  it("backward-compatible: empty requiredScopeBindings adds no scope blocker (non-scoped rule)", () => {
    const decision = evaluateEnablement(validInput({ requiredScopeBindings: [] }));
    expectEnable(decision);
  });

  it("a required scope binding confirmed on the right side → not blocked (SS-5.1)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          scopePathBindings: [confirmedConstant("owner", "alice")],
        }),
      }),
    );
    expectEnable(decision);
  });

  it("an unconfirmed required scope binding → blocked with the structured scope-binding requirement (SS-5.4)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          scopePathBindings: [unconfirmedConstant("owner")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "owner",
      side: "source",
      resourceRef: "users",
    });
  });

  it("an ABSENT scope entry (no binding at all) → blocked (SS-5.4)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "repo", side: "target", resourceRef: "users" },
        ],
        // targetBinding has no scopePathBindings at all.
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "repo",
      side: "target",
      resourceRef: "users",
    });
  });

  it("a confirmed-but-EMPTY-value constant does not satisfy the requirement (SS-1 confirmed = non-empty)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          // Both stamps set but value empty — a malformed row the schema forbids; the gate
          // still refuses to treat it as confirmed (mirrors the SS-4 resolver guard).
          scopePathBindings: [
            {
              kind: "constant",
              parameterName: "owner",
              value: "",
              confirmedBy: "op",
              confirmedAt: T0,
            },
          ],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "owner",
      side: "source",
      resourceRef: "users",
    });
  });

  it("checks a source requirement on the SOURCE binding, a target requirement on the TARGET binding (SS-5.5)", () => {
    // The same parameter name is confirmed only on the SOURCE side, but the requirement is
    // a TARGET one — so it must remain unsatisfied (sidedness is not cross-checked).
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "target", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          scopePathBindings: [confirmedConstant("owner", "alice")],
        }),
        targetBinding: targetBinding({
          // target side has a DIFFERENT scope confirmed, not `owner`.
          scopePathBindings: [confirmedConstant("repo", "phoenix")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "owner",
      side: "target",
      resourceRef: "users",
    });
  });

  it("a mix of confirmed/unconfirmed scope bindings lists ONLY the unconfirmed ones", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
          { kind: "constant", parameterName: "repo", side: "source", resourceRef: "users" },
          { kind: "constant", parameterName: "project", side: "target", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          scopePathBindings: [confirmedConstant("owner", "alice"), unconfirmedConstant("repo")],
        }),
        targetBinding: targetBinding({
          scopePathBindings: [confirmedConstant("project", "42")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toEqual([
      { kind: "scope-binding", parameterName: "repo", side: "source", resourceRef: "users" },
    ]);
  });

  it("composes with an existing BE-2 ref blocker (both appear in stillNeeds)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          nativeIdRef: unconfirmed(fieldTarget("id")), // BE-2.1 blocker on the source
          scopePathBindings: [unconfirmedConstant("owner")], // SS-5.4 blocker on the source
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "source",
      usedFor: "native-id",
    });
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "owner",
      side: "source",
      resourceRef: "users",
    });
  });
});

// ── SS-9 — required scope path-parameter bindings (record-derived) ──────────────

describe("SS-9 — record-derived scope path-parameter bindings", () => {
  /** A confirmed source `sourceScopeRef` over the given components (SS-7). */
  function confirmedSourceScopeRef(
    components: readonly { key: string; fieldPath: string }[],
  ): SourceScopeRef {
    return { components: [...components], confirmedBy: "op-alice", confirmedAt: T0 };
  }
  /** An unconfirmed source `sourceScopeRef` (present but not ratified). */
  function unconfirmedSourceScopeRef(
    components: readonly { key: string; fieldPath: string }[],
  ): SourceScopeRef {
    return { components: [...components], confirmedBy: null, confirmedAt: null };
  }
  function confirmedRecordDerived(parameterName: string, sourceScopeKey: string): ScopePathBinding {
    return {
      kind: "record-derived",
      parameterName,
      sourceScopeKey,
      confirmedBy: "op",
      confirmedAt: T0,
    };
  }
  function unconfirmedRecordDerived(
    parameterName: string,
    sourceScopeKey: string,
  ): ScopePathBinding {
    return {
      kind: "record-derived",
      parameterName,
      sourceScopeKey,
      confirmedBy: null,
      confirmedAt: null,
    };
  }

  // The target's `{id}` (a project scope, e.g. Vikunja `PUT /projects/{id}/tasks`) bound
  // `record-derived` selecting the source's captured `project` component.
  const rd: ScopeBindingRequirement = {
    kind: "record-derived",
    parameterName: "id",
    side: "target",
    resourceRef: "users",
    sourceResourceRef: "users",
    sourceScopeKey: "project",
  };

  it("source component present+confirmed AND target binding confirmed → NOT blocked (SS-9.1)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [rd],
        sourceBinding: fullFetchSourceBinding({
          sourceScopeRef: confirmedSourceScopeRef([{ key: "project", fieldPath: "project_id" }]),
        }),
        targetBinding: targetBinding({
          scopePathBindings: [confirmedRecordDerived("id", "project")],
        }),
      }),
    );
    expectEnable(decision);
  });

  it("source sourceScopeRef UNCONFIRMED → blocked with the structured source-scope-ref requirement (SS-9.1a)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [rd],
        sourceBinding: fullFetchSourceBinding({
          sourceScopeRef: unconfirmedSourceScopeRef([{ key: "project", fieldPath: "project_id" }]),
        }),
        targetBinding: targetBinding({
          scopePathBindings: [confirmedRecordDerived("id", "project")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "source-scope-ref",
      side: "source",
      resourceRef: "users",
      sourceScopeKey: "project",
    });
    // The target binding half is satisfied → no scope-binding requirement for it.
    expect(decision.stillNeeds).not.toContainEqual(
      expect.objectContaining({ kind: "scope-binding" }),
    );
  });

  it("source sourceScopeRef confirmed but MISSING the sourceScopeKey component → blocked (SS-9.1a)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [rd],
        sourceBinding: fullFetchSourceBinding({
          // Confirmed, but carries `owner` — not the `project` the binding selects.
          sourceScopeRef: confirmedSourceScopeRef([
            { key: "owner", fieldPath: "repository.owner" },
          ]),
        }),
        targetBinding: targetBinding({
          scopePathBindings: [confirmedRecordDerived("id", "project")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "source-scope-ref",
      side: "source",
      resourceRef: "users",
      sourceScopeKey: "project",
    });
  });

  it("target binding UNCONFIRMED → blocked with the scope-binding requirement (SS-9.1b)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [rd],
        sourceBinding: fullFetchSourceBinding({
          sourceScopeRef: confirmedSourceScopeRef([{ key: "project", fieldPath: "project_id" }]),
        }),
        targetBinding: targetBinding({
          scopePathBindings: [unconfirmedRecordDerived("id", "project")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "id",
      side: "target",
      resourceRef: "users",
    });
    // The source component half is satisfied → no source-scope-ref requirement.
    expect(decision.stillNeeds).not.toContainEqual(
      expect.objectContaining({ kind: "source-scope-ref" }),
    );
  });

  it("BOTH halves unmet → lists both the scope-binding AND the source-scope-ref requirements", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [rd],
        sourceBinding: fullFetchSourceBinding({}), // no sourceScopeRef at all
        targetBinding: targetBinding({}), // no record-derived entry at all
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toEqual(
      expect.arrayContaining([
        { kind: "scope-binding", parameterName: "id", side: "target", resourceRef: "users" },
        {
          kind: "source-scope-ref",
          side: "source",
          resourceRef: "users",
          sourceScopeKey: "project",
        },
      ]),
    );
  });

  it("composes with a BE-2 ref blocker AND a constant scope blocker (all surface together)", () => {
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          rd,
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          nativeIdRef: unconfirmed(fieldTarget("id")), // BE-2.1 blocker
          sourceScopeRef: unconfirmedSourceScopeRef([{ key: "project", fieldPath: "project_id" }]), // SS-9.1a
          scopePathBindings: [
            {
              kind: "constant",
              parameterName: "owner",
              value: "",
              confirmedBy: null,
              confirmedAt: null,
            }, // SS-5.4
          ],
        }),
        targetBinding: targetBinding({
          scopePathBindings: [confirmedRecordDerived("id", "project")],
        }),
      }),
    );
    expectBlocked(decision);
    expect(decision.stillNeeds).toContainEqual({
      kind: "binding-ref",
      ref: "nativeIdRef",
      side: "source",
      usedFor: "native-id",
    });
    expect(decision.stillNeeds).toContainEqual({
      kind: "source-scope-ref",
      side: "source",
      resourceRef: "users",
      sourceScopeKey: "project",
    });
    expect(decision.stillNeeds).toContainEqual({
      kind: "scope-binding",
      parameterName: "owner",
      side: "source",
      resourceRef: "users",
    });
  });

  it("a constant-only rule is unaffected by the record-derived gate path (no regression)", () => {
    // A source `sourceScopeRef` present but unconfirmed would block a record-derived rule;
    // for a purely `constant` rule it is irrelevant — the constant alone decides.
    const decision = evaluateEnablement(
      validInput({
        requiredScopeBindings: [
          { kind: "constant", parameterName: "owner", side: "source", resourceRef: "users" },
        ],
        sourceBinding: fullFetchSourceBinding({
          sourceScopeRef: unconfirmedSourceScopeRef([{ key: "project", fieldPath: "project_id" }]),
          scopePathBindings: [
            {
              kind: "constant",
              parameterName: "owner",
              value: "alice",
              confirmedBy: "op",
              confirmedAt: T0,
            },
          ],
        }),
      }),
    );
    expectEnable(decision);
  });
});
