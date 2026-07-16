import type {
  EnablementRequirementDto,
  SyncRuleResourcePairDto,
  SyncRuleStatusDto,
} from "@mediator/contracts";
import { describe, expect, it } from "vitest";

import {
  blockingRequirements,
  canEnable,
  derivePollingState,
  describeRequirement,
  enablementChecklist,
  findCounterpart,
  hasNeitherLookupPath,
  isOneWay,
  isPushBlockedByCounterpart,
  toEnableRequest,
} from "./enablement-model.js";

const PAIR: SyncRuleResourcePairDto = {
  source: { appId: "app-gitea", appName: "Gitea", resourceRef: "issues" },
  target: { appId: "app-vikunja", appName: "Vikunja", resourceRef: "tasks" },
};

function rule(overrides: Partial<SyncRuleStatusDto> = {}): SyncRuleStatusDto {
  return {
    id: "rule-1",
    approvedMappingId: "mapping-1",
    status: "disabled",
    backfillStatus: null,
    backfillMode: null,
    deletePropagation: "ignore",
    targetDriftCheck: "none",
    pollIntervalOverride: null,
    pollOperationRef: "issues.list",
    lastRunAt: null,
    lastEventAt: null,
    resourcePairRef: "pair-issues-tasks",
    resourcePair: PAIR,
    stillNeeds: [],
    pollerLag: { lastRunAt: null, expectedIntervalMs: null, lagMs: null, stuck: false },
    ...overrides,
  };
}

describe("enablement-model — blocking vs. degradation (SU-1.1/1.3)", () => {
  it("excludes identity-lookup-path from the hard blockers (it clears by skipping backfill)", () => {
    const stillNeeds: EnablementRequirementDto[] = [
      { kind: "identity-lookup-path" },
      { kind: "poll-operation-ref" },
    ];
    const blockers = blockingRequirements(stillNeeds);
    expect(blockers.map((requirement) => requirement.kind)).toEqual(["poll-operation-ref"]);
    expect(hasNeitherLookupPath(stillNeeds)).toBe(true);
  });

  it("renders each blocker in the checklist; a binding-ref links to its side's app", () => {
    const stillNeeds: EnablementRequirementDto[] = [
      { kind: "identity-key", issue: "missing", confirmedCount: 0 },
      { kind: "binding-ref", ref: "nativeIdRef", side: "target", usedFor: "native-id" },
    ];
    const items = enablementChecklist(stillNeeds, PAIR);
    expect(items).toHaveLength(2);
    const bindingItem = items.find((item) => item.key === "binding-ref:target:nativeIdRef");
    expect(bindingItem?.bindingLink).toBe("/apps/app-vikunja");
    expect(items[0]?.label).toContain("identity key");
  });

  it("renders a scope-binding requirement as a blocker naming the parameter+resource, linked to its side's app (SS-6.1)", () => {
    const items = enablementChecklist(
      [{ kind: "scope-binding", parameterName: "owner", side: "source", resourceRef: "issues" }],
      PAIR,
    );
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.key).toBe("scope-binding:source:owner");
    // Names the parameter and its resource so the operator knows exactly what to supply.
    expect(item?.label).toContain("owner");
    expect(item?.label).toContain("issues");
    // Deep-links to the source side's app, whose spec reaches the RB-3 binding panel.
    expect(item?.bindingLink).toBe("/apps/app-gitea");
  });

  it("keeps a scope-binding among the hard blockers so enable stays gated (SS-6.1)", () => {
    const stillNeeds: EnablementRequirementDto[] = [
      { kind: "scope-binding", parameterName: "repo", side: "target", resourceRef: "tasks" },
    ];
    expect(blockingRequirements(stillNeeds).map((requirement) => requirement.kind)).toEqual([
      "scope-binding",
    ]);
    expect(canEnable({ stillNeeds, choice: "link-only", pushBlocked: false })).toBe(false);
  });

  it("describes changeTimestampRef is NOT among the binding-ref blocker kinds (SU-5.2 structural)", () => {
    // The gate's binding-ref requirement enum never includes changeTimestampRef, so it can
    // never appear as a checklist blocker — it is a degradation, not a blocker (BE-2.4).
    const item = describeRequirement(
      { kind: "binding-ref", ref: "deltaCursorRef", side: "source", usedFor: "delta-cursor" },
      PAIR,
    );
    expect(item.label).toContain("deltaCursorRef");
    expect(item.bindingLink).toBe("/apps/app-gitea");
  });
});

describe("enablement-model — one-way vs. bidirectional (SU-1.4)", () => {
  it("treats a rule with no same-pair counterpart as one-way", () => {
    const rules = [rule()];
    expect(isOneWay(rules, rule())).toBe(true);
    expect(findCounterpart(rules, rule())).toBeNull();
  });

  it("finds the counterpart sharing the resourcePairRef", () => {
    const forward = rule({ id: "rule-1" });
    const reverse = rule({ id: "rule-2", resourcePairRef: "pair-issues-tasks" });
    expect(findCounterpart([forward, reverse], forward)?.id).toBe("rule-2");
    expect(isOneWay([forward, reverse], forward)).toBe(false);
  });
});

describe("enablement-model — push-on-both prevention (SU-1.2)", () => {
  it("blocks push when the counterpart already backfills push", () => {
    const counterpart = rule({ id: "rule-2", backfillMode: "push" });
    expect(isPushBlockedByCounterpart(counterpart)).toBe(true);
    expect(isPushBlockedByCounterpart(rule({ id: "rule-2", backfillMode: "link-only" }))).toBe(
      false,
    );
    expect(isPushBlockedByCounterpart(null)).toBe(false);
  });
});

describe("enablement-model — canEnable gate (SU-1.1/1.2/1.3)", () => {
  it("is false while a hard blocker remains, regardless of choice", () => {
    expect(
      canEnable({
        stillNeeds: [{ kind: "poll-operation-ref" }],
        choice: "link-only",
        pushBlocked: false,
      }),
    ).toBe(false);
  });

  it("requires an explicit backfill choice (no default)", () => {
    expect(canEnable({ stillNeeds: [], choice: null, pushBlocked: false })).toBe(false);
    expect(canEnable({ stillNeeds: [], choice: "link-only", pushBlocked: false })).toBe(true);
  });

  it("refuses push when the counterpart pushes", () => {
    expect(canEnable({ stillNeeds: [], choice: "push", pushBlocked: true })).toBe(false);
    expect(canEnable({ stillNeeds: [], choice: "link-only", pushBlocked: true })).toBe(true);
  });

  it("permits enable with neither lookup path ONLY when backfill is skipped", () => {
    const stillNeeds: EnablementRequirementDto[] = [{ kind: "identity-lookup-path" }];
    expect(canEnable({ stillNeeds, choice: "link-only", pushBlocked: false })).toBe(false);
    expect(canEnable({ stillNeeds, choice: "push", pushBlocked: false })).toBe(false);
    expect(canEnable({ stillNeeds, choice: "skip", pushBlocked: false })).toBe(true);
  });
});

describe("enablement-model — polling state (SU-1.5 / BE-3)", () => {
  it("maps disabled / running-backfill / polling", () => {
    expect(derivePollingState(rule({ status: "disabled" }))).toBe("disabled");
    expect(derivePollingState(rule({ status: "enabled", backfillStatus: "running" }))).toBe(
      "backfill-running",
    );
    expect(derivePollingState(rule({ status: "enabled", backfillStatus: "pending" }))).toBe(
      "backfill-running",
    );
    expect(derivePollingState(rule({ status: "enabled", backfillStatus: "completed" }))).toBe(
      "polling",
    );
    expect(derivePollingState(rule({ status: "enabled", backfillStatus: "skipped" }))).toBe(
      "polling",
    );
  });
});

describe("enablement-model — toEnableRequest", () => {
  it("maps the choice to the SA-1 enable body", () => {
    expect(toEnableRequest("skip")).toEqual({ action: "skip-backfill" });
    expect(toEnableRequest("link-only")).toEqual({ action: "backfill", backfillMode: "link-only" });
    expect(toEnableRequest("push")).toEqual({ action: "backfill", backfillMode: "push" });
  });
});
