import type { AdapterBinding, AdapterEndpoint, ApprovedMapping, SyncRule } from "@mediator/domain";

/**
 * The **pure** status-from-aggregate core of the incremental `GraphEdge` projection
 * (GR-2/GR-3, `docs/requirements/phase-6-graph.md`). No I/O: it maps the current
 * aggregate of a `(app pair, direction, type)`'s `SyncRule`s / `AdapterBinding`s to
 * the single `status` token the projection persists. Kept separate from the
 * persistence orchestration ({@link ./projection.ts}) so the reduction is
 * unit-testable over hand-built aggregates — the load-bearing decision GR-2.3/GR-3.3
 * turns on (a partially-paused edge must never read identically to a healthy one).
 */

/**
 * **The finalized `GraphEdge.status` vocabulary for the incremental projection
 * (open question 2, GR-2.3/GR-3.3).** `GraphEdge.status` is a free-form string in
 * the domain (the concept does not enumerate it — see
 * `packages/domain/src/downstream-artifacts.ts` `graphEdgeSchema`), so GR-2/GR-3
 * fix the exact tokens a *recompute* writes here, aligning with the derived default
 * GR-1's own integration test already exercises (`active` → `degraded`):
 *
 * - `active`   — every member is healthy (all rules enabled / all bindings active,
 *                behind an `active` mapping).
 * - `degraded` — a **mix** (some healthy, some not): the "some paused / some stale"
 *                bucket. Never equal to `active` for a partially-paused edge.
 * - `paused`   — every member is paused (all rules disabled / all bindings
 *                proposed-or-disabled, or a `suspended` mapping) and none is stale.
 * - `stale`    — every member is stale (its mapping went `stale`/`superseded`/
 *                `archived`, SL-4/SL-7/AL-2) — surfaced distinctly so a stale edge is
 *                never rendered as a healthy one (GR-6.2).
 *
 * These are the *recompute* tokens. They coexist with the ensure-exists create
 * tokens Phase 3 writes at instantiation (`disabled` for a fresh sync edge,
 * `proposed` for a fresh adapter edge — `artifact-instantiation/derive.ts`): the
 * create value stands until the first status-change trigger recomputes the edge into
 * this vocabulary.
 */
export const GraphEdgeStatus = {
  active: "active",
  degraded: "degraded",
  paused: "paused",
  stale: "stale",
} as const;
export type GraphEdgeStatus = (typeof GraphEdgeStatus)[keyof typeof GraphEdgeStatus];

/**
 * A single aggregate member's **effective** health, independent of edge type: a rule
 * or binding is `healthy` (enabled/active behind an active mapping), `paused`
 * (operator-off, not-yet-composed, or a `suspended` mapping — running would be a
 * no-op), or `stale` (its mapping went `stale`/`superseded`/`archived`). The two
 * type-specific derivations ({@link syncRuleMemberState}, {@link adapterBindingMemberState})
 * fold in the mapping's lifecycle so the edge reflects the true dependency state, not
 * just the operator's enable switch.
 */
export type EdgeMemberState = "healthy" | "paused" | "stale";

/**
 * How a member's parent `ApprovedMapping.status` overrides its own enable state. A
 * `suspended` mapping is a manual operator hold (SL-10) → the member is `paused`
 * regardless of its rule/binding status; a `stale` (breaking spec change, SL-4),
 * `superseded` (replaced by a successor, SL-7), or `archived` (app deregistered,
 * AL-2) mapping → the member is `stale`. Only an `active` mapping defers to the
 * member's own status. Exhaustive over the five `ApprovedMappingStatus` values — a
 * sixth would surface here as a compile error rather than a silent mis-projection.
 */
function mappingContribution(
  mappingStatus: ApprovedMapping["status"],
): "defer" | "paused" | "stale" {
  switch (mappingStatus) {
    case "active":
      return "defer";
    case "suspended":
      return "paused";
    case "stale":
    case "superseded":
    case "archived":
      return "stale";
  }
}

/**
 * GR-2.2 — the effective state of one `SyncRule` in its sync edge's aggregate: its
 * mapping's lifecycle wins (`stale`/`suspended` → stale/paused), else an `enabled`
 * rule is `healthy` and a `disabled` rule is `paused`.
 */
export function syncRuleMemberState(
  ruleStatus: SyncRule["status"],
  mappingStatus: ApprovedMapping["status"],
): EdgeMemberState {
  const contribution = mappingContribution(mappingStatus);
  if (contribution !== "defer") {
    return contribution;
  }
  return ruleStatus === "enabled" ? "healthy" : "paused";
}

/**
 * GR-3.2/GR-3.3 — the effective state of one `AdapterBinding` in its
 * adapter-dependency edge's aggregate. Precedence: its mapping's lifecycle wins
 * (`stale`/`suspended`); then a `disabled` **endpoint** pauses the binding whatever
 * its own status (the whole endpoint is switched off, RT-3.2 — so a disable makes the
 * edge reflect the paused dependency, GR-3.2/GR-5.4); otherwise an `active` binding is
 * `healthy` and a `proposed`/`disabled` binding is `paused` (neither is serving). A
 * `composition-required` endpoint defers to the binding's own status: its prior
 * `active` binding keeps serving while a human recomposes (RT-3.3).
 */
export function adapterBindingMemberState(
  bindingStatus: AdapterBinding["status"],
  endpointStatus: AdapterEndpoint["status"],
  mappingStatus: ApprovedMapping["status"],
): EdgeMemberState {
  const contribution = mappingContribution(mappingStatus);
  if (contribution !== "defer") {
    return contribution;
  }
  if (endpointStatus === "disabled") {
    return "paused";
  }
  return bindingStatus === "active" ? "healthy" : "paused";
}

/**
 * **GR-2.3/GR-3.3 — reduce a non-empty aggregate to one edge `status`.** All members
 * one state → that state's token (`active`/`paused`/`stale`); any mix → `degraded`.
 * This guarantees a partially-paused (or partially-stale) edge is never the `active`
 * token, so the graph can never render a degraded relationship as a healthy one.
 *
 * **Precondition:** `members` is non-empty — an empty aggregate has no backing
 * rules/bindings and is *removed*, not statused (GR-2.5/GR-3.5), a decision the
 * projection makes before ever calling this. Called with an empty array it returns
 * `active` (the all-healthy vacuous case); the projection's empty-guard makes that
 * unreachable.
 */
export function deriveEdgeStatus(members: readonly EdgeMemberState[]): GraphEdgeStatus {
  let healthy = 0;
  let paused = 0;
  let stale = 0;
  for (const member of members) {
    if (member === "healthy") {
      healthy += 1;
    } else if (member === "paused") {
      paused += 1;
    } else {
      stale += 1;
    }
  }
  const total = members.length;
  if (healthy === total) {
    return GraphEdgeStatus.active;
  }
  if (stale === total) {
    return GraphEdgeStatus.stale;
  }
  if (paused === total) {
    return GraphEdgeStatus.paused;
  }
  return GraphEdgeStatus.degraded;
}
