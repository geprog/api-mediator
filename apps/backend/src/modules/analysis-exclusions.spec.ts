import type { ReInclusionScope } from "@mediator/db";
import type { ApiSpec, ApprovedMapping, Ir } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryStore, FakeUnitOfWork } from "../testing/fake-persistence.testkit.js";
import {
  AnalysisExclusionsService,
  RE_INCLUSION_AUDIT_PREFIX,
  reincludedResourceRefs,
} from "./analysis-exclusions.js";

/**
 * **SL-9 — removing a resource group from `analysisExclusions` triggers the scoped
 * incremental analysis.** These cover the trigger itself: the set-difference condition
 * (a removal fires; an addition and a no-op replace do not), the recorded
 * `re-inclusion` {@link ReInclusionScope} the worker later runs, the countable audit
 * signal (SL-9.5 / OB-2), and the analysis-only invariant that nothing already reviewed
 * is touched (SL-9.3). The worker-side analysis itself is covered end to end by
 * `spec-reinclusion-analysis.integration.spec.ts`.
 */

const SPEC_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const OPERATOR = "ops@example.test";

function ir(...resourceRefs: string[]): Ir {
  return resourceRefs.map((resourceRef) => ({
    resourceRef,
    name: resourceRef,
    operations: [],
    schemas: [],
    crossResourceRefs: [],
  }));
}

function seedSpec(store: InMemoryStore, analysisExclusions: string[]): ApiSpec {
  const spec: ApiSpec = {
    id: SPEC_ID,
    appId: APP_ID,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR: ir("issues", "labels", "audit"),
    analysisExclusions,
    version: 3,
    contentHash: "hash",
    status: "active",
    createdAt: new Date("2026-07-23T00:00:00.000Z"),
  };
  store.specs.set(spec.id, spec);
  return spec;
}

/** An approved mapping over an unrelated resource — SL-9.3's "must stay untouched" subject. */
function seedApprovedMapping(store: InMemoryStore): ApprovedMapping {
  const mapping: ApprovedMapping = {
    id: "33333333-3333-4333-8333-333333333333",
    sourceSpecId: SPEC_ID,
    targetSpecId: "44444444-4444-4444-8444-444444444444",
    sourceAppId: APP_ID,
    targetAppId: "55555555-5555-4555-8555-555555555555",
    variant: "peer-peer",
    status: "active",
    approvedBy: OPERATOR,
    approvedAt: new Date("2026-07-22T00:00:00.000Z"),
  };
  store.approvedMappings.set(mapping.id, mapping);
  return mapping;
}

let store: InMemoryStore;
let service: AnalysisExclusionsService;

beforeEach(() => {
  store = new InMemoryStore();
  service = new AnalysisExclusionsService({ unitOfWork: new FakeUnitOfWork(store) });
});

describe("reincludedResourceRefs (SL-9 trigger condition)", () => {
  it("returns only the removed refs", () => {
    expect(reincludedResourceRefs(["issues", "labels"], ["issues"])).toEqual(["labels"]);
  });

  it("returns nothing when an exclusion is added", () => {
    expect(reincludedResourceRefs(["issues"], ["issues", "labels"])).toEqual([]);
  });

  it("returns nothing for a no-op replace, whatever the order", () => {
    expect(reincludedResourceRefs(["issues", "labels"], ["labels", "issues"])).toEqual([]);
  });

  it("returns every removed ref when the list is cleared", () => {
    expect(reincludedResourceRefs(["issues", "labels"], [])).toEqual(["issues", "labels"]);
  });

  it("collapses duplicates in the previous list", () => {
    expect(reincludedResourceRefs(["labels", "labels"], [])).toEqual(["labels"]);
  });
});

describe("AnalysisExclusionsService.replace — SL-9 re-inclusion trigger", () => {
  it("records a scoped re-inclusion job for the removed ref (crit 1)", async () => {
    seedSpec(store, ["labels", "audit"]);

    const updated = await service.replace(SPEC_ID, ["audit"], OPERATOR);

    expect(updated.analysisExclusions).toEqual(["audit"]);
    expect(store.scopedDetectionJobs).toHaveLength(1);
    const job = store.scopedDetectionJobs[0];
    expect(job?.apiSpecId).toBe(SPEC_ID);
    const expectedScope: ReInclusionScope = {
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels"],
    };
    expect(job?.scope).toEqual(expectedScope);
  });

  it("carries every removed ref in one scope when several are re-included", async () => {
    seedSpec(store, ["labels", "audit"]);

    await service.replace(SPEC_ID, [], OPERATOR);

    expect(store.scopedDetectionJobs[0]?.scope).toEqual({
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels", "audit"],
    });
  });

  it("triggers nothing when an exclusion is ADDED", async () => {
    seedSpec(store, ["labels"]);

    await service.replace(SPEC_ID, ["labels", "audit"], OPERATOR);

    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toEqual([]);
  });

  it("triggers nothing for a no-op replace (same set, reordered)", async () => {
    seedSpec(store, ["labels", "audit"]);

    await service.replace(SPEC_ID, ["audit", "labels"], OPERATOR);

    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toEqual([]);
  });

  it("emits a countable, operator-attributed audit row naming the re-included refs (crit 5)", async () => {
    seedSpec(store, ["labels"]);

    await service.replace(SPEC_ID, [], OPERATOR);

    expect(store.auditLog).toHaveLength(1);
    const entry = store.auditLog[0];
    expect(entry?.type).toBe("mapping-decision");
    expect(entry?.actor).toBe(OPERATOR);
    expect(entry?.details).toContain(RE_INCLUSION_AUDIT_PREFIX);
    expect(entry?.details).toContain("labels");
    expect(entry?.details).toContain(SPEC_ID);
    // A `mapping-decision` row leaves the sync-execution status unset (SD-4 crit 1).
    expect(entry?.status).toBeUndefined();
  });

  it("leaves existing ApprovedMappings untouched — exclusions govern analysis only (crit 3)", async () => {
    seedSpec(store, ["labels"]);
    const mapping = seedApprovedMapping(store);

    await service.replace(SPEC_ID, [], OPERATOR);

    // Re-inclusion only ADDS review surface: nothing approved is paused, re-pinned or removed.
    expect(store.approvedMappings.get(mapping.id)).toStrictEqual(mapping);
    expect(store.scopedDetectionJobs).toHaveLength(1);
  });

  it("rejects an unknown resourceRef and triggers nothing (SI-4 crit 4)", async () => {
    seedSpec(store, ["labels"]);

    await expect(service.replace(SPEC_ID, ["does-not-exist"], OPERATOR)).rejects.toThrow(
      /Unknown resourceRef/,
    );
    // Validation runs before any write, so nothing was persisted in the first place.
    expect(store.specs.get(SPEC_ID)?.analysisExclusions).toEqual(["labels"]);
    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toEqual([]);
  });

  it("rejects an unknown spec", async () => {
    await expect(service.replace(SPEC_ID, [], OPERATOR)).rejects.toThrow(/not found/);
  });
});

/**
 * **SL-9 — a re-inclusion must never be silently swallowed.** Only one un-finished
 * `mapping_detection_job` may exist per spec, and a *scoped* job freezes its resource
 * list in the row, so an `ON CONFLICT DO NOTHING` collapse would drop the re-included
 * group forever (the reconciliation sweep only re-derives specs with *no* job at all)
 * while still committing the scope change and an audit row claiming an analysis.
 *
 * Every branch below therefore either guarantees the analysis or refuses the edit — and
 * an audit row exists **iff** the analysis was guaranteed, which is what keeps the OB-2
 * count honest.
 */
describe("AnalysisExclusionsService.replace — collapse against an un-finished job", () => {
  const JOB_ID = "66666666-6666-4666-8666-666666666666";

  it("merges into a still-pending re-inclusion job instead of dropping the refs", async () => {
    seedSpec(store, ["audit"]);
    // The first removal's job, not yet claimed by the worker.
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "pending",
      scope: { kind: "re-inclusion", reincludedResourceGroups: ["labels"] },
    };

    await service.replace(SPEC_ID, [], OPERATOR);

    // `audit` joined `labels` in the SAME job — neither is lost.
    expect(store.unfinishedDetectionJob.scope).toEqual({
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels", "audit"],
    });
    // No second job was inserted (the partial-unique index forbids it).
    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toHaveLength(1);
    expect(store.auditLog[0]?.details).toContain("merged into the pending re-inclusion job");
  });

  it("does not duplicate a ref already queued in the pending re-inclusion job", async () => {
    seedSpec(store, ["labels"]);
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "pending",
      scope: { kind: "re-inclusion", reincludedResourceGroups: ["labels"] },
    };

    await service.replace(SPEC_ID, [], OPERATOR);

    expect(store.unfinishedDetectionJob.scope).toEqual({
      kind: "re-inclusion",
      reincludedResourceGroups: ["labels"],
    });
  });

  it("accepts a collapse onto a pending FULL detection job (it re-derives from current state)", async () => {
    seedSpec(store, ["labels"]);
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "pending",
      scope: null,
    };

    const updated = await service.replace(SPEC_ID, [], OPERATOR);

    // A full run re-reads the spec (and its exclusions) when the worker claims it, so
    // the re-included group is analyzed without a job of our own.
    expect(updated.analysisExclusions).toEqual([]);
    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toHaveLength(1);
    expect(store.auditLog[0]?.details).toContain("folded into the pending full detection run");
  });

  it("rejects with 409 while an analysis is RUNNING — it already read the exclusions", async () => {
    seedSpec(store, ["labels"]);
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "running",
      scope: null,
    };

    await expect(service.replace(SPEC_ID, [], OPERATOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    // NOTHING committed: the exclusion stands, no job, and — crucially — no audit row
    // claiming an analysis that would never have happened.
    expect(store.specs.get(SPEC_ID)?.analysisExclusions).toEqual(["labels"]);
    expect(store.scopedDetectionJobs).toEqual([]);
    expect(store.auditLog).toEqual([]);
  });

  it("rejects with 409 when a pending scoped job of another kind cannot absorb the refs", async () => {
    seedSpec(store, ["labels"]);
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "pending",
      scope: {
        kind: "additive-delta",
        supersededSpecId: "77777777-7777-4777-8777-777777777777",
        newResourceGroups: ["orders"],
        changedResources: [],
      },
    };

    await expect(service.replace(SPEC_ID, [], OPERATOR)).rejects.toMatchObject({
      statusCode: 409,
    });

    // The other job's frozen scope is left exactly as it was — never overwritten.
    expect(store.unfinishedDetectionJob.scope).toEqual({
      kind: "additive-delta",
      supersededSpecId: "77777777-7777-4777-8777-777777777777",
      newResourceGroups: ["orders"],
      changedResources: [],
    });
    expect(store.specs.get(SPEC_ID)?.analysisExclusions).toEqual(["labels"]);
    expect(store.auditLog).toEqual([]);
  });

  it("still triggers nothing for a pure exclusion ADD, whatever job is in flight", async () => {
    seedSpec(store, ["labels"]);
    store.unfinishedDetectionJob = {
      apiSpecId: SPEC_ID,
      id: JOB_ID,
      status: "running",
      scope: null,
    };

    // No re-inclusion → the collapse resolution is never consulted → no 409.
    const updated = await service.replace(SPEC_ID, ["labels", "audit"], OPERATOR);

    expect(updated.analysisExclusions).toEqual(["labels", "audit"]);
    expect(store.auditLog).toEqual([]);
  });
});
