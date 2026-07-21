import type { RegisteredApp } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../testing/sample-specs.testkit.js";
import { NoActiveSpecError, SpecRegistry, UnknownAppError } from "./spec-registry.js";

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
