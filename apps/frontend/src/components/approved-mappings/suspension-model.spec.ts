import type { ApprovedMappingDto } from "@mediator/contracts";
import type { ApprovedMappingStatus } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  resumeBlockedReason,
  statusExplanation,
  statusSeverity,
  suspensionAction,
} from "./suspension-model.js";

/**
 * SL-10 — the suspend/resume affordance logic. Pure, so the whole state model is asserted
 * without mounting a component: exactly one action per status, and none at all for the three
 * statuses no operator action can lift.
 */
describe("suspensionAction (SL-10)", () => {
  it("offers suspend on an active mapping (SL-10.1)", () => {
    expect(suspensionAction("active")).toStrictEqual({ kind: "suspend" });
  });

  it("offers resume on a suspended mapping (SL-10.2)", () => {
    expect(suspensionAction("suspended")).toStrictEqual({ kind: "resume" });
  });

  it("offers NO resume on a stale mapping — a suspended-then-stale mapping needs re-review (SL-10.5)", () => {
    const action = suspensionAction("stale");
    expect(action.kind).toBe("none");
    if (action.kind !== "none") throw new Error("expected no action");
    expect(action.reason).toContain("re-review");
  });

  it.each<ApprovedMappingStatus>(["superseded", "archived"])(
    "offers no action on a %s mapping (never executed again)",
    (status) => {
      expect(suspensionAction(status).kind).toBe("none");
    },
  );

  it("offers exactly one action across the whole status enum", () => {
    const statuses: readonly ApprovedMappingStatus[] = [
      "active",
      "suspended",
      "stale",
      "superseded",
      "archived",
    ];
    // `status` is a single enum, so the action is a total function of it — never two.
    const kinds = statuses.map((status) => suspensionAction(status).kind);
    expect(kinds).toStrictEqual(["suspend", "resume", "none", "none", "none"]);
  });
});

describe("statusExplanation (SL-10)", () => {
  it("names the distinct mapping-suspended failure for a suspended mapping", () => {
    const text = statusExplanation("suspended");
    expect(text).toContain("mapping-suspended");
    // A hold is NOT a pending re-review — that distinction is the point of the story.
    expect(text).toContain("Nothing awaits re-review");
  });

  it("names the distinct mapping-stale failure for a stale mapping", () => {
    const text = statusExplanation("stale");
    expect(text).toContain("mapping-stale");
    expect(text).toContain("re-review");
  });

  it("describes an active mapping as executing", () => {
    expect(statusExplanation("active")).toContain("Executing");
  });
});

describe("resumeBlockedReason (SL-10)", () => {
  function dto(overrides: Partial<ApprovedMappingDto> & Pick<ApprovedMappingDto, "id">) {
    const value: ApprovedMappingDto = {
      variant: "peer-peer",
      status: "suspended",
      sourceAppId: "app-a",
      targetAppId: "app-b",
      sourceSpecId: "spec-a",
      targetSpecId: "spec-b",
      approvedBy: "reviewer:alice",
      approvedAt: "2026-07-23T00:00:00.000Z",
      ...overrides,
    };
    return value;
  }

  it("blocks resume when another mapping holds the pair's single active slot", () => {
    const held = dto({ id: "held" });
    const incumbent = dto({ id: "incumbent", status: "active" });

    const reason = resumeBlockedReason(held, [held, incumbent]);

    expect(reason).not.toBeNull();
    expect(reason).toContain("incumbent");
  });

  it("does not block when the other active mapping is a DIFFERENT spec pair", () => {
    const held = dto({ id: "held" });
    const elsewhere = dto({ id: "other", status: "active", targetSpecId: "spec-z" });

    expect(resumeBlockedReason(held, [held, elsewhere])).toBeNull();
  });

  it("does not block a lone suspended mapping", () => {
    const held = dto({ id: "held" });
    expect(resumeBlockedReason(held, [held])).toBeNull();
  });

  it("never blocks a non-suspended mapping (its status already decides the action)", () => {
    const active = dto({ id: "a", status: "active" });
    const stale = dto({ id: "s", status: "stale" });
    expect(resumeBlockedReason(active, [active, stale])).toBeNull();
    expect(resumeBlockedReason(stale, [active, stale])).toBeNull();
  });
});

describe("statusSeverity (SL-10)", () => {
  it("is success only while the mapping actually executes", () => {
    expect(statusSeverity("active")).toBe("success");
    expect(statusSeverity("suspended")).toBe("warn");
    expect(statusSeverity("stale")).toBe("warn");
    expect(statusSeverity("superseded")).toBe("secondary");
    expect(statusSeverity("archived")).toBe("secondary");
  });
});
