import type {
  AdapterBinding,
  AdapterEndpoint,
  ApiSpec,
  ApprovedMapping,
  RecordLink,
  RegisteredApp,
  ScopeCorrespondence,
  ScopeLink,
  SyncFieldState,
} from "@mediator/domain";
import { resolveRequest } from "@mediator/adapter-engine";
import { beforeEach, describe, expect, it } from "vitest";

import { BadRequestError, ConflictError, NotFoundError } from "../app-errors.js";
import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { APP_LIFECYCLE_AUDIT_PREFIX, AppLifecycleService } from "./app-lifecycle.js";

/**
 * **AL-2 / AL-3 unit tests — the deregister cascade**, over the in-memory
 * {@link FakeUnitOfWork} (the same `TxStores` seam AL-1 runs on). They run in the default
 * `pnpm test` / `pnpm verify` pass, so every branch of the cascade — the confirmation
 * gate, each archival/deletion step, the binding-less-endpoint revert, the consumer
 * tear-down, the counterpart clearing, the graph removal, the audit summary — is covered
 * without a database. The live-Postgres wiring is proven separately in
 * `app-deregister.integration.spec.ts`.
 *
 * Every fake mirrors its real repository's guards (only `active` rows archive, the
 * endpoint delete cascades its bindings, `markAdapterEndpointCompositionRequired` moves
 * only an `active` endpoint), so a passing test here reflects real persistence semantics
 * rather than a permissive double.
 */

const APP = "app-gitea";
const APP_NAME = "Gitea";
const PEER = "app-jira";
const CONSUMER = "app-portal";
const OTHER = "app-bystander";
const OPERATOR = "operator@example.test";
const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("AppLifecycleService.deregister (AL-2)", () => {
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

  // ── seeding helpers (each mirrors one table) ───────────────────────────────

  function seedApp(id: string, name: string, status: RegisteredApp["status"] = "active"): void {
    store.apps.set(id, {
      id,
      name,
      status,
      baseUrl: `https://${id}.example`,
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60_000,
      },
      createdAt: NOW,
    });
  }

  function seedSpec(
    id: string,
    appId: string,
    status: ApiSpec["status"] = "active",
    role: ApiSpec["role"] = "PROVIDER",
  ): void {
    store.specs.set(id, {
      id,
      appId,
      role,
      rawDocument: {},
      parsedIR: [],
      analysisExclusions: [],
      version: 1,
      contentHash: `hash-${id}`,
      status,
      createdAt: NOW,
    });
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

  function seedRule(id: string, approvedMappingId: string): void {
    store.syncRules.set(id, {
      id,
      approvedMappingId,
      resourcePairRef: `${APP}:issues|${PEER}:issues`,
      status: "enabled",
      backfillStatus: "completed",
      cursor: "cursor-42",
    });
  }

  function seedEndpoint(
    id: string,
    consumerAppId: string,
    status: AdapterEndpoint["status"] = "active",
  ): void {
    store.adapterEndpoints.set(id, {
      id,
      consumerAppId,
      consumerOperationId: `con-issues/${id}`,
      status,
    });
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

  function seedRecordLink(
    id: string,
    appAId: string,
    appBId: string,
    status: RecordLink["status"] = "active",
  ): void {
    const link: RecordLink = {
      id,
      appAId,
      appANativeId: `${id}-a`,
      appBId,
      appBNativeId: `${id}-b`,
      resourcePairRef: `${appAId}:issues|${appBId}:issues`,
      establishedBy: "identity-match",
      status,
      ...(status === "tombstoned" ? { tombstoneReason: "observed-delete" as const } : {}),
      establishingQueueKey: { kind: "both-native-id-queues" },
      createdAt: NOW,
      tombstonedAt: status === "tombstoned" ? NOW : null,
    };
    store.recordLinks.set(id, link);
  }

  function seedFieldState(
    id: string,
    recordLinkId: string,
    status: SyncFieldState["status"] = "active",
  ): void {
    const state: SyncFieldState = {
      id,
      recordLinkId,
      side: "A",
      fieldPath: "title",
      observedHash: "hash-title",
      observedAt: NOW,
      observedChangeTimestamp: null,
      status,
    };
    store.syncFieldStates.set(id, state);
  }

  function seedCorrespondence(id: string, resourcePairRef: string): void {
    const correspondence: ScopeCorrespondence = {
      id,
      resourcePairRef,
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "projects/name" }],
      targetContainerRef: { appId: PEER, resourceRef: "projects" },
      confirmedBy: null,
      confirmedAt: null,
    };
    store.scopeCorrespondences.set(resourcePairRef, correspondence);
  }

  function seedScopeLink(
    id: string,
    scopeCorrespondenceId: string,
    status: ScopeLink["status"] = "active",
  ): void {
    const link: ScopeLink = {
      id,
      scopeCorrespondenceId,
      appAId: APP,
      appAScopeKey: { owner: "acme" },
      appBId: PEER,
      appBScopeKey: { owner: "acme" },
      resourcePairRef: `${APP}:issues|${PEER}:issues`,
      establishedBy: "identity-match",
      status,
      createdAt: NOW,
    };
    store.scopeLinks.set(id, link);
  }

  /** The whole landscape one deregistration has to unwind. */
  function seedLandscape(): void {
    seedApp(APP, APP_NAME);
    seedApp(PEER, "Jira");
    seedApp(CONSUMER, "Portal");
    seedApp(OTHER, "Bystander");

    seedSpec("spec-gitea", APP);
    seedSpec("spec-gitea-consumer", APP, "active", "CONSUMER");
    seedSpec("spec-jira", PEER);

    // A bidirectional peer pair (two mappings, cross-linked as counterparts) + a
    // consumer-provider mapping where the app is the backend.
    seedMapping({ id: "pp-1", sourceAppId: APP, targetAppId: PEER, counterpartMappingId: "pp-2" });
    seedMapping({ id: "pp-2", sourceAppId: PEER, targetAppId: APP, counterpartMappingId: "pp-1" });
    seedMapping({
      id: "cp-1",
      variant: "consumer-provider",
      sourceAppId: CONSUMER,
      targetAppId: APP,
    });
    seedRule("rule-1", "pp-1");
    seedRule("rule-2", "pp-2");

    // The app's own consumer surface (torn down) + another consumer's endpoints, one of
    // which the app is the ONLY backend of (reverts) and one it shares (keeps serving).
    seedEndpoint("ep-own", APP);
    seedEndpoint("ep-solo", CONSUMER);
    seedEndpoint("ep-shared", CONSUMER);
    seedBinding("b-own", PEER, "ep-own");
    seedBinding("b-solo", APP, "ep-solo");
    seedBinding("b-shared-app", APP, "ep-shared");
    seedBinding("b-shared-other", OTHER, "ep-shared");

    seedRecordLink("link-1", APP, PEER);
    seedRecordLink("link-2", PEER, APP);
    seedRecordLink("link-3", PEER, OTHER);
    seedFieldState("fs-1", "link-1");
    seedFieldState("fs-2", "link-2");
    seedFieldState("fs-3", "link-3");

    seedCorrespondence("corr-1", `${APP}:issues|${PEER}:issues`);
    seedCorrespondence("corr-2", `${OTHER}:issues|${PEER}:issues`);
    seedScopeLink("sl-1", "corr-1");
    seedScopeLink("sl-2", "corr-2");

    store.credentials.push(
      { appId: APP, type: "apiKey", scopeCount: 0 },
      { appId: APP, type: "adapterToken", scopeCount: 0 },
      { appId: PEER, type: "apiKey", scopeCount: 0 },
    );
  }

  // ── AL-2.1 the confirmation gate ───────────────────────────────────────────

  describe("explicit confirmation (AL-2.1)", () => {
    it("rejects an empty confirmation and writes NOTHING — a bare request cannot deregister", async () => {
      seedLandscape();

      await expect(service.deregister(APP, OPERATOR, "")).rejects.toBeInstanceOf(BadRequestError);

      // Not one row of the cascade moved, and nothing was audited.
      expect(store.syncRules.size).toBe(2);
      expect(store.adapterEndpoints.size).toBe(3);
      expect(store.adapterBindings).toHaveLength(4);
      expect(store.approvedMappings.get("pp-1")?.status).toBe("active");
      expect(store.credentials).toHaveLength(3);
      expect(store.auditLog).toHaveLength(0);
      expect(cacheDrops).toHaveLength(0);
    });

    it("rejects a confirmation that is not the app's exact name (another app's name included)", async () => {
      seedLandscape();

      await expect(service.deregister(APP, OPERATOR, "gitea")).rejects.toThrow(
        /requires confirmation/i,
      );
      await expect(service.deregister(APP, OPERATOR, "Jira")).rejects.toBeInstanceOf(
        BadRequestError,
      );
      expect(store.auditLog).toHaveLength(0);
      expect(store.credentials).toHaveLength(3);
    });

    it("proceeds on the app's exact name", async () => {
      seedLandscape();

      const result = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(result.app.id).toBe(APP);
      expect(store.auditLog).toHaveLength(1);
    });

    it("404s an unknown app before the confirmation is even considered", async () => {
      await expect(service.deregister("app-missing", OPERATOR, "anything")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(store.auditLog).toHaveLength(0);
    });
  });

  // ── AL-2.2 rules + bindings deleted; binding-less endpoints revert ──────────

  describe("rules and bindings are deleted (AL-2.2)", () => {
    it("deletes every SyncRule of every mapping naming the app, on either side", async () => {
      seedLandscape();
      // A rule of a mapping that does NOT involve the app: untouched.
      seedMapping({ id: "pp-other", sourceAppId: PEER, targetAppId: OTHER });
      seedRule("rule-other", "pp-other");

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.syncRulesDeleted).toBe(2);
      expect(store.syncRules.has("rule-1")).toBe(false);
      expect(store.syncRules.has("rule-2")).toBe(false);
      expect(store.syncRules.has("rule-other")).toBe(true);
    });

    it("deletes the bindings the app BACKS and leaves other backends' bindings alone", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      // `b-own` went with the torn-down endpoint (cascade), not counted as backed.
      expect(summary.adapterBindingsDeleted).toBe(2);
      expect(store.adapterBindings.map((binding) => binding.id)).toEqual(["b-shared-other"]);
    });

    it("reverts an endpoint left with NO bindings, and leaves a still-bound one serving", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterEndpointsLeftWithoutBindings).toBe(1);
      // `ep-solo` lost its only binding → composition-required, and with no active
      // binding the RT-3 rule answers `not-yet-mapped` (the endpoint row still exists).
      expect(store.adapterEndpoints.get("ep-solo")?.status).toBe("composition-required");
      // `ep-shared` still has the other backend's binding → untouched, still serving.
      expect(store.adapterEndpoints.get("ep-shared")?.status).toBe("active");
    });

    it("leaves a DISABLED binding-less endpoint disabled — it answers endpoint-disabled, not not-yet-mapped", async () => {
      seedApp(APP, APP_NAME);
      seedApp(CONSUMER, "Portal");
      seedEndpoint("ep-off", CONSUMER, "disabled");
      seedBinding("b-off", APP, "ep-off");

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      // The count is "lost its last backend", NOT "now answers not-yet-mapped": an
      // operator's deliberate `disabled` is not overwritten by the guarded CO-1.3 move,
      // and `resolveRequest` checks `endpoint-disabled` FIRST (RT-3.2 before RT-3.1), so
      // this endpoint keeps answering `endpoint-disabled`. Naming the count after the
      // cascade effect rather than the answer keeps the audit row honest.
      expect(summary.adapterEndpointsLeftWithoutBindings).toBe(1);
      expect(store.adapterEndpoints.get("ep-off")?.status).toBe("disabled");
      expect(
        resolveRequest({ endpoint: store.adapterEndpoints.get("ep-off"), bindings: [] }),
      ).toEqual({ kind: "endpoint-disabled", endpointId: "ep-off" });
    });

    it("an ACTIVE binding-less endpoint really does answer not-yet-mapped afterwards", async () => {
      seedLandscape();

      await service.deregister(APP, OPERATOR, APP_NAME);

      expect(
        resolveRequest({ endpoint: store.adapterEndpoints.get("ep-solo"), bindings: [] }),
      ).toEqual({ kind: "not-yet-mapped", endpointId: "ep-solo" });
    });
  });

  // ── AL-2.2 — the cross-backend chain (AD-6.3's self-FK has no delete action) ──

  describe("a cross-backend fanout-merge chain (AD-6.3)", () => {
    /**
     * The shape that made the app **undeletable** before the fix: endpoint `E` under
     * `fanout-merge` with `B1` backed by the departing app and a SURVIVING `B2` backed by
     * another app that `dependsOnBindingId = B1` and reads `B1`'s response through
     * `chainInputs`. Chaining is same-endpoint but **not** same-backend, so a bare
     * `DELETE … WHERE backend_app_id = $1` aborts on
     * `adapter_binding_depends_on_same_endpoint_fk`.
     */
    function seedChain(): void {
      seedApp(APP, APP_NAME);
      seedApp(CONSUMER, "Portal");
      seedApp(OTHER, "Bystander");
      seedEndpoint("ep-chained", CONSUMER);
      seedBinding("b-upstream", APP, "ep-chained");
      const downstream: AdapterBinding = {
        id: "b-downstream",
        adapterEndpointId: "ep-chained",
        backendAppId: OTHER,
        backendOperationId: "issues/getIssue",
        approvedMappingId: "cp-1",
        role: "supplement",
        status: "active",
        executionOrder: 1,
        dependsOnBindingId: "b-upstream",
        chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "issues/getIssue#issueId" }],
      };
      store.adapterBindings.push(downstream);
    }

    it("deregisters successfully instead of aborting on the self-FK", async () => {
      seedChain();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterBindingsDeleted).toBe(1);
      expect(store.adapterBindings.map((binding) => binding.id)).toEqual(["b-downstream"]);
    });

    it("unchains the SURVIVOR: dependsOnBindingId and chainInputs are cleared together", async () => {
      seedChain();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterBindingsUnchained).toBe(1);
      const survivor = store.adapterBindings[0];
      // Both cleared, and cleared to an ABSENT key (how the mapper reads the NULL
      // columns) — a survivor keeping `chainInputs` would read a response that no
      // longer has a producer.
      expect(survivor?.dependsOnBindingId).toBeUndefined();
      expect(survivor?.chainInputs).toBeUndefined();
      // Everything else about the survivor is untouched — it still serves.
      expect(survivor).toMatchObject({ id: "b-downstream", status: "active", role: "supplement" });
    });

    it("flags the survivor's endpoint composition-required — it must not serve a broken chain", async () => {
      seedChain();

      await service.deregister(APP, OPERATOR, APP_NAME);

      expect(store.adapterEndpoints.get("ep-chained")?.status).toBe("composition-required");
    });

    it("counts nothing unchained when the departing app backs BOTH ends of the chain", async () => {
      seedChain();
      // Re-back the downstream with the departing app: both rows go in one statement, so
      // there is no survivor to detach and nothing to report as a broken composition.
      const downstream = store.adapterBindings.find((binding) => binding.id === "b-downstream");
      if (downstream === undefined) throw new Error("expected the downstream binding");
      store.adapterBindings[store.adapterBindings.indexOf(downstream)] = {
        ...downstream,
        backendAppId: APP,
      };

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterBindingsDeleted).toBe(2);
      expect(summary.adapterBindingsUnchained).toBe(0);
      expect(store.adapterBindings).toHaveLength(0);
      // The endpoint lost every binding, so it reverts rather than being flagged twice.
      expect(summary.adapterEndpointsLeftWithoutBindings).toBe(1);
      expect(store.adapterEndpoints.get("ep-chained")?.status).toBe("composition-required");
    });

    it("leaves NO surviving binding pointing at a deleted one — the invariant the self-FK enforces", async () => {
      seedChain();
      // A second chain, so the sweep is exercised over more than one survivor.
      store.adapterBindings.push({
        id: "b-downstream-2",
        adapterEndpointId: "ep-chained",
        backendAppId: OTHER,
        backendOperationId: "issues/listIssues",
        approvedMappingId: "cp-1",
        role: "supplement",
        status: "active",
        executionOrder: 1,
        dependsOnBindingId: "b-upstream",
        chainInputs: [{ upstreamFieldPath: "id", targetParamRef: "issues/getIssue#issueId" }],
      });

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterBindingsUnchained).toBe(2);
      const surviving = new Set(store.adapterBindings.map((binding) => binding.id));
      for (const binding of store.adapterBindings) {
        // The FK's invariant, checked directly: every chain reference still resolves.
        if (binding.dependsOnBindingId !== undefined) {
          expect(surviving.has(binding.dependsOnBindingId)).toBe(true);
        }
      }
      expect(store.adapterBindings.every((b) => b.dependsOnBindingId === undefined)).toBe(true);
    });
  });

  // ── AL-2.3 the consumer surface is torn down (callers hit NOTHING) ──────────

  describe("a CONSUMER app's adapter surface is torn down (AL-2.3)", () => {
    it("deletes the app's own endpoints AND their bindings — the surface stops being served entirely", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.adapterEndpointsTornDown).toBe(1);
      // The distinction this test exists to pin: a torn-down surface leaves NO endpoint
      // row, so `resolveRequest` never even sees a state to answer `not-yet-mapped` from
      // — the caller hits nothing (RT-4.3). A reverted endpoint (above) is the opposite:
      // its row survives and answers `not-yet-mapped`.
      expect(store.adapterEndpoints.has("ep-own")).toBe(false);
      expect(store.adapterEndpoints.has("ep-solo")).toBe(true);
      // Its bindings went with it, even the one backed by a DIFFERENT (surviving) app.
      expect(store.adapterBindings.some((binding) => binding.adapterEndpointId === "ep-own")).toBe(
        false,
      );
      // ...and the app's CONSUMER spec is archived, so nothing re-mounts it either.
      expect(store.specs.get("spec-gitea-consumer")?.status).toBe("archived");
    });

    it("revokes the adapter token with the app: its adapterToken credential is deleted (AT-4.5)", async () => {
      seedLandscape();

      await service.deregister(APP, OPERATOR, APP_NAME);

      expect(store.credentials.some((entry) => entry.appId === APP)).toBe(false);
    });
  });

  // ── AL-2.4 mappings + specs archived; counterparts cleared ─────────────────

  describe("mappings and specs are archived (AL-2.4)", () => {
    it("archives every mapping naming the app, in any prior status, and leaves others alone", async () => {
      seedLandscape();
      store.approvedMappings.set("pp-1", {
        ...(store.approvedMappings.get("pp-1") as ApprovedMapping),
        status: "stale",
      });
      seedMapping({ id: "pp-other", sourceAppId: PEER, targetAppId: OTHER });

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.approvedMappingsArchived).toBe(3);
      expect(store.approvedMappings.get("pp-1")?.status).toBe("archived");
      expect(store.approvedMappings.get("pp-2")?.status).toBe("archived");
      expect(store.approvedMappings.get("cp-1")?.status).toBe("archived");
      expect(store.approvedMappings.get("pp-other")?.status).toBe("active");
      // Retained, not deleted: the rows are still readable history.
      expect(store.approvedMappings.size).toBe(4);
    });

    it("clears counterpart links POINTING AT archived rows, including a survivor's", async () => {
      seedApp(APP, APP_NAME);
      seedApp(PEER, "Jira");
      // Only the A→B direction names the app; the B→A survivor points at it.
      seedMapping({ id: "pp-1", sourceAppId: APP, targetAppId: PEER });
      const survivor = seedMapping({
        id: "pp-survivor",
        sourceAppId: PEER,
        targetAppId: PEER,
        counterpartMappingId: "pp-1",
      });
      expect(survivor.counterpartMappingId).toBe("pp-1");

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.counterpartLinksCleared).toBe(1);
      // A cleared counterpart is an ABSENT key, matching how the mapper reads a NULL
      // column back — never a stored `null`.
      expect(store.approvedMappings.get("pp-survivor")?.counterpartMappingId).toBeUndefined();
      // The archived row keeps its own column — it is history, not a live link.
      expect(store.approvedMappings.get("pp-1")?.status).toBe("archived");
    });

    it("archives the app's specs (they stay resolvable — archived mappings still pin them)", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.apiSpecsArchived).toBe(2);
      expect(store.specs.get("spec-gitea")?.status).toBe("archived");
      expect(store.specs.get("spec-gitea-consumer")?.status).toBe("archived");
      expect(store.specs.get("spec-jira")?.status).toBe("active");
      expect(store.specs.size).toBe(3);
    });
  });

  // ── AL-2.5 links + field state archived, NEVER tombstoned ──────────────────

  describe("linked sync state is archived, not tombstoned (AL-2.5)", () => {
    it("archives the app's RecordLinks with no tombstone marker, on either side", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.recordLinksArchived).toBe(2);
      for (const id of ["link-1", "link-2"]) {
        const link = store.recordLinks.get(id);
        expect(link?.status).toBe("archived");
        // The whole point of AL-2.5: no record was deleted, so this is NOT a tombstone.
        expect(link?.tombstoneReason).toBeUndefined();
        expect(link?.tombstonedAt).toBeNull();
      }
      expect(store.recordLinks.get("link-3")?.status).toBe("active");
    });

    it("leaves an already-tombstoned link tombstoned (its severing fact is the specific one)", async () => {
      seedApp(APP, APP_NAME);
      seedApp(PEER, "Jira");
      seedRecordLink("link-dead", APP, PEER, "tombstoned");
      seedFieldState("fs-dead", "link-dead");

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.recordLinksArchived).toBe(0);
      expect(store.recordLinks.get("link-dead")?.status).toBe("tombstoned");
      // Its per-side state still leaves the live set — a tombstoned link can carry
      // `active` field state, and that must not survive the app.
      expect(summary.syncFieldStatesArchived).toBe(1);
      expect(store.syncFieldStates.get("fs-dead")?.status).toBe("archived");
    });

    it("archives the SyncFieldState of the app's links only", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.syncFieldStatesArchived).toBe(2);
      expect(store.syncFieldStates.get("fs-1")?.status).toBe("archived");
      expect(store.syncFieldStates.get("fs-2")?.status).toBe("archived");
      expect(store.syncFieldStates.get("fs-3")?.status).toBe("active");
    });

    it("archives the ScopeLinks of every scoped pair the app is a side of (SS-10.5)", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.scopeLinksArchived).toBe(1);
      expect(store.scopeLinks.get("sl-1")?.status).toBe("archived");
      expect(store.scopeLinks.get("sl-2")?.status).toBe("active");
      // The correspondence CONFIG row is retained (it carries no status of its own and
      // the archived links still resolve through it for audit).
      expect(store.scopeCorrespondences.size).toBe(2);
    });
  });

  // ── AL-2.6 credentials deleted outright ────────────────────────────────────

  describe("credentials are deleted outright (AL-2.6)", () => {
    it("removes EVERY credential of the app from the store and keeps every other app's", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(summary.credentialsDeleted).toBe(2);
      // Gone, not flagged: nothing of the app is left in the credential store.
      expect(store.credentials).toEqual([{ appId: PEER, type: "apiKey", scopeCount: 0 }]);
    });

    it("keeps the audit log — deregistration deletes secrets, never history", async () => {
      seedLandscape();
      store.auditLog.push({
        id: "historic-1",
        type: "credential-access",
        actor: "system",
        originAppId: APP,
        timestamp: NOW,
      });

      await service.deregister(APP, OPERATOR, APP_NAME);

      expect(store.auditLog.map((entry) => entry.id)).toEqual(["historic-1", "audit-1"]);
    });
  });

  // ── AL-2.7 graph + caches ──────────────────────────────────────────────────

  describe("graph removal and cache drops (AL-2.7)", () => {
    it("recomputes every incident edge AFTER the rules/bindings are gone, so each is removed", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      // Three distinct (pair, type) edges: A→B sync, B→A sync, consumer→A adapter.
      expect(summary.graphEdgesRecomputed).toBe(3);
      expect(store.graphRecomputes).toStrictEqual([
        { type: "adapter-dependency", sourceAppId: CONSUMER, targetAppId: APP },
        { type: "sync", sourceAppId: APP, targetAppId: PEER },
        { type: "sync", sourceAppId: PEER, targetAppId: APP },
      ]);
      // The aggregate each recompute reads is empty by then — that is what removes the
      // edge (GR-1.2). Proven here by the state the recompute would see.
      expect(store.syncRules.size).toBe(0);
      expect(
        store.adapterBindings.filter(
          (binding) => binding.backendAppId === APP || binding.adapterEndpointId === "ep-own",
        ),
      ).toHaveLength(0);
    });

    it("drops the cache of the app's own (torn-down) endpoints AND every endpoint it backed", async () => {
      seedLandscape();

      const { summary } = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(cacheDrops).toStrictEqual(["ep-own", "ep-solo", "ep-shared"]);
      expect(summary.endpointCachesDropped).toBe(3);
    });

    it("a throwing cache invalidator never fails the committed cascade", async () => {
      seedLandscape();
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

      await expect(throwing.deregister(APP, OPERATOR, APP_NAME)).resolves.toMatchObject({
        app: { id: APP },
      });
      expect(store.credentials.some((entry) => entry.appId === APP)).toBe(false);
    });
  });

  // ── the app row itself ─────────────────────────────────────────────────────

  describe("the RegisteredApp row", () => {
    it("is RETAINED and moved out of service — the archived specs/mappings still reference it", async () => {
      seedLandscape();

      const result = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(result.app.status).toBe("disabled");
      expect(store.apps.get(APP)?.status).toBe("disabled");
      // Retained on purpose: `api_spec.app_id` / `approved_mapping.*_app_id` are NOT
      // NULL foreign keys, so deleting the row would delete the very audit history
      // AL-2.4/AL-2.5 retain.
      expect(store.apps.has(APP)).toBe(true);
    });

    it("deregisters an already-disabled app without re-running the compare-and-set", async () => {
      seedApp(APP, APP_NAME, "disabled");
      store.credentials.push({ appId: APP, type: "apiKey", scopeCount: 0 });

      const result = await service.deregister(APP, OPERATOR, APP_NAME);

      expect(result.app.status).toBe("disabled");
      expect(result.summary.credentialsDeleted).toBe(1);
    });

    it("AL-3: cannot be re-enabled afterwards — a departed app is not a disabled one", async () => {
      seedLandscape();

      await service.deregister(APP, OPERATOR, APP_NAME);

      // The row is `disabled` like an AL-1 disable, but ALL of its specs are archived,
      // which is what identifies a deregistered app until a durable marker exists.
      await expect(service.enable(APP, OPERATOR)).rejects.toBeInstanceOf(ConflictError);
      await expect(service.enable(APP, OPERATOR)).rejects.toThrow(
        /was deregistered .* cannot be re-enabled/,
      );
      expect(store.apps.get(APP)?.status).toBe("disabled");
      // Nothing of the cascade was undone by the attempt.
      expect(store.specs.get("spec-gitea")?.status).toBe("archived");
      expect(store.approvedMappings.get("pp-1")?.status).toBe("archived");
    });

    it("an ordinary AL-1 disable is still re-enabled — the guard reads specs, not the status", async () => {
      seedLandscape();

      await service.disable(APP, OPERATOR);
      const reEnabled = await service.enable(APP, OPERATOR);

      // A disabled app keeps its `active` specs (a disable archives nothing), so the
      // AL-3 guard does not fire and AL-1.3 is untouched.
      expect(reEnabled.status).toBe("active");
    });

    it("an app with NO specs at all is still enableable — that is not the deregistered state", async () => {
      // "Found no active spec" and "every spec is archived" are different facts; only the
      // second is a deregistration. A spec-less row must not be trapped `disabled`.
      seedApp(APP, APP_NAME, "disabled");

      await expect(service.enable(APP, OPERATOR)).resolves.toMatchObject({ status: "active" });
    });
  });

  // ── AL-2.8 audit attribution + cascade summary ─────────────────────────────

  describe("audit attribution with the cascade summary (AL-2.8 / OA-3)", () => {
    it("attributes the deregistration to the authenticated operator and records the summary", async () => {
      seedLandscape();

      await service.deregister(APP, OPERATOR, APP_NAME);

      expect(store.auditLog).toHaveLength(1);
      const entry = store.auditLog[0];
      expect(entry).toMatchObject({
        id: "audit-1",
        type: "mapping-decision",
        actor: OPERATOR,
        originAppId: APP,
        timestamp: NOW,
      });
      expect(entry?.actor).not.toBe("system");
      expect(entry?.decision).toBeUndefined();
      expect(entry?.details).toContain(APP_LIFECYCLE_AUDIT_PREFIX);
      expect(entry?.details).toContain("deregistered by operator");
      // The cascade summary is in the row, as counts.
      expect(entry?.details).toContain("syncRulesDeleted=2");
      expect(entry?.details).toContain("credentialsDeleted=2");
      expect(entry?.details).toContain("recordLinksArchived=2");
      expect(entry?.details).toContain("graphEdgesRecomputed=3");
    });

    it("carries no landscape detail: no app name, no base URL, no ids", async () => {
      seedLandscape();

      await service.deregister(APP, OPERATOR, APP_NAME);

      const details = store.auditLog[0]?.details ?? "";
      expect(details).not.toContain("https://");
      expect(details).not.toContain(APP_NAME);
      expect(details).not.toContain("link-1");
    });
  });

  // ── atomicity ──────────────────────────────────────────────────────────────

  it("a cascade that throws rolls the WHOLE transaction back and drops no cache", async () => {
    seedLandscape();
    const failing = new AppLifecycleService({
      unitOfWork: {
        run: (work) =>
          new FakeUnitOfWork(store).run(async (tx) => {
            const result = await work(tx);
            // Fail AFTER the cascade wrote everything — the rollback must undo it all.
            throw Object.assign(new Error("simulated failure after the cascade"), { result });
          }),
      },
      newId: () => "audit-x",
      clock: () => NOW,
      readTraceContext: () => null,
      cacheInvalidator: {
        invalidateEndpoint: (endpointId) => {
          cacheDrops.push(endpointId);
        },
      },
    });

    await expect(failing.deregister(APP, OPERATOR, APP_NAME)).rejects.toThrow(/simulated failure/);

    expect(store.syncRules.size).toBe(2);
    expect(store.adapterEndpoints.size).toBe(3);
    expect(store.adapterBindings).toHaveLength(4);
    expect(store.approvedMappings.get("pp-1")?.status).toBe("active");
    expect(store.recordLinks.get("link-1")?.status).toBe("active");
    expect(store.scopeLinks.get("sl-1")?.status).toBe("active");
    expect(store.credentials).toHaveLength(3);
    expect(store.apps.get(APP)?.status).toBe("active");
    expect(store.auditLog).toHaveLength(0);
    expect(cacheDrops).toHaveLength(0);
  });
});

/**
 * **AL-3 — re-registration is a NEW `RegisteredApp` (no state resurrection).** The
 * guarantee is mostly structural: every live query is scoped by **app id** (and the
 * canonical `resourcePairRef` embeds the app id too), and the prior registration's rows
 * are `archived`, which the live lookups filter out. These tests pin both halves over the
 * fakes; the wired path is proven again against Postgres in the integration spec.
 */
describe("re-registration after a deregistration (AL-3)", () => {
  let store: InMemoryStore;
  let service: AppLifecycleService;

  beforeEach(() => {
    store = new InMemoryStore();
    service = new AppLifecycleService({
      unitOfWork: new FakeUnitOfWork(store),
      newId: () => "audit-1",
      clock: () => NOW,
      readTraceContext: () => null,
    });
  });

  function seedApp(id: string, name: string): void {
    store.apps.set(id, {
      id,
      name,
      status: "active",
      baseUrl: "https://gitea.example",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60_000,
      },
      createdAt: NOW,
    });
  }

  it("AL-3.1/3.3: the prior registration's rows stay archived and are never adopted by the new app", async () => {
    // The FIRST registration of "Gitea", with real linked state.
    const first = "app-gitea-v1";
    seedApp(first, APP_NAME);
    seedApp(PEER, "Jira");
    store.specs.set("spec-v1", {
      id: "spec-v1",
      appId: first,
      role: "PROVIDER",
      rawDocument: {},
      parsedIR: [],
      analysisExclusions: [],
      version: 1,
      contentHash: "hash-v1",
      status: "active",
      createdAt: NOW,
    });
    store.approvedMappings.set("pp-v1", {
      id: "pp-v1",
      sourceSpecId: "spec-v1",
      targetSpecId: "spec-peer",
      sourceAppId: first,
      targetAppId: PEER,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: NOW,
      status: "active",
    });
    store.recordLinks.set("link-v1", {
      id: "link-v1",
      appAId: first,
      appANativeId: "1",
      appBId: PEER,
      appBNativeId: "JIRA-1",
      resourcePairRef: `${first}:issues|${PEER}:issues`,
      establishedBy: "identity-match",
      status: "active",
      establishingQueueKey: { kind: "both-native-id-queues" },
      createdAt: NOW,
      tombstonedAt: null,
    });
    store.syncFieldStates.set("fs-v1", {
      id: "fs-v1",
      recordLinkId: "link-v1",
      side: "A",
      fieldPath: "title",
      observedHash: "hash-title",
      observedAt: NOW,
      observedChangeTimestamp: null,
      status: "active",
    });
    store.credentials.push({ appId: first, type: "apiKey", scopeCount: 0 });

    await service.deregister(first, OPERATOR, APP_NAME);

    // The SAME system registers again — a NEW `RegisteredApp` with a new id, same name
    // and same base URL (nothing about registration keys on either).
    const second = "app-gitea-v2";
    seedApp(second, APP_NAME);

    // AL-3.1 — nothing of the prior registration belongs to the new app.
    expect(second).not.toBe(first);
    expect([...store.specs.values()].filter((spec) => spec.appId === second)).toHaveLength(0);
    expect(
      [...store.approvedMappings.values()].filter(
        (mapping) => mapping.sourceAppId === second || mapping.targetAppId === second,
      ),
    ).toHaveLength(0);
    expect(
      [...store.recordLinks.values()].filter(
        (link) => link.appAId === second || link.appBId === second,
      ),
    ).toHaveLength(0);
    expect(store.credentials.filter((entry) => entry.appId === second)).toHaveLength(0);

    // AL-3.3 — the prior rows are still there, and still archived: history, never live.
    expect(store.specs.get("spec-v1")?.status).toBe("archived");
    expect(store.approvedMappings.get("pp-v1")?.status).toBe("archived");
    expect(store.recordLinks.get("link-v1")?.status).toBe("archived");
    expect(store.syncFieldStates.get("fs-v1")?.status).toBe("archived");
    // The credential is not "archived" — it is gone.
    expect(store.credentials.some((entry) => entry.appId === first)).toBe(false);

    // AL-3.1 — the structural guarantee behind all of the above: the canonical
    // `resourcePairRef` embeds the app id, so the new app's pair can never name the old
    // app's links even if a status filter were ever dropped.
    const priorPairRef = store.recordLinks.get("link-v1")?.resourcePairRef ?? "";
    expect(priorPairRef).toContain(first);
    expect(priorPairRef).not.toContain(second);
  });

  it("AL-3.4: the audit log retains register → deregister → re-register, keyed by app id", async () => {
    const first = "app-gitea-v1";
    const second = "app-gitea-v2";
    seedApp(first, APP_NAME);
    store.auditLog.push({
      id: "registered-v1",
      type: "mapping-decision",
      actor: OPERATOR,
      originAppId: first,
      details: "registered",
      timestamp: NOW,
    });

    await service.deregister(first, OPERATOR, APP_NAME);

    seedApp(second, APP_NAME);
    store.auditLog.push({
      id: "registered-v2",
      type: "mapping-decision",
      actor: OPERATOR,
      originAppId: second,
      details: "registered",
      timestamp: NOW,
    });

    // The full sequence survives, and each event is attributable to the registration it
    // belongs to by `originAppId` — the two registrations never merge into one history.
    expect(store.auditLog.map((entry) => [entry.id, entry.originAppId])).toEqual([
      ["registered-v1", first],
      ["audit-1", first],
      ["registered-v2", second],
    ]);
  });
});
