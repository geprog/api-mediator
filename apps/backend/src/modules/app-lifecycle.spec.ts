import type { AdapterBinding, ApprovedMapping, RegisteredApp } from "@mediator/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { ConflictError, NotFoundError } from "../app-errors.js";
import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { APP_LIFECYCLE_AUDIT_PREFIX, AppLifecycleService } from "./app-lifecycle.js";

/**
 * **AL-1 unit tests — the disable / re-enable transition logic**, over the in-memory
 * {@link FakeUnitOfWork} (the same `TxStores` seam the Spec Registry and the SL-10
 * suspension service use). These run in the default `pnpm test` / `pnpm verify` pass, so
 * the conflict branching, the operator attribution, the "writes nothing but the status"
 * invariant, and the coupled graph/cache wiring are covered without a database.
 *
 * The fake `RegisteredApp` repo mirrors the real one exactly — the compare-and-set guards
 * on `markDisabled`/`markActive` — so a test that passes here reflects real persistence
 * semantics rather than a permissive double.
 */

const APP = "app-gitea";
const PEER = "app-jira";
const CONSUMER = "app-portal";
const OPERATOR = "operator@example.test";
const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("AppLifecycleService (AL-1)", () => {
  let store: InMemoryStore;
  let service: AppLifecycleService;
  let cacheDrops: string[];
  let idCounter: number;

  beforeEach(() => {
    store = new InMemoryStore();
    cacheDrops = [];
    idCounter = 0;
    service = new AppLifecycleService({
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

  function seedApp(id: string, status: RegisteredApp["status"] = "active"): RegisteredApp {
    const app: RegisteredApp = {
      id,
      name: id,
      status,
      baseUrl: `https://${id}.example`,
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60_000,
      },
      createdAt: NOW,
    };
    store.apps.set(id, app);
    return app;
  }

  function seedMapping(
    overrides: Partial<ApprovedMapping> & Pick<ApprovedMapping, "id">,
  ): ApprovedMapping {
    const mapping: ApprovedMapping = {
      sourceSpecId: `${overrides.id}-source-spec`,
      targetSpecId: `${overrides.id}-target-spec`,
      sourceAppId: APP,
      targetAppId: PEER,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: NOW,
      status: "active",
      ...overrides,
    };
    store.approvedMappings.set(mapping.id, mapping);
    return mapping;
  }

  function seedBinding(id: string, backendAppId: string, adapterEndpointId: string): void {
    const binding: AdapterBinding = {
      id,
      adapterEndpointId,
      backendAppId,
      backendOperationId: "issues/getIssue",
      approvedMappingId: "cp-1",
      role: "primary",
      status: "active",
    };
    store.adapterBindings.push(binding);
  }

  // ── AL-1.1 disable ─────────────────────────────────────────────────────────

  describe("disable", () => {
    it("moves an active app to disabled and leaves every other column untouched", async () => {
      const before = seedApp(APP);

      const result = await service.disable(APP, OPERATOR);

      expect(result.status).toBe("disabled");
      expect(store.apps.get(APP)?.status).toBe("disabled");
      expect(store.apps.get(APP)).toStrictEqual({ ...before, status: "disabled" });
    });

    it("AL-1.1: writes NO rule state — no status, no cursor, no snapshot, no backfillStatus", async () => {
      seedApp(APP);
      seedApp(PEER);
      seedMapping({ id: "pp-1" });
      store.syncRules.set("rule-1", {
        id: "rule-1",
        approvedMappingId: "pp-1",
        resourcePairRef: "pair::issues",
        status: "enabled",
        backfillStatus: "completed",
        cursor: "cursor-42",
        lastSnapshotRef: "snapshot-7",
      });
      const ruleBefore = store.syncRules.get("rule-1");

      await service.disable(APP, OPERATOR);

      // The pause is derived at execution time by the poll gate — the rule row is
      // byte-identical, so re-enabling restores nothing and re-backfills nothing.
      expect(store.syncRules.get("rule-1")).toStrictEqual(ruleBefore);
    });

    it("AL-1.1: leaves the mappings and the bindings the app participates in untouched", async () => {
      seedApp(APP);
      seedApp(PEER);
      const mapping = seedMapping({ id: "pp-1" });
      seedBinding("binding-1", APP, "endpoint-1");
      const bindingBefore = { ...store.adapterBindings[0] };

      await service.disable(APP, OPERATOR);

      expect(store.approvedMappings.get("pp-1")).toStrictEqual(mapping);
      expect(store.adapterBindings[0]).toStrictEqual(bindingBefore);
    });

    it("rejects an unknown app with 404 and persists nothing", async () => {
      await expect(service.disable("app-missing", OPERATOR)).rejects.toBeInstanceOf(NotFoundError);
      expect(store.auditLog).toHaveLength(0);
    });

    it("rejects disabling an already-disabled app with 409 (the compare-and-set never clobbers)", async () => {
      seedApp(APP, "disabled");

      await expect(service.disable(APP, OPERATOR)).rejects.toThrow(
        `RegisteredApp ${APP} is disabled; only an active app can be disabled.`,
      );
      await expect(service.disable(APP, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
      expect(store.auditLog).toHaveLength(0);
      expect(store.graphRecomputes).toHaveLength(0);
      expect(cacheDrops).toHaveLength(0);
    });
  });

  // ── AL-1.3 re-enable ───────────────────────────────────────────────────────

  describe("enable", () => {
    it("moves a disabled app back to active, restoring nothing else", async () => {
      const before = seedApp(APP, "disabled");
      seedApp(PEER);
      seedMapping({ id: "pp-1" });
      store.syncRules.set("rule-1", {
        id: "rule-1",
        approvedMappingId: "pp-1",
        resourcePairRef: "pair::issues",
        status: "enabled",
        backfillStatus: "completed",
        cursor: "cursor-42",
        lastSnapshotRef: "snapshot-7",
      });
      const ruleBefore = store.syncRules.get("rule-1");

      const result = await service.enable(APP, OPERATOR);

      expect(result.status).toBe("active");
      expect(store.apps.get(APP)).toStrictEqual({ ...before, status: "active" });
      // AL-1.3 — no re-backfill, no cursor reset: the rule resumes from stored state.
      expect(store.syncRules.get("rule-1")).toStrictEqual(ruleBefore);
      expect(store.syncRules.get("rule-1")?.cursor).toBe("cursor-42");
      expect(store.syncRules.get("rule-1")?.backfillStatus).toBe("completed");
    });

    it("rejects re-enabling an already-active app with 409", async () => {
      seedApp(APP, "active");

      await expect(service.enable(APP, OPERATOR)).rejects.toThrow(
        `RegisteredApp ${APP} is active; only a disabled app can be re-enabled.`,
      );
      expect(store.auditLog).toHaveLength(0);
    });

    it("rejects an unknown app with 404", async () => {
      await expect(service.enable("app-missing", OPERATOR)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  // ── AL-1.4 audit attribution ───────────────────────────────────────────────

  describe("audit attribution (AL-1.4 / OA-3)", () => {
    it("attributes each transition to the authenticated operator, naming the app", async () => {
      seedApp(APP);

      await service.disable(APP, OPERATOR);
      await service.enable(APP, "operator@second.test");

      expect(store.auditLog).toHaveLength(2);
      expect(store.auditLog[0]).toMatchObject({
        id: "audit-1",
        type: "mapping-decision",
        actor: OPERATOR,
        originAppId: APP,
        timestamp: NOW,
      });
      expect(store.auditLog[0]?.details).toContain(APP_LIFECYCLE_AUDIT_PREFIX);
      expect(store.auditLog[0]?.details).toContain("disabled by operator");
      expect(store.auditLog[1]).toMatchObject({
        actor: "operator@second.test",
        originAppId: APP,
      });
      expect(store.auditLog[1]?.details).toContain("re-enabled by operator");
      // Never `system`, and never a review decision.
      expect(store.auditLog.map((entry) => entry.actor)).not.toContain("system");
      expect(store.auditLog.every((entry) => entry.decision === undefined)).toBe(true);
    });

    it("carries no secret: the audit details never leak the app's base URL", async () => {
      seedApp(APP);
      await service.disable(APP, OPERATOR);
      expect(store.auditLog[0]?.details).not.toContain("https://");
    });
  });

  // ── AL-1.5 coupled reactions ───────────────────────────────────────────────

  describe("coupled reactions (AL-1.5)", () => {
    it("recomputes every edge incident to the app — both directions and both types — once each", async () => {
      seedApp(APP);
      seedApp(PEER);
      seedApp(CONSUMER);
      // Two peer-peer mappings in opposite directions (two distinct sync edges) plus a
      // second rule-pair mapping over the same pair (one edge — recomputed once).
      seedMapping({ id: "pp-1", sourceAppId: APP, targetAppId: PEER });
      seedMapping({ id: "pp-2", sourceAppId: APP, targetAppId: PEER });
      seedMapping({ id: "pp-3", sourceAppId: PEER, targetAppId: APP });
      // A consumer-provider mapping where the app is the backend → the adapter edge.
      seedMapping({
        id: "cp-1",
        variant: "consumer-provider",
        sourceAppId: CONSUMER,
        targetAppId: APP,
      });

      await service.disable(APP, OPERATOR);

      expect(store.graphRecomputes).toStrictEqual([
        { type: "adapter-dependency", sourceAppId: CONSUMER, targetAppId: APP },
        { type: "sync", sourceAppId: APP, targetAppId: PEER },
        { type: "sync", sourceAppId: PEER, targetAppId: APP },
      ]);
    });

    it("recomputes edges of mappings in ANY status (a stale member still shapes its edge)", async () => {
      seedApp(APP);
      seedApp(PEER);
      seedMapping({ id: "pp-1", status: "stale" });

      await service.disable(APP, OPERATOR);

      expect(store.graphRecomputes).toStrictEqual([
        { type: "sync", sourceAppId: APP, targetAppId: PEER },
      ]);
    });

    it("GR-5.4: the app itself is never removed — disable leaves the node in place", async () => {
      seedApp(APP);
      seedApp(PEER);
      seedMapping({ id: "pp-1" });

      await service.disable(APP, OPERATOR);

      expect(store.apps.has(APP)).toBe(true);
      expect(store.apps.get(APP)?.status).toBe("disabled");
    });

    it("XI-2.2: drops the cache of every endpoint the app BACKS, distinctly, after commit", async () => {
      seedApp(APP);
      // Two bindings of the disabled app on the same endpoint + one on another.
      seedBinding("b-1", APP, "endpoint-1");
      seedBinding("b-2", APP, "endpoint-1");
      seedBinding("b-3", APP, "endpoint-2");
      // A binding backed by a DIFFERENT app: untouched by this app's disable.
      seedBinding("b-4", PEER, "endpoint-3");

      await service.disable(APP, OPERATOR);

      expect(cacheDrops).toStrictEqual(["endpoint-1", "endpoint-2"]);
    });

    it("XI-2.5: a throwing cache invalidator never fails the committed transition", async () => {
      seedApp(APP);
      seedBinding("b-1", APP, "endpoint-1");
      store.failCacheInvalidation = true;
      const throwing = new AppLifecycleService({
        unitOfWork: new FakeUnitOfWork(store),
        newId: () => "audit-x",
        clock: () => NOW,
        readTraceContext: () => null,
        cacheInvalidator: {
          invalidateEndpoint: (): void => {
            throw new Error("simulated cache-drop failure");
          },
        },
      });

      await expect(throwing.disable(APP, OPERATOR)).resolves.toMatchObject({ status: "disabled" });
      expect(store.apps.get(APP)?.status).toBe("disabled");
    });

    it("a failed transition rolls back the whole transaction and drops no cache", async () => {
      seedApp(APP, "disabled");
      seedBinding("b-1", APP, "endpoint-1");

      await expect(service.disable(APP, OPERATOR)).rejects.toBeInstanceOf(ConflictError);

      expect(store.apps.get(APP)?.status).toBe("disabled");
      expect(store.auditLog).toHaveLength(0);
      expect(store.graphRecomputes).toHaveLength(0);
      expect(cacheDrops).toHaveLength(0);
    });
  });
});
