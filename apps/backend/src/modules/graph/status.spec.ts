import type { ApprovedMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  GraphEdgeStatus,
  adapterBindingMemberState,
  deriveEdgeStatus,
  syncRuleMemberState,
  type EdgeMemberState,
} from "./status.js";

/**
 * Unit tests for the **pure** status-from-aggregate core of the incremental graph
 * projection (GR-2.3/GR-3.3). The load-bearing invariant: a partially-paused (or
 * partially-stale) aggregate never reduces to the same token as a fully-healthy one.
 */
describe("deriveEdgeStatus (GR-2.3/GR-3.3 — reduce an aggregate to one edge status)", () => {
  it("all healthy → active", () => {
    expect(deriveEdgeStatus(["healthy", "healthy", "healthy"])).toBe(GraphEdgeStatus.active);
    expect(deriveEdgeStatus(["healthy"])).toBe(GraphEdgeStatus.active);
  });

  it("a mix of healthy + paused → degraded (never active)", () => {
    const status = deriveEdgeStatus(["healthy", "paused"]);
    expect(status).toBe(GraphEdgeStatus.degraded);
    expect(status).not.toBe(GraphEdgeStatus.active);
  });

  it("all paused → paused", () => {
    expect(deriveEdgeStatus(["paused", "paused"])).toBe(GraphEdgeStatus.paused);
  });

  it("all stale → stale", () => {
    expect(deriveEdgeStatus(["stale", "stale"])).toBe(GraphEdgeStatus.stale);
  });

  it("any mix involving stale → degraded (healthy+stale, paused+stale, all three)", () => {
    expect(deriveEdgeStatus(["healthy", "stale"])).toBe(GraphEdgeStatus.degraded);
    expect(deriveEdgeStatus(["paused", "stale"])).toBe(GraphEdgeStatus.degraded);
    expect(deriveEdgeStatus(["healthy", "paused", "stale"])).toBe(GraphEdgeStatus.degraded);
  });

  it("a single paused member is paused, a single stale member is stale (not degraded)", () => {
    expect(deriveEdgeStatus(["paused"])).toBe(GraphEdgeStatus.paused);
    expect(deriveEdgeStatus(["stale"])).toBe(GraphEdgeStatus.stale);
  });

  it("a partially-paused aggregate is never rendered identically to a fully-healthy one", () => {
    const healthyOnly: EdgeMemberState[] = ["healthy", "healthy"];
    const partiallyPaused: EdgeMemberState[] = ["healthy", "paused"];
    expect(deriveEdgeStatus(healthyOnly)).not.toBe(deriveEdgeStatus(partiallyPaused));
  });
});

const ACTIVE: ApprovedMapping["status"] = "active";

describe("syncRuleMemberState (GR-2.2 — a rule's effective health)", () => {
  it("enabled rule under an active mapping → healthy", () => {
    expect(syncRuleMemberState("enabled", ACTIVE)).toBe("healthy");
  });

  it("disabled rule under an active mapping → paused", () => {
    expect(syncRuleMemberState("disabled", ACTIVE)).toBe("paused");
  });

  it("a suspended mapping pauses even an enabled rule (SL-10)", () => {
    expect(syncRuleMemberState("enabled", "suspended")).toBe("paused");
  });

  it("a stale/superseded/archived mapping makes the member stale (SL-4/SL-7/AL-2), overriding an enabled rule", () => {
    expect(syncRuleMemberState("enabled", "stale")).toBe("stale");
    expect(syncRuleMemberState("enabled", "superseded")).toBe("stale");
    expect(syncRuleMemberState("enabled", "archived")).toBe("stale");
  });
});

describe("adapterBindingMemberState (GR-3.2/GR-3.3 — a binding's effective health)", () => {
  it("active binding under an active endpoint + active mapping → healthy", () => {
    expect(adapterBindingMemberState("active", "active", ACTIVE)).toBe("healthy");
  });

  it("proposed/disabled binding → paused", () => {
    expect(adapterBindingMemberState("proposed", "active", ACTIVE)).toBe("paused");
    expect(adapterBindingMemberState("disabled", "active", ACTIVE)).toBe("paused");
  });

  it("a disabled endpoint pauses even an active binding (GR-3.2 — the whole endpoint is off)", () => {
    expect(adapterBindingMemberState("active", "disabled", ACTIVE)).toBe("paused");
  });

  it("a composition-required endpoint defers to the binding's own status (RT-3.3 keeps serving)", () => {
    expect(adapterBindingMemberState("active", "composition-required", ACTIVE)).toBe("healthy");
    expect(adapterBindingMemberState("proposed", "composition-required", ACTIVE)).toBe("paused");
  });

  it("a stale/superseded/archived mapping makes the member stale, overriding an active binding", () => {
    expect(adapterBindingMemberState("active", "active", "stale")).toBe("stale");
    expect(adapterBindingMemberState("active", "active", "superseded")).toBe("stale");
    expect(adapterBindingMemberState("active", "active", "archived")).toBe("stale");
  });

  it("a suspended mapping pauses an active binding", () => {
    expect(adapterBindingMemberState("active", "active", "suspended")).toBe("paused");
  });
});
