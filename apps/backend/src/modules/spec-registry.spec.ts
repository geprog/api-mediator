import type { RegisteredApp } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeUnitOfWork, InMemoryStore } from "../testing/fake-persistence.testkit.js";
import { providerSpecDocument } from "../testing/sample-specs.testkit.js";
import { SpecRegistry, UnknownAppError } from "./spec-registry.js";

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
