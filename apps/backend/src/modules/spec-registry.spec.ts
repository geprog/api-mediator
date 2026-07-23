import type { SpecChange, SpecDiff } from "@mediator/ir";
import type {
  AdapterBinding,
  ApiSpec,
  ApprovedMapping,
  FieldMapping,
  Ir,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../testing/sample-specs.testkit.js";
import {
  NoActiveSpecError,
  SpecRegistry,
  UnknownAppError,
  carryForwardAnalysisExclusions,
  carryForwardResourceBinding,
  computeAdditiveAnalysisScope,
  computeBreakingAffectedKeys,
  mappingChangedSideRefs,
  mappingReferencesChangedElement,
  repinnedSpecPair,
} from "./spec-registry.js";

/**
 * Unit tests for the documented `SpecRegistry.ingestSpec` interface: it reads the
 * owning app's capabilities, parses the document, stores `ApiSpec` v1, derives
 * unconfirmed `ResourceBinding`s, and emits `SpecIngested` — all on the passed
 * transaction context.
 */
function seedApp(store: InMemoryStore, overrides: Partial<RegisteredApp> = {}): RegisteredApp {
  const app: RegisteredApp = {
    id: "app-1",
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt: new Date(),
    ...overrides,
  };
  store.apps.set(app.id, app);
  return app;
}

describe("SpecRegistry.ingestSpec", () => {
  it("stores ApiSpec v1, derives unconfirmed bindings, and emits SpecIngested", async () => {
    const store = new InMemoryStore();
    const app = seedApp(store);
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();

    const spec = await unitOfWork.run((tx) =>
      registry.ingestSpec(app.id, providerSpecDocument(), "PROVIDER", [], tx),
    );

    expect(spec.version).toBe(1);
    expect(spec.status).toBe("active");
    expect(spec.role).toBe("PROVIDER");
    expect(spec.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.specs.get(spec.id)).toBeDefined();

    // Bindings derived for the `issues` group, all unconfirmed.
    const bindings = [...store.bindings.values()].filter((b) => b.apiSpecId === spec.id);
    const issues = bindings.find((b) => b.resourceRef === "issues");
    expect(issues?.nativeIdRef?.value).toEqual({ kind: "field", path: "id" });
    expect(issues?.nativeIdRef?.confirmedBy).toBeNull();
    // supportsChangeTimestamps=true → changeTimestampRef derived.
    expect(issues?.changeTimestampRef?.value).toEqual({ kind: "field", path: "updated" });

    // Exactly one SpecIngested emitted, pointing at the stored spec.
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.type).toBe("SpecIngested");
    expect(store.events[0]).toMatchObject({ apiSpecId: spec.id, appId: app.id, role: "PROVIDER" });
  });

  it("throws UnknownAppError when the owning app does not exist", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();

    await expect(
      unitOfWork.run((tx) =>
        registry.ingestSpec("missing-app", providerSpecDocument(), "PROVIDER", [], tx),
      ),
    ).rejects.toBeInstanceOf(UnknownAppError);
    expect(store.specs.size).toBe(0);
    expect(store.events).toHaveLength(0);
  });
});

/**
 * SL-1 unit coverage of {@link SpecRegistry.ingestNewVersion}: version advance,
 * content-hash no-op, and the compute-once diff — all over the in-memory fakes.
 */

/** The sample provider doc with an extra **optional** `priority` field → additive diff. */
function providerSpecWithOptionalField(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    components: { schemas: { Issue: { properties: Record<string, unknown> } } };
  };
  doc.components.schemas.Issue.properties["priority"] = { type: "string" };
  return doc;
}

/** The sample provider doc with `title` **retyped** integer → breaking diff. */
function providerSpecWithRetypedField(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    components: { schemas: { Issue: { properties: Record<string, { type: string }> } } };
  };
  doc.components.schemas.Issue.properties["title"] = { type: "integer" };
  return doc;
}

/** The sample provider doc with a whole **new** `labels` resource group → additive diff (SL-3.1). */
function providerSpecWithNewResourceGroup(): Record<string, unknown> {
  const doc = structuredClone(providerSpecDocument()) as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  doc.paths["/labels"] = {
    get: {
      operationId: "listLabels",
      tags: ["label"],
      responses: {
        "200": {
          description: "ok",
          content: {
            "application/json": {
              schema: { type: "array", items: { $ref: "#/components/schemas/Label" } },
            },
          },
        },
      },
    },
  };
  doc.components.schemas["Label"] = {
    type: "object",
    properties: { id: { type: "integer" }, name: { type: "string" } },
    required: ["id"],
  };
  return doc;
}

describe("SpecRegistry.ingestNewVersion", () => {
  async function seedV1(store: InMemoryStore, unitOfWork: FakeUnitOfWork, registry: SpecRegistry) {
    const app = seedApp(store);
    const v1 = await unitOfWork.run((tx) =>
      registry.ingestSpec(app.id, providerSpecDocument(), "PROVIDER", [], tx),
    );
    return { app, v1 };
  }

  it("advances the lineage: stores v2 active, supersedes v1, and returns the diff", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);
    const eventsAfterV1 = store.events.length; // one SpecIngested from the v1 ingest.

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );

    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    // v2 is the new active version; v1 is superseded.
    expect(outcome.newSpec.version).toBe(2);
    expect(outcome.newSpec.status).toBe("active");
    expect(outcome.supersededSpec.id).toBe(v1.id);
    expect(outcome.supersededSpec.status).toBe("superseded");
    expect(store.specs.get(v1.id)?.status).toBe("superseded");
    // The lineage's single active version advanced to v2.
    const active = [...store.specs.values()].filter(
      (spec) => spec.appId === app.id && spec.role === "PROVIDER" && spec.status === "active",
    );
    expect(active.map((spec) => spec.id)).toEqual([outcome.newSpec.id]);

    // The additive diff was computed once: the new optional `priority` field.
    expect(outcome.diff.classification).toBe("additive");
    const added = outcome.diff.changes.filter((change) => change.kind === "field-added");
    expect(added[0]?.location).toMatchObject({ schemaName: "Issue", fieldName: "priority" });

    // No SpecIngested is emitted for a version advance (reactions read the diff instead).
    expect(store.events.length).toBe(eventsAfterV1);
  });

  it("classifies a breaking re-ingest and still advances the version", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app } = await seedV1(store, unitOfWork, registry);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithRetypedField(), "PROVIDER", tx),
    );

    expect(outcome.kind).toBe("advanced");
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    expect(outcome.diff.changes.some((change) => change.kind === "field-type-changed")).toBe(true);
  });

  it("is a no-op on an identical re-submission (SL-1.5): no new version, no diff, no event", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);
    const specsAfterV1 = store.specs.size;
    const eventsAfterV1 = store.events.length;

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecDocument(), "PROVIDER", tx),
    );

    expect(outcome.kind).toBe("unchanged");
    if (outcome.kind !== "unchanged") throw new Error("expected unchanged");
    expect(outcome.activeSpec.id).toBe(v1.id);
    expect(store.specs.size).toBe(specsAfterV1); // no new version created.
    expect(store.specs.get(v1.id)?.status).toBe("active"); // v1 stays active.
    expect(store.events.length).toBe(eventsAfterV1); // no diff/reaction event.
  });

  it("throws UnknownAppError for an unknown app", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();

    await expect(
      unitOfWork.run((tx) =>
        registry.ingestNewVersion("missing-app", providerSpecDocument(), "PROVIDER", tx),
      ),
    ).rejects.toBeInstanceOf(UnknownAppError);
  });

  it("throws NoActiveSpecError when the (app, role) lineage has no active version", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const app = seedApp(store); // app exists but no spec ingested yet.

    await expect(
      unitOfWork.run((tx) =>
        registry.ingestNewVersion(app.id, providerSpecDocument(), "PROVIDER", tx),
      ),
    ).rejects.toBeInstanceOf(NoActiveSpecError);
    expect(store.specs.size).toBe(0);
  });
});

/**
 * SL-2 — the additive reaction wired into the additive branch of `ingestNewVersion`:
 * re-pin every active mapping pinned to the superseded version, carry forward the prior
 * version's `analysisExclusions` + `ResourceBinding`s, and audit each re-pin — all
 * without changing anything that executes (never `stale`, never a content change, never
 * a touched counterpart).
 */
describe("SpecRegistry.ingestNewVersion additive reaction (SL-2)", () => {
  const COUNTERPART_APP = "app-counterpart";
  const COUNTERPART_SPEC = "spec-counterpart-v1";

  async function seedV1(
    store: InMemoryStore,
    unitOfWork: FakeUnitOfWork,
    registry: SpecRegistry,
    analysisExclusions: string[] = [],
  ): Promise<{ app: RegisteredApp; v1: ApiSpec }> {
    const app = seedApp(store);
    const v1 = await unitOfWork.run((tx) =>
      registry.ingestSpec(app.id, providerSpecDocument(), "PROVIDER", analysisExclusions, tx),
    );
    return { app, v1 };
  }

  /** An `active` peer-peer mapping seeded straight into the store. */
  function seedMapping(store: InMemoryStore, mapping: ApprovedMapping): ApprovedMapping {
    store.approvedMappings.set(mapping.id, mapping);
    return mapping;
  }

  function peerMapping(
    id: string,
    sourceSpecId: string,
    targetSpecId: string,
    counterpartMappingId: string,
  ): ApprovedMapping {
    return {
      id,
      sourceSpecId,
      targetSpecId,
      sourceAppId: "app-1",
      targetAppId: COUNTERPART_APP,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: new Date("2026-07-20T00:00:00.000Z"),
      status: "active",
      counterpartMappingId,
    };
  }

  it("re-pins every active mapping pinned to the prior version, audits each, and leaves no active mapping on the superseded row (SL-2.1/2.3)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    // A bidirectional peer pair: one direction pins v1 as source, the reverse as target.
    seedMapping(store, peerMapping("m1", v1.id, COUNTERPART_SPEC, "m2"));
    seedMapping(store, peerMapping("m2", COUNTERPART_SPEC, v1.id, "m1"));

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("additive");
    const v2Id = outcome.newSpec.id;

    // Each side advanced only on the side that pinned v1; the counterpart side is untouched.
    const m1 = store.approvedMappings.get("m1");
    const m2 = store.approvedMappings.get("m2");
    expect(m1).toMatchObject({ sourceSpecId: v2Id, targetSpecId: COUNTERPART_SPEC });
    expect(m2).toMatchObject({ sourceSpecId: COUNTERPART_SPEC, targetSpecId: v2Id });

    // SL-2.3 — no active mapping still references the now-superseded v1 row.
    const stillOnV1 = [...store.approvedMappings.values()].filter(
      (m) => m.status === "active" && (m.sourceSpecId === v1.id || m.targetSpecId === v1.id),
    );
    expect(stillOnV1).toEqual([]);

    // SL-2.1 — each re-pin is an audit-logged event (system-attributed, per mapping).
    const repins = store.auditLog.filter((entry) => entry.type === "mapping-decision");
    expect(repins).toHaveLength(2);
    expect(repins.map((entry) => entry.relatedMappingId).sort()).toEqual(["m1", "m2"]);
    for (const entry of repins) {
      expect(entry.actor).toBe("system");
      expect(entry.status).toBeUndefined(); // a mapping-decision row carries no execution status.
      expect(entry.details).toContain(v2Id);
    }
  });

  it("changes only the pinned spec version — no status/counterpart/content change, never stale (SL-2.2/2.5)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    const original = seedMapping(store, peerMapping("m1", v1.id, COUNTERPART_SPEC, "m2"));

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    // Byte-identical except the one advanced spec id: status still active (never stale),
    // counterpartMappingId undisturbed (SL-2.5), approver/variant/appIds unchanged.
    expect(store.approvedMappings.get("m1")).toEqual({
      ...original,
      sourceSpecId: outcome.newSpec.id,
    });
    expect(store.approvedMappings.get("m1")?.status).toBe("active");
    expect(store.approvedMappings.get("m1")?.counterpartMappingId).toBe("m2");
  });

  it("carries forward analysisExclusions and ResourceBindings (with confirmations) to the new version (SL-2.4)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    // v1 excludes the `issues` group and its derived binding gets an operator confirmation.
    const { app, v1 } = await seedV1(store, unitOfWork, registry, ["issues"]);
    const v1Issues = [...store.bindings.values()].find(
      (b) => b.apiSpecId === v1.id && b.resourceRef === "issues",
    );
    if (v1Issues?.nativeIdRef === undefined) throw new Error("expected a derived nativeIdRef");
    const confirmedAt = new Date("2026-07-20T12:00:00.000Z");
    store.bindings.set(v1Issues.id, {
      ...v1Issues,
      nativeIdRef: { ...v1Issues.nativeIdRef, confirmedBy: "reviewer:bob", confirmedAt },
    });

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    const v2Id = outcome.newSpec.id;

    // Exclusions carried forward (the `issues` group still resolves in the new IR).
    expect(outcome.newSpec.analysisExclusions).toEqual(["issues"]);
    expect(store.specs.get(v2Id)?.analysisExclusions).toEqual(["issues"]);

    // The binding carried forward as a fresh row on v2, confirmation intact.
    const v2Issues = [...store.bindings.values()].find(
      (b) => b.apiSpecId === v2Id && b.resourceRef === "issues",
    );
    expect(v2Issues).toBeDefined();
    expect(v2Issues?.id).not.toBe(v1Issues.id); // a new row on the new version.
    expect(v2Issues?.nativeIdRef).toEqual({
      value: v1Issues.nativeIdRef.value,
      confirmedBy: "reviewer:bob",
      confirmedAt,
    });
  });

  it("triggers nothing for an excluded group beyond carrying its exclusion forward (SL-2.6)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app } = await seedV1(store, unitOfWork, registry, ["issues"]);
    const eventsBefore = store.events.length;

    // The additive change (a new optional field) lands *inside* the excluded `issues` group.
    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    // The exclusion is preserved and nothing was triggered for it: no analysis event, and
    // (no mappings) no re-pin audit rows — the deterministic reaction never analyses.
    expect(outcome.newSpec.analysisExclusions).toEqual(["issues"]);
    expect(store.events.length).toBe(eventsBefore);
    expect(store.auditLog).toEqual([]);
  });

  it("re-pins (never stales) a mapping referencing NO changed element on a breaking advance (SL-4.1)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);
    // A mapping with NO FieldMapping/OperationMapping children references no element, so
    // even a breaking `title` retype leaves it unaffected — it advances exactly as SL-2.
    seedMapping(store, peerMapping("m1", v1.id, COUNTERPART_SPEC, "m2"));

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithRetypedField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");

    // SL-4.1 — referencing no changed element → re-pinned to v2 (active), not stale.
    expect(store.approvedMappings.get("m1")?.sourceSpecId).toBe(outcome.newSpec.id);
    expect(store.approvedMappings.get("m1")?.status).toBe("active");
    // And the re-pin is audited exactly as the additive case (SL-2).
    const repins = store.auditLog.filter((entry) => entry.type === "mapping-decision");
    expect(repins).toHaveLength(1);
    expect(repins[0]?.details).toContain("re-pinned");
  });
});

/**
 * SL-2 pure policy: the re-pin/carry-forward helpers, unit-tested directly so the
 * "drop what no longer resolves" safety net is provable without a whole additive round
 * (a real additive diff removes nothing, so the drop is otherwise unreachable).
 */
describe("SL-2 pure carry-forward / re-pin helpers", () => {
  function issuesIr(fieldNames: string[]): Ir {
    return [
      {
        resourceRef: "issues",
        name: "issues",
        operations: [
          {
            operationId: "listIssues",
            method: "get",
            path: "/issues",
            parameters: [],
            responseSchema: {
              name: "IssueList",
              fields: fieldNames.map((name) => ({ name, type: "string", required: false })),
            },
          },
        ],
        schemas: [],
        crossResourceRefs: [],
      },
    ];
  }

  it("repinnedSpecPair advances only the side pinned to the superseded version", () => {
    expect(repinnedSpecPair({ sourceSpecId: "old", targetSpecId: "b" }, "old", "new")).toEqual({
      sourceSpecId: "new",
      targetSpecId: "b",
    });
    expect(repinnedSpecPair({ sourceSpecId: "a", targetSpecId: "old" }, "old", "new")).toEqual({
      sourceSpecId: "a",
      targetSpecId: "new",
    });
    expect(repinnedSpecPair({ sourceSpecId: "a", targetSpecId: "b" }, "old", "new")).toEqual({
      sourceSpecId: "a",
      targetSpecId: "b",
    });
  });

  it("carryForwardAnalysisExclusions keeps resolving groups and drops the rest", () => {
    const ir = issuesIr(["id"]);
    expect(carryForwardAnalysisExclusions(["issues", "ghosts"], ir)).toEqual(["issues"]);
    expect(carryForwardAnalysisExclusions([], ir)).toEqual([]);
  });

  it("carryForwardResourceBinding copies a fully-resolving binding verbatim onto the new version", () => {
    const confirmedAt = new Date("2026-07-20T00:00:00.000Z");
    const prior: ResourceBinding = {
      id: "old-binding",
      apiSpecId: "old-spec",
      resourceRef: "issues",
      nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: "op", confirmedAt },
      scopePathBindings: [],
    };
    const carried = carryForwardResourceBinding(prior, "new-spec", "new-binding", issuesIr(["id"]));
    expect(carried).toEqual({
      id: "new-binding",
      apiSpecId: "new-spec",
      resourceRef: "issues",
      nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: "op", confirmedAt },
      scopePathBindings: [],
    });
  });

  it("carryForwardResourceBinding drops a ref the new IR no longer resolves", () => {
    const prior: ResourceBinding = {
      id: "old-binding",
      apiSpecId: "old-spec",
      resourceRef: "issues",
      // `id` is gone from the new representation → this ref no longer resolves.
      nativeIdRef: {
        value: { kind: "field", path: "id" },
        confirmedBy: "op",
        confirmedAt: new Date(),
      },
      collectionReadRef: {
        value: { kind: "operation", operationId: "listIssues" },
        confirmedBy: null,
        confirmedAt: null,
      },
      scopePathBindings: [],
    };
    const carried = carryForwardResourceBinding(
      prior,
      "new-spec",
      "new-binding",
      issuesIr(["title"]),
    );
    expect(carried?.nativeIdRef).toBeUndefined(); // dropped — no longer resolves.
    expect(carried?.collectionReadRef).toEqual(prior.collectionReadRef); // still resolves.
    expect(carried?.id).toBe("new-binding");
    expect(carried?.apiSpecId).toBe("new-spec");
  });

  it("carryForwardResourceBinding drops the whole binding when its resource group is gone", () => {
    const prior: ResourceBinding = {
      id: "old-binding",
      apiSpecId: "old-spec",
      resourceRef: "issues",
      scopePathBindings: [],
    };
    expect(carryForwardResourceBinding(prior, "new-spec", "new-binding", [])).toBeUndefined();
  });
});

/**
 * SL-3 — the scoped-delta trigger wired into the additive branch of `ingestNewVersion`:
 * when the additive diff added genuinely-new **in-scope** elements, the intent to run a
 * scoped delta analysis is recorded (a `mapping_detection_job` scope descriptor) in the
 * same transaction; nothing is analyzed or approved here (the worker does that later).
 */
describe("SpecRegistry.ingestNewVersion scoped-delta trigger (SL-3)", () => {
  async function seedV1(
    store: InMemoryStore,
    unitOfWork: FakeUnitOfWork,
    registry: SpecRegistry,
    analysisExclusions: string[] = [],
  ): Promise<{ app: RegisteredApp; v1: ApiSpec }> {
    const app = seedApp(store);
    const v1 = await unitOfWork.run((tx) =>
      registry.ingestSpec(app.id, providerSpecDocument(), "PROVIDER", analysisExclusions, tx),
    );
    return { app, v1 };
  }

  it("records a changed-resource scoped job when an optional field is added inside an existing resource (SL-3.2)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    expect(store.scopedDetectionJobs).toHaveLength(1);
    expect(store.scopedDetectionJobs[0]).toEqual({
      apiSpecId: outcome.newSpec.id,
      scope: {
        kind: "additive-delta",
        supersededSpecId: v1.id,
        newResourceGroups: [],
        changedResources: ["issues"],
      },
    });
  });

  it("records a new-resource-group scoped job when a whole new group is added (SL-3.1)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithNewResourceGroup(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("additive");

    expect(store.scopedDetectionJobs).toHaveLength(1);
    expect(store.scopedDetectionJobs[0]).toEqual({
      apiSpecId: outcome.newSpec.id,
      scope: {
        kind: "additive-delta",
        supersededSpecId: v1.id,
        newResourceGroups: ["labels"],
        changedResources: [],
      },
    });
  });

  it("records NO scoped job when the additive element is inside an excluded group (SL-3.4)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app } = await seedV1(store, unitOfWork, registry, ["issues"]);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    // The optional field landed inside the excluded `issues` group → nothing to analyze.
    expect(store.scopedDetectionJobs).toEqual([]);
  });

  it("records NO scoped job on a breaking advance (SL-3 is the additive path only)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app } = await seedV1(store, unitOfWork, registry);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithRetypedField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    expect(store.scopedDetectionJobs).toEqual([]);
  });

  it("leaves existing active mappings untouched while opening the delta review surface (SL-3.6)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);
    const mapping: ApprovedMapping = {
      id: "m1",
      sourceSpecId: v1.id,
      targetSpecId: "spec-counterpart-v1",
      sourceAppId: app.id,
      targetAppId: "app-counterpart",
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: new Date("2026-07-20T00:00:00.000Z"),
      status: "active",
      counterpartMappingId: "m2",
    };
    store.approvedMappings.set(mapping.id, mapping);

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, providerSpecWithOptionalField(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    // SL-3.6 — the mapping stays active (re-pinned to v2 by SL-2), never stale; the delta
    // is purely additional review surface recorded as a scoped job.
    const advanced = store.approvedMappings.get("m1");
    expect(advanced?.status).toBe("active");
    expect(advanced?.sourceSpecId).toBe(outcome.newSpec.id);
    expect(store.scopedDetectionJobs).toHaveLength(1);
  });
});

/**
 * SL-3 pure policy: the structural scope derived from an additive `SpecDiff`, unit-tested
 * directly so the two staging buckets and the exclusion filter are provable without a
 * whole ingest round.
 */
describe("computeAdditiveAnalysisScope (SL-3 structural scope)", () => {
  type SpecChange = SpecDiff["changes"][number];

  function groupAdded(resourceRef: string): SpecChange {
    return {
      kind: "resource-group-added",
      classification: "additive",
      location: { level: "resource", resourceRef },
      reason: "test",
    };
  }
  function fieldAdded(resourceRef: string): SpecChange {
    return {
      kind: "field-added",
      classification: "additive",
      location: { level: "field", resourceRef, schemaName: "S", fieldName: "f" },
      reason: "test",
    };
  }
  function diffOf(changes: readonly SpecChange[]): SpecDiff {
    return { classification: "additive", changes };
  }

  it("buckets a new resource group into newResourceGroups (SL-3.1)", () => {
    expect(computeAdditiveAnalysisScope(diffOf([groupAdded("labels")]), "v1", [])).toEqual({
      kind: "additive-delta",
      supersededSpecId: "v1",
      newResourceGroups: ["labels"],
      changedResources: [],
    });
  });

  it("buckets an additive change inside an existing resource into changedResources (SL-3.2)", () => {
    expect(computeAdditiveAnalysisScope(diffOf([fieldAdded("issues")]), "v1", [])).toEqual({
      kind: "additive-delta",
      supersededSpecId: "v1",
      newResourceGroups: [],
      changedResources: ["issues"],
    });
  });

  it("keeps a newly-added group out of changedResources even if it carries intra changes", () => {
    expect(
      computeAdditiveAnalysisScope(diffOf([groupAdded("labels"), fieldAdded("labels")]), "v1", []),
    ).toEqual({
      kind: "additive-delta",
      supersededSpecId: "v1",
      newResourceGroups: ["labels"],
      changedResources: [],
    });
  });

  it("drops excluded resources from both buckets (SL-3.4)", () => {
    expect(
      computeAdditiveAnalysisScope(diffOf([groupAdded("labels"), fieldAdded("issues")]), "v1", [
        "labels",
        "issues",
      ]),
    ).toBeUndefined();
  });

  it("returns undefined when nothing genuinely-new is in scope", () => {
    expect(computeAdditiveAnalysisScope(diffOf([]), "v1", [])).toBeUndefined();
  });
});

/**
 * SL-4 — the breaking reaction wired into the breaking branch of `ingestNewVersion`:
 * mark ONLY the mappings that reference a changed element `stale` (staying pinned to
 * their reviewed/superseded version), re-pin the rest exactly as SL-2, and — coupled —
 * recompute the affected `GraphEdge`s and drop each stale endpoint's cache.
 */
describe("SpecRegistry.ingestNewVersion breaking reaction (SL-4)", () => {
  const APP_ID = "app-1";
  const PEER_APP_B = "app-peer-b";
  const PEER_APP_C = "app-peer-c";
  const CONSUMER_APP = "app-consumer";
  const PEER_SPEC_B = "spec-peer-b";
  const PEER_SPEC_C = "spec-peer-c";
  const CONSUMER_SPEC = "spec-consumer";

  /** The sample provider doc with `title` retyped integer → a breaking `field-type-changed` in `issues`. */
  function retypedTitleDoc(): Record<string, unknown> {
    return providerSpecWithRetypedField();
  }

  async function seedV1(
    store: InMemoryStore,
    unitOfWork: FakeUnitOfWork,
    registry: SpecRegistry,
  ): Promise<{ app: RegisteredApp; v1: ApiSpec }> {
    const app = seedApp(store);
    const v1 = await unitOfWork.run((tx) =>
      registry.ingestSpec(app.id, providerSpecDocument(), "PROVIDER", [], tx),
    );
    return { app, v1 };
  }

  function peerPeer(
    id: string,
    sourceSpecId: string,
    targetSpecId: string,
    targetAppId: string,
  ): ApprovedMapping {
    return {
      id,
      sourceSpecId,
      targetSpecId,
      sourceAppId: APP_ID,
      targetAppId,
      variant: "peer-peer",
      approvedBy: "reviewer:alice",
      approvedAt: new Date("2026-07-20T00:00:00.000Z"),
      status: "active",
    };
  }

  function consumerProvider(id: string, backendSpecId: string): ApprovedMapping {
    return {
      id,
      // Consumer = source, backend/provider = target (data-model.md).
      sourceSpecId: CONSUMER_SPEC,
      targetSpecId: backendSpecId,
      sourceAppId: CONSUMER_APP,
      targetAppId: APP_ID,
      variant: "consumer-provider",
      approvedBy: "reviewer:alice",
      approvedAt: new Date("2026-07-20T00:00:00.000Z"),
      status: "active",
    };
  }

  function seedFieldMapping(
    store: InMemoryStore,
    mappingId: string,
    sourcePath: string,
    targetPath: string,
    extra: Partial<FieldMapping> = {},
  ): void {
    store.fieldMappings.push({
      id: `${mappingId}-fm-${String(store.fieldMappings.length)}`,
      mappingId,
      sourcePath,
      targetPath,
      transform: "rename",
      ...extra,
    });
  }

  function seedOperationMapping(
    store: InMemoryStore,
    mappingId: string,
    sourceOperationRef: string,
    targetOperationRef: string,
  ): void {
    store.operationMappings.push({
      id: `${mappingId}-om-${String(store.operationMappings.length)}`,
      mappingId,
      sourceOperationRef,
      targetOperationRef,
      action: "read",
    });
  }

  function seedBinding(store: InMemoryStore, mappingId: string, endpointId: string): void {
    const binding: AdapterBinding = {
      id: `${mappingId}-bind-${endpointId}`,
      adapterEndpointId: endpointId,
      backendAppId: APP_ID,
      backendOperationId: "issues/getIssue",
      approvedMappingId: mappingId,
      role: "primary",
      status: "active",
    };
    store.adapterBindings.push(binding);
  }

  it("stales ONLY the mapping referencing the changed element and re-pins the rest (SL-4.1)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    // Two peer-peer mappings pinned to v1 (different targets → distinct active spec pairs):
    // one references the changed `issues.title`, one references only an unchanged resource.
    store.approvedMappings.set("m-issues", peerPeer("m-issues", v1.id, PEER_SPEC_B, PEER_APP_B));
    seedFieldMapping(store, "m-issues", "issues/title", "issues/title");
    store.approvedMappings.set("m-labels", peerPeer("m-labels", v1.id, PEER_SPEC_C, PEER_APP_C));
    seedFieldMapping(store, "m-labels", "labels/name", "labels/name");

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, retypedTitleDoc(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");
    const v2Id = outcome.newSpec.id;

    // SL-4.1/4.3 — the issues mapping is stale AND stays pinned to the superseded v1.
    const staled = store.approvedMappings.get("m-issues");
    expect(staled?.status).toBe("stale");
    expect(staled?.sourceSpecId).toBe(v1.id);
    expect(staled?.targetSpecId).toBe(PEER_SPEC_B);

    // SL-4.1 — the labels mapping references no changed element → re-pinned to v2, active.
    const repinned = store.approvedMappings.get("m-labels");
    expect(repinned?.status).toBe("active");
    expect(repinned?.sourceSpecId).toBe(v2Id);
  });

  it("keeps the stale mapping's derived-status intent on the mapping alone and audits the transition (SL-4.2/4.5)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    store.approvedMappings.set("m-issues", peerPeer("m-issues", v1.id, PEER_SPEC_B, PEER_APP_B));
    seedFieldMapping(store, "m-issues", "issues/title", "issues/title");

    await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, retypedTitleDoc(), "PROVIDER", tx),
    );

    // The stale transition is queryable in the audit log (system-attributed, no secret).
    const staleRows = store.auditLog.filter(
      (entry) => entry.type === "mapping-decision" && entry.relatedMappingId === "m-issues",
    );
    expect(staleRows).toHaveLength(1);
    expect(staleRows[0]?.actor).toBe("system");
    expect(staleRows[0]?.status).toBeUndefined();
    expect(staleRows[0]?.details).toContain("stale");
    expect(staleRows[0]?.details).toContain(v1.id); // stays pinned to the superseded version.
  });

  it("recomputes the sync GraphEdge for a stale PROVIDER-side peer-peer mapping, not for the re-pinned one (SL-4.4/4.6)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    store.approvedMappings.set("m-issues", peerPeer("m-issues", v1.id, PEER_SPEC_B, PEER_APP_B));
    seedFieldMapping(store, "m-issues", "issues/title", "issues/title");
    store.approvedMappings.set("m-labels", peerPeer("m-labels", v1.id, PEER_SPEC_C, PEER_APP_C));
    seedFieldMapping(store, "m-labels", "labels/name", "labels/name");

    await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, retypedTitleDoc(), "PROVIDER", tx),
    );

    // Only the stale mapping's (sourceApp → targetApp) sync edge recomputes; a peer-peer
    // mapping has no adapter bindings so nothing is cache-invalidated.
    expect(store.graphRecomputes).toEqual([
      { type: "sync", sourceAppId: app.id, targetAppId: PEER_APP_B },
    ]);
    expect(store.cacheInvalidations).toEqual([]);
  });

  it("stales a CONSUMER-provider mapping backed by the changed spec, drops its endpoint cache + recomputes the adapter edge (SL-4.4/4.6)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    // A consumer-provider mapping whose BACKEND (target) spec is the changed provider v1,
    // reading `issues.title` via a response-phase field → its target ref references the change.
    store.approvedMappings.set("m-adapter", consumerProvider("m-adapter", v1.id));
    seedOperationMapping(store, "m-adapter", "con-issues/getConIssue", "issues/getIssue");
    seedFieldMapping(store, "m-adapter", "con-issues/title", "issues/title", { phase: "response" });
    seedBinding(store, "m-adapter", "endpoint-issues");

    // An unaffected consumer-provider mapping (reads only `labels`) with its own endpoint.
    store.approvedMappings.set("m-adapter-safe", consumerProvider("m-adapter-safe", v1.id));
    seedFieldMapping(store, "m-adapter-safe", "con-labels/name", "labels/name", {
      phase: "response",
    });
    seedBinding(store, "m-adapter-safe", "endpoint-labels");

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, retypedTitleDoc(), "PROVIDER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");

    // The issues-backed mapping is stale and stays pinned; the labels one re-pins to v2.
    expect(store.approvedMappings.get("m-adapter")?.status).toBe("stale");
    expect(store.approvedMappings.get("m-adapter")?.targetSpecId).toBe(v1.id);
    expect(store.approvedMappings.get("m-adapter-safe")?.status).toBe("active");
    expect(store.approvedMappings.get("m-adapter-safe")?.targetSpecId).toBe(outcome.newSpec.id);

    // XI-2 — ONLY the stale mapping's endpoint cache drops (never the unaffected endpoint).
    expect(store.cacheInvalidations).toEqual(["endpoint-issues"]);
    // GR-3 — the (consumer → backend) adapter edge recomputes for the stale mapping only.
    expect(store.graphRecomputes).toEqual([
      { type: "adapter-dependency", sourceAppId: CONSUMER_APP, targetAppId: app.id },
    ]);
    // SL-4.2 — the binding keeps its OWN status (staleness lives on the mapping alone).
    const binding = store.adapterBindings.find((b) => b.approvedMappingId === "m-adapter");
    expect(binding?.status).toBe("active");
  });

  it("never fails the transition when a cache drop throws (XI-2.5)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    const { app, v1 } = await seedV1(store, unitOfWork, registry);

    store.approvedMappings.set("m-adapter", consumerProvider("m-adapter", v1.id));
    seedFieldMapping(store, "m-adapter", "con-issues/title", "issues/title", { phase: "response" });
    seedBinding(store, "m-adapter", "endpoint-issues");
    store.failCacheInvalidation = true; // every invalidateEndpoint throws.

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(app.id, retypedTitleDoc(), "PROVIDER", tx),
    );

    // The stale transition still committed despite the cache-drop throw.
    expect(outcome.kind).toBe("advanced");
    expect(store.approvedMappings.get("m-adapter")?.status).toBe("stale");
    expect(store.cacheInvalidations).toEqual([]); // the throw prevented recording, but did not roll back.
  });

  /** A minimal CONSUMER-role doc: a `con-issues` resource whose `title` is the given type. */
  function consumerDoc(titleType: "string" | "integer"): Record<string, unknown> {
    return {
      openapi: "3.0.0",
      info: { title: "Consumer", version: "1.0.0" },
      paths: {
        "/con-issues": {
          get: {
            operationId: "listConIssues",
            tags: ["con-issue"],
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { type: "array", items: { $ref: "#/components/schemas/ConIssue" } },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          ConIssue: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: titleType },
              updated: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
    };
  }

  it("stales a consumer-provider mapping when its CONSUMER spec breaks (SL-4.4, the source-side path)", async () => {
    const store = new InMemoryStore();
    const unitOfWork = new FakeUnitOfWork(store);
    const registry = new SpecRegistry();
    seedApp(store, { id: CONSUMER_APP, name: "consumer" });
    const conV1 = await unitOfWork.run((tx) =>
      registry.ingestSpec(CONSUMER_APP, consumerDoc("string"), "CONSUMER", [], tx),
    );

    // A consumer-provider mapping whose SOURCE (consumer) spec is the one that breaks.
    const mapping: ApprovedMapping = {
      id: "m-consumer",
      sourceSpecId: conV1.id,
      targetSpecId: "backend-spec",
      sourceAppId: CONSUMER_APP,
      targetAppId: APP_ID,
      variant: "consumer-provider",
      approvedBy: "reviewer:alice",
      approvedAt: new Date("2026-07-20T00:00:00.000Z"),
      status: "active",
    };
    store.approvedMappings.set(mapping.id, mapping);
    // A request-phase field reading the consumer's `con-issues.title` → references the change.
    seedFieldMapping(store, "m-consumer", "con-issues/title", "issues/title", { phase: "request" });
    seedBinding(store, "m-consumer", "endpoint-consumer");

    const outcome = await unitOfWork.run((tx) =>
      registry.ingestNewVersion(CONSUMER_APP, consumerDoc("integer"), "CONSUMER", tx),
    );
    if (outcome.kind !== "advanced") throw new Error("expected advanced");
    expect(outcome.diff.classification).toBe("breaking");

    // SL-4.4 — the consumer's adapter mapping is stale and stays pinned to the consumer v1.
    expect(store.approvedMappings.get("m-consumer")?.status).toBe("stale");
    expect(store.approvedMappings.get("m-consumer")?.sourceSpecId).toBe(conV1.id);
    // Its adapter edge (consumer → backend) recomputes and its endpoint cache drops.
    expect(store.graphRecomputes).toEqual([
      { type: "adapter-dependency", sourceAppId: CONSUMER_APP, targetAppId: APP_ID },
    ]);
    expect(store.cacheInvalidations).toEqual(["endpoint-consumer"]);
  });
});

/**
 * SL-4 pure mark-stale matching policy — the load-bearing invariant, unit-tested directly
 * so the precision (field vs operation granularity, cross-resource, changed-side selection)
 * is provable without a whole ingest round. "Get the matching right and test it hard."
 */
describe("SL-4 pure mark-stale matching", () => {
  function change(
    kind: SpecChange["kind"],
    location: SpecChange["location"],
    classification: SpecChange["classification"] = "breaking",
  ): SpecChange {
    return { kind, classification, location, reason: "test" };
  }
  function breakingDiff(changes: readonly SpecChange[]): SpecDiff {
    return { classification: "breaking", changes };
  }

  const SUPERSEDED = "spec-old";
  const sourceMapping = { sourceSpecId: SUPERSEDED, targetSpecId: "spec-other" };
  const targetMapping = { sourceSpecId: "spec-other", targetSpecId: SUPERSEDED };

  describe("computeBreakingAffectedKeys", () => {
    it("buckets a field/schema change into fieldResources and ignores additive changes", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("field-type-changed", {
            level: "field",
            resourceRef: "issues",
            schemaName: "Issue",
            fieldName: "title",
          }),
          change("schema-removed", { level: "schema", resourceRef: "orders", schemaName: "Order" }),
          // An additive change never contributes (only breaking changes break a ref).
          change(
            "field-added",
            { level: "field", resourceRef: "labels", schemaName: "Label", fieldName: "color" },
            "additive",
          ),
        ]),
      );
      expect([...keys.fieldResources].sort()).toEqual(["issues", "orders"]);
      expect([...keys.resources]).toEqual([]);
      expect([...keys.operations]).toEqual([]);
    });

    it("buckets a resource-group removal into resources and an operation/parameter change into operations", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("resource-group-removed", { level: "resource", resourceRef: "issues" }),
          change("operation-removed", {
            level: "operation",
            resourceRef: "orders",
            operationId: "deleteOrder",
          }),
          change("parameter-removed", {
            level: "parameter",
            resourceRef: "orders",
            operationId: "getOrder",
            parameterName: "id",
            parameterLocation: "path",
          }),
        ]),
      );
      expect([...keys.resources]).toEqual(["issues"]);
      expect([...keys.operations].sort()).toEqual(["orders/deleteOrder", "orders/getOrder"]);
    });
  });

  describe("mappingChangedSideRefs — changed-side selection", () => {
    const fields: FieldMapping[] = [
      {
        id: "f1",
        mappingId: "m",
        sourcePath: "issues/title",
        targetPath: "tickets/subject",
        transform: "aggregate",
        transformConfig: { additionalInputPaths: ["issues/summary"] },
      },
    ];
    const operations: OperationMapping[] = [
      {
        id: "o1",
        mappingId: "m",
        sourceOperationRef: "issues/getIssue",
        targetOperationRef: "tickets/getTicket",
        action: "update",
        targetIdParamRef: "tickets/updateTicket#id",
      },
    ];

    it("reads the SOURCE refs (incl. additionalInputPaths) when the source pinned the superseded spec", () => {
      const refs = mappingChangedSideRefs(sourceMapping, SUPERSEDED, fields, operations);
      expect([...refs.fieldRefs].sort()).toEqual(["issues/summary", "issues/title"]);
      expect(refs.operationRefs).toEqual(["issues/getIssue"]);
      expect(refs.paramRefs).toEqual([]);
    });

    it("reads the TARGET refs (incl. targetIdParamRef) when the target pinned the superseded spec", () => {
      const refs = mappingChangedSideRefs(targetMapping, SUPERSEDED, fields, operations);
      expect(refs.fieldRefs).toEqual(["tickets/subject"]);
      expect(refs.operationRefs).toEqual(["tickets/getTicket"]);
      expect(refs.paramRefs).toEqual(["tickets/updateTicket#id"]);
    });
  });

  describe("mappingReferencesChangedElement", () => {
    it("field-level break: stales a mapping referencing that resource, not one in another resource", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("field-type-changed", {
            level: "field",
            resourceRef: "issues",
            schemaName: "Issue",
            fieldName: "title",
          }),
        ]),
      );
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["issues/title"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
      // A same-resource but different field is (conservatively) stale — resource granularity
      // for field changes: a false-stale is re-reviewable, a false-active is silent breakage.
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["issues/summary"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
      // A mapping referencing only a DIFFERENT resource is provably unaffected → not stale.
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["labels/name"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(false);
    });

    it("operation-level break: matches the EXACT operation, leaving a sibling operation and a plain field ref active", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("operation-removed", {
            level: "operation",
            resourceRef: "issues",
            operationId: "deleteIssue",
          }),
        ]),
      );
      // The mapping that maps the removed operation → stale.
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: [], operationRefs: ["issues/deleteIssue"], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
      // A mapping using a SIBLING operation of the same resource stays active (exact match).
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: [], operationRefs: ["issues/getIssue"], paramRefs: [] },
          keys,
        ),
      ).toBe(false);
      // A mapping only READING a field of that resource is unaffected by a sibling op removal.
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["issues/title"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(false);
    });

    it("parameter break matches its owning operation via a parameter ref prefix", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("parameter-type-changed", {
            level: "parameter",
            resourceRef: "issues",
            operationId: "updateIssue",
            parameterName: "id",
            parameterLocation: "path",
          }),
        ]),
      );
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: [], operationRefs: [], paramRefs: ["issues/updateIssue#id"] },
          keys,
        ),
      ).toBe(true);
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: [], operationRefs: [], paramRefs: ["issues/createIssue#id"] },
          keys,
        ),
      ).toBe(false);
    });

    it("resource-group removal breaks EVERY ref into that resource (field and operation)", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("resource-group-removed", { level: "resource", resourceRef: "issues" }),
        ]),
      );
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["issues/title"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: [], operationRefs: ["issues/listIssues"], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["labels/name"], operationRefs: ["labels/listLabels"], paramRefs: [] },
          keys,
        ),
      ).toBe(false);
    });

    it("a mapping spanning a changed and an unchanged resource is stale (references the changed one)", () => {
      const keys = computeBreakingAffectedKeys(
        breakingDiff([
          change("field-removed", {
            level: "field",
            resourceRef: "issues",
            schemaName: "Issue",
            fieldName: "title",
          }),
        ]),
      );
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["labels/name", "issues/title"], operationRefs: [], paramRefs: [] },
          keys,
        ),
      ).toBe(true);
    });

    it("no breaking change affects nothing (an empty/additive diff never stales)", () => {
      const keys = computeBreakingAffectedKeys(breakingDiff([]));
      expect(
        mappingReferencesChangedElement(
          { fieldRefs: ["issues/title"], operationRefs: ["issues/getIssue"], paramRefs: [] },
          keys,
        ),
      ).toBe(false);
    });
  });
});
