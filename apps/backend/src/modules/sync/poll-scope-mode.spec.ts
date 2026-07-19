import type {
  ResourceBinding,
  ScopeCorrespondence,
  ScopePathBinding,
  SyncRule,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { derivePollScopeMode, pollScopeModeView } from "./poll-scope-mode.js";

/**
 * SS-13.5 — the derive-then-correct poll-enumeration mode. `derivePollScopeMode` picks
 * the mode from the source container binding; `pollScopeModeView` layers the operator
 * override on top (override ?? derived). All three modes + the override are covered here.
 */

const CONFIRMED = { confirmedBy: "op", confirmedAt: new Date("2026-07-19T00:00:00.000Z") };
const UNCONFIRMED = { confirmedBy: null, confirmedAt: null };

function scopeLinkBinding(confirmed: boolean): ScopePathBinding {
  return {
    kind: "scope-link",
    parameterName: "owner",
    scopeKeyRef: "owner",
    ...(confirmed ? CONFIRMED : UNCONFIRMED),
  };
}

function constantBinding(): ScopePathBinding {
  return { kind: "constant", parameterName: "owner", value: "alice", ...CONFIRMED };
}

function sourceBinding(
  scopePathBindings: readonly ScopePathBinding[] | undefined,
): ResourceBinding {
  return {
    id: "rb-source",
    apiSpecId: "spec-source",
    resourceRef: "issues",
    ...(scopePathBindings !== undefined ? { scopePathBindings: [...scopePathBindings] } : {}),
  };
}

function correspondence(withSourceContainer: boolean): ScopeCorrespondence {
  return {
    id: "sc-1",
    resourcePairRef: "pair::issues",
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: "app-target", resourceRef: "projects" },
    ...(withSourceContainer
      ? { sourceContainerRef: { appId: "app-source", resourceRef: "repos" } }
      : {}),
    confirmedBy: "op",
    confirmedAt: new Date("2026-07-19T00:00:00.000Z"),
  };
}

function rule(pollScopeMode?: SyncRule["pollScopeMode"]): SyncRule {
  return {
    id: "rule-1",
    approvedMappingId: "mapping-1",
    resourcePairRef: "pair::issues",
    status: "disabled",
    ...(pollScopeMode !== undefined ? { pollScopeMode } : {}),
  };
}

describe("derivePollScopeMode (SS-13.5)", () => {
  it("SS-13.1 cross-scope: a source read with no confirmed scope-link param (record-carried / non-scoped)", () => {
    // No scope path bindings at all → one cross-scope call.
    expect(derivePollScopeMode(sourceBinding([]), undefined)).toBe("cross-scope");
    expect(derivePollScopeMode(sourceBinding(undefined), undefined)).toBe("cross-scope");
    // An L1 constant scope param is single-scope, still one cross-scope call.
    expect(derivePollScopeMode(sourceBinding([constantBinding()]), undefined)).toBe("cross-scope");
    // An UNCONFIRMED scope-link param is used nowhere → still cross-scope.
    expect(derivePollScopeMode(sourceBinding([scopeLinkBinding(false)]), undefined)).toBe(
      "cross-scope",
    );
  });

  it("SS-13.2 per-scope-enumerated: a per-container source read + an enumerable source container", () => {
    expect(derivePollScopeMode(sourceBinding([scopeLinkBinding(true)]), correspondence(true))).toBe(
      "per-scope-enumerated",
    );
  });

  it("SS-13.4 per-scope-pinned: a per-container source read with NO enumerable source container", () => {
    // No correspondence, or a correspondence without a sourceContainerRef → pinned.
    expect(derivePollScopeMode(sourceBinding([scopeLinkBinding(true)]), undefined)).toBe(
      "per-scope-pinned",
    );
    expect(
      derivePollScopeMode(sourceBinding([scopeLinkBinding(true)]), correspondence(false)),
    ).toBe("per-scope-pinned");
  });
});

describe("pollScopeModeView (SS-13.5 override)", () => {
  it("reports the derived mode when there is no override (override null, effective = derived)", () => {
    const view = pollScopeModeView(
      rule(),
      sourceBinding([scopeLinkBinding(true)]),
      correspondence(true),
    );
    expect(view).toStrictEqual({
      override: undefined,
      derived: "per-scope-enumerated",
      effective: "per-scope-enumerated",
    });
  });

  it("honors the operator override over the derived mode (derive-then-correct)", () => {
    // Derived would be cross-scope, but the operator pinned per-scope-pinned.
    const view = pollScopeModeView(rule("per-scope-pinned"), sourceBinding([]), undefined);
    expect(view).toStrictEqual({
      override: "per-scope-pinned",
      derived: "cross-scope",
      effective: "per-scope-pinned",
    });
  });
});
