import type { AdapterBinding, ApiSpec, ApprovedMapping, Ir } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "../app-errors.js";
import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { ApprovedMappingSuspensionService } from "./approved-mapping-suspension.js";

/**
 * **SL-10 unit tests — the suspend / resume transition logic**, over the in-memory
 * {@link FakeUnitOfWork} (the same `TxStores` seam the Spec Registry's own unit tests use).
 * These run in the default `pnpm test` / `pnpm verify` pass, so the conflict branching, the
 * resume pin catch-up, the audit attribution, and the coupled graph/cache wiring are all
 * covered without a database.
 *
 * The fake repositories mirror the real ones exactly — the compare-and-set guards on
 * `markSuspended`/`markActive` and the `approved_mapping_active_direction_uq` partial-unique
 * index resume re-claims (raising a pg-shaped `23505`) — so a test that passes here reflects
 * real persistence semantics rather than a permissive double.
 */

const PROVIDER_APP = "app-provider";
const PEER_APP = "app-peer";
const CONSUMER_APP = "app-consumer";
const OPERATOR = "operator@example.test";
const NOW = new Date("2026-07-23T12:00:00.000Z");

/** A one-resource IR: `issues` with `id` + `title` of the given type. */
function issuesIr(titleType: "string" | "integer", extraField?: string): Ir {
  return [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [
        {
          name: "Issue",
          fields: [
            { name: "id", type: "integer", required: true },
            { name: "title", type: titleType, required: false },
            ...(extraField !== undefined
              ? [{ name: extraField, type: "string", required: false }]
              : []),
          ],
        },
      ],
      crossResourceRefs: [],
    },
  ];
}

function specOf(
  id: string,
  appId: string,
  parsedIR: Ir,
  status: ApiSpec["status"],
  version: number,
): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR,
    analysisExclusions: [],
    version,
    contentHash: `sha256:${id}`,
    status,
    createdAt: NOW,
  };
}

describe("ApprovedMappingSuspensionService (SL-10)", () => {
  let store: InMemoryStore;
  let service: ApprovedMappingSuspensionService;
  let cacheDrops: string[];
  let idCounter: number;

  beforeEach(() => {
    store = new InMemoryStore();
    cacheDrops = [];
    idCounter = 0;
    service = new ApprovedMappingSuspensionService({
      unitOfWork: new FakeUnitOfWork(store),
      newId: () => `audit-${String(++idCounter)}`,
      clock: () => NOW,
      readTraceContext: () => null,
      cacheInvalidator: {
        invalidateEndpoint: (endpointId) => {
          cacheDrops.push(endpointId);
        },
      },
    });
  });

  /** A peer-peer mapping pinned to `sourceSpecId`, plus a `issues/title` field ref. */
  function seedPeerMapping(
    overrides: Partial<ApprovedMapping> & Pick<ApprovedMapping, "id" | "sourceSpecId">,
  ): ApprovedMapping {
    const mapping: ApprovedMapping = {
      targetSpecId: "peer-spec",
      sourceAppId: PROVIDER_APP,
      targetAppId: PEER_APP,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: NOW,
      status: "active",
      ...overrides,
    };
    store.approvedMappings.set(mapping.id, mapping);
    store.fieldMappings.push({
      id: `${mapping.id}-fm`,
      mappingId: mapping.id,
      sourcePath: "issues/title",
      targetPath: "issues/title",
      transform: "rename",
    });
    return mapping;
  }

  /** The peer spec both sides of the fixtures point at (always active, never advanced). */
  function seedPeerSpec(): void {
    store.specs.set("peer-spec", specOf("peer-spec", PEER_APP, issuesIr("string"), "active", 1));
  }

  // ── SL-10.1 suspend ────────────────────────────────────────────────────────

  describe("suspend", () => {
    beforeEach(() => {
      seedPeerSpec();
      store.specs.set("v1", specOf("v1", PROVIDER_APP, issuesIr("string"), "active", 1));
    });

    it("moves an active mapping to suspended and leaves every other column untouched", async () => {
      const mapping = seedPeerMapping({ id: "m1", sourceSpecId: "v1" });

      const result = await service.suspend("m1", OPERATOR);

      expect(result.status).toBe("suspended");
      expect(store.approvedMappings.get("m1")?.status).toBe("suspended");
      // Only `status` moved — the pins, counterpart and approval columns are byte-identical.
      expect(result.sourceSpecId).toBe(mapping.sourceSpecId);
      expect(result.targetSpecId).toBe(mapping.targetSpecId);
      expect(result.approvedBy).toBe(mapping.approvedBy);
    });

    it("attributes the suspend to the authenticated operator (OA-3)", async () => {
      seedPeerMapping({ id: "m1", sourceSpecId: "v1" });

      await service.suspend("m1", OPERATOR);

      expect(store.auditLog).toHaveLength(1);
      expect(store.auditLog[0]?.actor).toBe(OPERATOR);
      expect(store.auditLog[0]?.type).toBe("mapping-decision");
      expect(store.auditLog[0]?.relatedMappingId).toBe("m1");
      expect(store.auditLog[0]?.details).toContain("suspended");
      // A `mapping-decision` row leaves `status` unset and coins no `decision` value.
      expect(store.auditLog[0]?.status).toBeUndefined();
      expect(store.auditLog[0]?.decision).toBeUndefined();
    });

    it("recomputes the peer-peer sync edge and drops no cache (no adapter bindings)", async () => {
      seedPeerMapping({ id: "m1", sourceSpecId: "v1" });

      await service.suspend("m1", OPERATOR);

      expect(store.graphRecomputes).toEqual([
        { type: "sync", sourceAppId: PROVIDER_APP, targetAppId: PEER_APP },
      ]);
      expect(cacheDrops).toEqual([]);
    });

    it("recomputes the adapter edge and drops each bound endpoint's cache once", async () => {
      const mapping: ApprovedMapping = {
        id: "mc",
        sourceSpecId: "consumer-spec",
        targetSpecId: "v1",
        sourceAppId: CONSUMER_APP,
        targetAppId: PROVIDER_APP,
        variant: "consumer-provider",
        approvedBy: "reviewer:alice",
        approvedAt: NOW,
        status: "active",
      };
      store.approvedMappings.set(mapping.id, mapping);
      const binding = (id: string, endpointId: string): AdapterBinding => ({
        id,
        adapterEndpointId: endpointId,
        backendAppId: PROVIDER_APP,
        backendOperationId: "issues/listIssues",
        approvedMappingId: "mc",
        role: "primary",
        status: "active",
      });
      // Two bindings on the SAME endpoint → the drop is de-duplicated.
      store.adapterBindings.push(binding("b1", "e1"), binding("b2", "e1"), binding("b3", "e2"));

      await service.suspend("mc", OPERATOR);

      expect(store.graphRecomputes).toEqual([
        { type: "adapter-dependency", sourceAppId: CONSUMER_APP, targetAppId: PROVIDER_APP },
      ]);
      expect(cacheDrops).toEqual(["e1", "e2"]);
    });

    it.each<ApprovedMapping["status"]>(["suspended", "stale", "superseded", "archived"])(
      "refuses to suspend a %s mapping (never clobbers a more-blocking status)",
      async (status) => {
        seedPeerMapping({ id: "m1", sourceSpecId: "v1", status });

        await expect(service.suspend("m1", OPERATOR)).rejects.toBeInstanceOf(ConflictError);
        expect(store.approvedMappings.get("m1")?.status).toBe(status);
        // Nothing was written — the transaction rolled back.
        expect(store.auditLog).toEqual([]);
        expect(store.graphRecomputes).toEqual([]);
      },
    );

    it("404s an unknown mapping without writing anything", async () => {
      await expect(service.suspend("nope", OPERATOR)).rejects.toBeInstanceOf(NotFoundError);
      expect(store.auditLog).toEqual([]);
    });
  });

  // ── SL-10.2 resume (no advance during the hold) ────────────────────────────

  describe("resume", () => {
    beforeEach(() => {
      seedPeerSpec();
      store.specs.set("v1", specOf("v1", PROVIDER_APP, issuesIr("string"), "active", 1));
    });

    it("moves a suspended mapping back to active under its stored state", async () => {
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      const result = await service.resume("m1", OPERATOR);

      expect(result.status).toBe("active");
      expect(store.approvedMappings.get("m1")?.status).toBe("active");
      // The pins are unchanged — nothing advanced, so there is nothing to catch up.
      expect(result.sourceSpecId).toBe("v1");
      expect(store.auditLog).toHaveLength(1);
      expect(store.auditLog[0]?.actor).toBe(OPERATOR);
      expect(store.auditLog[0]?.details).toContain("resumed");
    });

    it("recomputes the edge and drops the cache on resume too (SL-10.4, both directions)", async () => {
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await service.resume("m1", OPERATOR);

      expect(store.graphRecomputes).toEqual([
        { type: "sync", sourceAppId: PROVIDER_APP, targetAppId: PEER_APP },
      ]);
    });

    it.each<ApprovedMapping["status"]>(["active", "superseded", "archived"])(
      "refuses to resume a %s mapping",
      async (status) => {
        seedPeerMapping({ id: "m1", sourceSpecId: "v1", status });

        await expect(service.resume("m1", OPERATOR)).rejects.toBeInstanceOf(ConflictError);
        expect(store.approvedMappings.get("m1")?.status).toBe(status);
        expect(store.auditLog).toEqual([]);
      },
    );

    it("refuses to resume a stale mapping and says re-review is required (SL-10.5)", async () => {
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "stale" });

      await expect(service.resume("m1", OPERATOR)).rejects.toThrow(/re-review/i);
      expect(store.approvedMappings.get("m1")?.status).toBe("stale");
    });
  });

  // ── SL-10.2 the pin catch-up: a hold DEFERS the lifecycle, never exempts it ──

  describe("resume pin catch-up", () => {
    beforeEach(() => {
      seedPeerSpec();
    });

    /** v1 superseded + v2 active on the provider lineage, with the given v2 IR. */
    function seedAdvancedLineage(v2Ir: Ir): void {
      store.specs.set("v1", specOf("v1", PROVIDER_APP, issuesIr("string"), "superseded", 1));
      store.specs.set("v2", specOf("v2", PROVIDER_APP, v2Ir, "active", 2));
    }

    it("re-pins to the current active version when the hold spanned an ADDITIVE advance", async () => {
      // v2 adds an optional field — additive, so nothing the mapping references broke.
      seedAdvancedLineage(issuesIr("string", "assignee"));
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      const result = await service.resume("m1", OPERATOR);

      expect(result.status).toBe("active");
      // The load-bearing assertion: never `active` while pinned to a superseded version.
      expect(result.sourceSpecId).toBe("v2");
      expect(store.approvedMappings.get("m1")?.sourceSpecId).toBe("v2");
      // The untouched counterpart side is carried forward unchanged.
      expect(result.targetSpecId).toBe("peer-spec");
      // SL-2's re-pin audit row is written alongside the operator's resume row.
      const details = store.auditLog.map((row) => row.details ?? "");
      expect(details.some((detail) => detail.includes("re-pinned"))).toBe(true);
      expect(details.some((detail) => detail.includes("resumed"))).toBe(true);
    });

    it("stales + rejects when the hold spanned a BREAKING advance touching its refs", async () => {
      // `issues.title` retyped → breaking, and the mapping maps exactly that field.
      seedAdvancedLineage(issuesIr("integer"));
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await expect(service.resume("m1", OPERATOR)).rejects.toBeInstanceOf(ConflictError);

      // The stale mark COMMITTED even though the resume was refused.
      expect(store.approvedMappings.get("m1")?.status).toBe("stale");
      // SL-4.3 — a stale mapping stays pinned to the version it was reviewed against.
      expect(store.approvedMappings.get("m1")?.sourceSpecId).toBe("v1");
    });

    it("records the SL-6 scoped re-review job for the mapping staled at resume time", async () => {
      seedAdvancedLineage(issuesIr("integer"));
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await expect(service.resume("m1", OPERATOR)).rejects.toThrow(ConflictError);

      expect(store.scopedDetectionJobs).toHaveLength(1);
      const job = store.scopedDetectionJobs[0];
      // Recorded against the CURRENT active version (the successor is proposed against it).
      expect(job?.apiSpecId).toBe("v2");
      if (job?.scope.kind !== "re-review") throw new Error("expected a re-review scope");
      expect(job.scope.supersededSpecId).toBe("v1");
      expect(job.scope.staleMappings.map((entry) => entry.staleMappingId)).toEqual(["m1"]);
      expect(job.scope.staleMappings[0]?.affectedPairs).toEqual([
        { sourceResource: "issues", targetResource: "issues" },
      ]);
    });

    it("still reacts (graph + cache) for the stale transition a rejected resume caused", async () => {
      seedAdvancedLineage(issuesIr("integer"));
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await expect(service.resume("m1", OPERATOR)).rejects.toThrow(ConflictError);

      // The mapping really did change state, so the projection must reflect it.
      expect(store.graphRecomputes).toEqual([
        { type: "sync", sourceAppId: PROVIDER_APP, targetAppId: PEER_APP },
      ]);
    });

    it("attributes the rejected resume to the operator alongside the system stale row", async () => {
      seedAdvancedLineage(issuesIr("integer"));
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await expect(service.resume("m1", OPERATOR)).rejects.toThrow(ConflictError);

      const actors = store.auditLog.map((row) => row.actor);
      expect(actors).toContain(OPERATOR); // the operator's resume attempt (OA-3)
      expect(actors).toContain("system"); // SL-4's stale row
    });

    it("re-pins (not stales) when the advance was breaking but touched nothing it maps", async () => {
      // A breaking change in a DIFFERENT resource: `labels` is removed outright.
      store.specs.set(
        "v1",
        specOf(
          "v1",
          PROVIDER_APP,
          [
            ...issuesIr("string"),
            {
              resourceRef: "labels",
              name: "Labels",
              operations: [],
              schemas: [
                { name: "Label", fields: [{ name: "id", type: "integer", required: true }] },
              ],
              crossResourceRefs: [],
            },
          ],
          "superseded",
          1,
        ),
      );
      store.specs.set("v2", specOf("v2", PROVIDER_APP, issuesIr("string"), "active", 2));
      // The mapping only references `issues/title`, which is untouched.
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      const result = await service.resume("m1", OPERATOR);

      // SL-4.1's precision, applied at resume time: only a mapping that references a changed
      // element goes stale, so this one advances exactly as the additive case.
      expect(result.status).toBe("active");
      expect(result.sourceSpecId).toBe("v2");
      expect(store.scopedDetectionJobs).toEqual([]);
    });

    it("refuses when the pinned lineage has no active version at all", async () => {
      store.specs.set("v1", specOf("v1", PROVIDER_APP, issuesIr("string"), "superseded", 1));
      // No active provider spec exists (the app was deregistered / its spec withdrawn).
      seedPeerMapping({ id: "m1", sourceSpecId: "v1", status: "suspended" });

      await expect(service.resume("m1", OPERATOR)).rejects.toThrow(/no active version/i);
      expect(store.approvedMappings.get("m1")?.status).toBe("suspended");
    });
  });

  // ── SL-10.2 the single `active` slot per directional spec pair ─────────────

  describe("resume vs. the active-direction unique index", () => {
    beforeEach(() => {
      seedPeerSpec();
      store.specs.set("v1", specOf("v1", PROVIDER_APP, issuesIr("string"), "active", 1));
    });

    it("reports a 409 when another mapping already holds the pair's active slot", async () => {
      seedPeerMapping({ id: "held", sourceSpecId: "v1", status: "suspended" });
      // A later approval took the slot while this one was suspended: the approval service's
      // update-in-place keys on the ACTIVE mapping, finds none, and inserts a new row.
      seedPeerMapping({ id: "incumbent", sourceSpecId: "v1", status: "active" });

      await expect(service.resume("held", OPERATOR)).rejects.toBeInstanceOf(ConflictError);
      await expect(service.resume("held", OPERATOR)).rejects.toThrow(/already the active mapping/i);

      // Nothing changed on either mapping.
      expect(store.approvedMappings.get("held")?.status).toBe("suspended");
      expect(store.approvedMappings.get("incumbent")?.status).toBe("active");
      expect(store.auditLog).toEqual([]);
    });

    it("maps a raced unique violation (23505) to a 409 rather than an unhandled 500", async () => {
      seedPeerMapping({ id: "held", sourceSpecId: "v1", status: "suspended" });
      seedPeerMapping({ id: "racer", sourceSpecId: "v1", status: "active" });

      // The race the pre-check structurally cannot close: hide the incumbent from the
      // pre-check EXACTLY once (the first `values()` scan), so the guard passes and the
      // WRITE is what hits `approved_mapping_active_direction_uq`. The fake raises the same
      // pg-shaped `23505` the real partial-unique index would, so this exercises the
      // production error-detection path rather than a test-only sentinel.
      const realValues = store.approvedMappings.values.bind(store.approvedMappings);
      let hiddenFromPrecheck = false;
      store.approvedMappings.values = (): MapIterator<ApprovedMapping> => {
        const all = [...realValues()];
        const visible = hiddenFromPrecheck ? all : all.filter((mapping) => mapping.id !== "racer");
        hiddenFromPrecheck = true;
        // A real `Map`'s iterator, so the override matches the `Map.values` signature.
        return new Map(visible.map((mapping) => [mapping.id, mapping])).values();
      };

      // ONE invocation — the hide is one-shot, so a second call would take the pre-check
      // branch instead and prove nothing.
      let error: unknown;
      try {
        await service.resume("held", OPERATOR);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ConflictError);
      // The message proves it took the UNIQUE-VIOLATION branch, not the pre-check branch.
      expect(error instanceof Error ? error.message : "").toMatch(/concurrently became/i);
      expect(store.approvedMappings.get("held")?.status).toBe("suspended");
    });
  });
});
