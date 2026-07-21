import type { AdapterBinding, AdapterBindingRole } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { firstSuccessExhaustionCause, orderFirstSuccessAttempts } from "./first-success.js";
import type {
  BindingFailure,
  EliminatedBinding,
  PlannedBinding,
  PlannerBindingCause,
  ResolutionPlan,
} from "./pipeline-types.js";

/**
 * The pure decision core of `fanout-first-success` (AG-6) — ordering, role-validity defense,
 * and exhaustion-cause selection — over hand-built plans, no backend involved.
 */

function adapterBinding(id: string, role: AdapterBindingRole): AdapterBinding {
  return {
    id,
    adapterEndpointId: "e1",
    backendAppId: `backend-${id}`,
    backendOperationId: "res/op",
    approvedMappingId: "m1",
    role,
    status: "active",
  };
}

function planned(id: string, role: AdapterBindingRole, executionOrder: number): PlannedBinding {
  return { bindingId: id, binding: adapterBinding(id, role), role, executionOrder };
}

function eliminated(
  id: string,
  role: AdapterBindingRole,
  executionOrder: number,
  cause: PlannerBindingCause,
): EliminatedBinding {
  return { bindingId: id, role, executionOrder, cause };
}

/** A fanout-first-success plan: healthy bindings grouped by order, plus any eliminated ones. */
function plan(
  bindings: readonly PlannedBinding[],
  eliminatedBindings: readonly EliminatedBinding[] = [],
): ResolutionPlan {
  const byOrder = new Map<number, PlannedBinding[]>();
  for (const binding of bindings) {
    const group = byOrder.get(binding.executionOrder) ?? [];
    group.push(binding);
    byOrder.set(binding.executionOrder, group);
  }
  return {
    endpointId: "e1",
    aggregationStrategy: "fanout-first-success",
    strictness: "degraded",
    groups: [...byOrder.entries()]
      .sort(([a], [b]) => a - b)
      .map(([executionOrder, groupBindings]) => ({ executionOrder, bindings: groupBindings })),
    eliminated: eliminatedBindings,
  };
}

/** The ordered binding ids of a successful ordering (throws on a defect). */
function orderedIds(p: ResolutionPlan): string[] {
  const result = orderFirstSuccessAttempts(p);
  if (!result.ok) throw new Error(`expected ok ordering, got: ${result.detail}`);
  return result.attempts.map((attempt) =>
    attempt.kind === "planned" ? attempt.planned.bindingId : attempt.eliminated.bindingId,
  );
}

describe("orderFirstSuccessAttempts — AG-6.1 ordering", () => {
  it("tries the primary FIRST by role, even when a fallback has a lower executionOrder", () => {
    // The primary is at order 9; a fallback sits at order 0 — the primary still goes first.
    const ids = orderedIds(plan([planned("p", "primary", 9), planned("f", "fallback", 0)]));
    expect(ids).toEqual(["p", "f"]);
  });

  it("orders fallbacks by ascending executionOrder after the primary", () => {
    const ids = orderedIds(
      plan([
        planned("p", "primary", 0),
        planned("f2", "fallback", 2),
        planned("f1", "fallback", 1),
        planned("f3", "fallback", 3),
      ]),
    );
    expect(ids).toEqual(["p", "f1", "f2", "f3"]);
  });

  it("breaks an executionOrder tie among fallbacks deterministically by binding id", () => {
    // Defensive: CO-2.4 forbids ties, but ordering must still be total + deterministic.
    const ids = orderedIds(
      plan([
        planned("p", "primary", 0),
        planned("fb", "fallback", 1),
        planned("fa", "fallback", 1),
      ]),
    );
    expect(ids).toEqual(["p", "fa", "fb"]);
  });

  it("includes eliminated bindings in the chain, ordered among the fallbacks by executionOrder", () => {
    // A stale fallback at order 1 is an attempt that will be SKIPPED, but it keeps its place.
    const ids = orderedIds(
      plan(
        [planned("p", "primary", 0), planned("f2", "fallback", 2)],
        [eliminated("f1", "fallback", 1, { cause: "mapping-stale" })],
      ),
    );
    expect(ids).toEqual(["p", "f1", "f2"]);
  });

  it("places an eliminated PRIMARY first as well (role wins over order)", () => {
    const ids = orderedIds(
      plan(
        [planned("f1", "fallback", 1)],
        [eliminated("p", "primary", 5, { cause: "mapping-suspended" })],
      ),
    );
    expect(ids).toEqual(["p", "f1"]);
  });
});

describe("orderFirstSuccessAttempts — AG-6.1 role defense", () => {
  it("fails loud when a supplement is present", () => {
    const result = orderFirstSuccessAttempts(
      plan([planned("p", "primary", 0), planned("s", "supplement", 1)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("role 'supplement'");
  });

  it("fails loud on zero primaries", () => {
    const result = orderFirstSuccessAttempts(plan([planned("f1", "fallback", 0)]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("exactly one primary");
    expect(result.detail).toContain("got 0");
  });

  it("fails loud on more than one primary", () => {
    const result = orderFirstSuccessAttempts(
      plan([planned("p1", "primary", 0), planned("p2", "primary", 1)]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("exactly one primary");
    expect(result.detail).toContain("got 2");
  });

  it("counts an eliminated primary toward the exactly-one-primary rule", () => {
    // A healthy primary AND an eliminated primary = two primaries → a composition defect.
    const result = orderFirstSuccessAttempts(
      plan(
        [planned("p1", "primary", 0)],
        [eliminated("p2", "primary", 1, { cause: "mapping-stale" })],
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("got 2");
  });

  it("fails loud on a non-fanout-first-success plan", () => {
    const result = orderFirstSuccessAttempts({
      endpointId: "e1",
      aggregationStrategy: "single",
      strictness: "degraded",
      groups: [{ executionOrder: 0, bindings: [planned("p", "primary", 0)] }],
      eliminated: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("received a 'single' plan");
  });
});

describe("firstSuccessExhaustionCause — AG-6.4", () => {
  const stale: BindingFailure = { cause: "mapping-stale" };
  const upstream: BindingFailure = {
    cause: "upstream-error",
    backendAppId: "b",
    detail: "HTTP 503",
  };

  it("reports the first-tried (primary's) cause, not a later one", () => {
    // Primary stale, a later fallback an upstream error → the chain reports mapping-stale.
    expect(firstSuccessExhaustionCause([stale, upstream])).toEqual(stale);
  });

  it("an all-stale chain reports mapping-stale (never a generic upstream error)", () => {
    expect(firstSuccessExhaustionCause([stale, stale, stale])).toEqual(stale);
  });

  it("reports the primary's upstream-error when the primary was tried live and failed", () => {
    expect(firstSuccessExhaustionCause([upstream, stale])).toEqual(upstream);
  });

  it("degrades an empty cause list to a loud mediator defect (unreachable in practice)", () => {
    expect(firstSuccessExhaustionCause([]).cause).toBe("mediator-transform-error");
  });
});
