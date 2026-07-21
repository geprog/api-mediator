import type { UpdateResourceBindingRequest } from "@mediator/contracts";
import type { ResourceBindingRefPatch } from "@mediator/db";
import type { ApiSpec, RegisteredApp, ResourceBinding } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { ResourceBindingService } from "./resource-bindings.js";
import type { RecordAddressRepairTrigger } from "./sync/record-address-repair.js";
import type { TxStores, UnitOfWork } from "./persistence.js";

/**
 * Focused coverage for the **SS-19 trigger wiring**: confirming a `recordAddressRef`
 * fires the address-repair sweep (once, after the confirm commits, with the confirmed
 * binding + its app), while any other confirm (a different ref, a scope binding) fires
 * nothing. The sweep itself is covered by `sync/record-address-repair.spec.ts`; here the
 * trigger is a spy so this test stays about the wiring, not the enumeration.
 */

const DATE = new Date("2026-07-21T00:00:00.000Z");
const APP_ID = "app-gitea";
const SPEC_ID = "spec-gitea";
const BINDING_ID = "rb-gitea-issues";

function derivedBinding(): ResourceBinding {
  return {
    id: BINDING_ID,
    apiSpecId: SPEC_ID,
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    recordAddressRef: {
      value: { kind: "field", path: "number" },
      confirmedBy: null,
      confirmedAt: null,
    },
    scopePathBindings: [],
  };
}

function spec(): ApiSpec {
  return {
    id: SPEC_ID,
    appId: APP_ID,
    role: "PROVIDER",
    rawDocument: {},
    parsedIR: [],
    version: 1,
    contentHash: "hash",
    status: "active",
    analysisExclusions: [],
    createdAt: DATE,
  };
}

function app(): RegisteredApp {
  return {
    id: APP_ID,
    name: "gitea",
    status: "active",
    baseUrl: "https://gitea.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60_000,
    },
    createdAt: DATE,
  };
}

/** A minimal in-memory {@link UnitOfWork} whose `run` executes the real confirm closure. */
class FakeUnitOfWork implements UnitOfWork {
  public binding: ResourceBinding = derivedBinding();

  public run<T>(work: (stores: TxStores) => Promise<T>): Promise<T> {
    const stores = {
      resourceBindings: {
        getById: (id: string): Promise<ResourceBinding | undefined> =>
          Promise.resolve(id === this.binding.id ? this.binding : undefined),
        update: (
          id: string,
          patch: ResourceBindingRefPatch,
        ): Promise<ResourceBinding | undefined> => {
          if (id !== this.binding.id) {
            return Promise.resolve(undefined);
          }
          // Merge the confirm patch onto the two refs the tests confirm (recordAddressRef /
          // nativeIdRef), stamping confirmedBy/confirmedAt while retaining the ref's value.
          const next: ResourceBinding = { ...this.binding };
          const addressRef = next.recordAddressRef;
          if (patch.recordAddressRef !== undefined && addressRef !== undefined) {
            next.recordAddressRef = { ...addressRef, ...patch.recordAddressRef };
          }
          const nativeRef = next.nativeIdRef;
          if (patch.nativeIdRef !== undefined && nativeRef !== undefined) {
            next.nativeIdRef = { ...nativeRef, ...patch.nativeIdRef };
          }
          this.binding = next;
          return Promise.resolve(next);
        },
        createMany: (): Promise<ResourceBinding[]> => Promise.resolve([]),
        updateScopePathBinding: (): Promise<ResourceBinding | undefined> =>
          Promise.resolve(undefined),
        updateSourceScopeRef: (): Promise<ResourceBinding | undefined> =>
          Promise.resolve(undefined),
      },
      apiSpecs: {
        getById: (id: string): Promise<ApiSpec | undefined> =>
          Promise.resolve(id === SPEC_ID ? spec() : undefined),
        create: (s: ApiSpec): Promise<ApiSpec> => Promise.resolve(s),
        findActiveByAppAndRole: (): Promise<ApiSpec | undefined> => Promise.resolve(undefined),
        updateStatus: (): Promise<ApiSpec | undefined> => Promise.resolve(undefined),
        updateAnalysisExclusions: (): Promise<ApiSpec | undefined> => Promise.resolve(undefined),
      },
      registeredApps: {
        getById: (id: string): Promise<RegisteredApp | undefined> =>
          Promise.resolve(id === APP_ID ? app() : undefined),
        create: (a: RegisteredApp): Promise<RegisteredApp> => Promise.resolve(a),
      },
      credentialStore: { store: (): Promise<never> => Promise.reject(new Error("unused")) },
      emit: (): Promise<void> => Promise.resolve(),
    } satisfies TxStores;
    return work(stores);
  }
}

/** Records every `onRecordAddressRefConfirmed` call. */
class SpyRepairTrigger implements RecordAddressRepairTrigger {
  public readonly calls: { readonly binding: ResourceBinding; readonly appId: string }[] = [];
  public onRecordAddressRefConfirmed(binding: ResourceBinding, appId: string): Promise<void> {
    this.calls.push({ binding, appId });
    return Promise.resolve();
  }
}

describe("ResourceBindingService — SS-19 address-repair trigger", () => {
  it("fires the repair sweep once, with the confirmed binding + app, on a recordAddressRef confirm", async () => {
    const unitOfWork = new FakeUnitOfWork();
    const repair = new SpyRepairTrigger();
    const service = new ResourceBindingService({ unitOfWork, recordAddressRepair: repair });

    const request: UpdateResourceBindingRequest = { refKind: "recordAddressRef" };
    const result = await service.confirmOrCorrect(BINDING_ID, request, "operator@test");

    // The confirm stamped the ref...
    expect(result.binding.recordAddressRef?.confirmedBy).toBe("operator@test");
    // ...and the sweep fired exactly once, with that confirmed binding and its app.
    expect(repair.calls).toHaveLength(1);
    expect(repair.calls[0]?.appId).toBe(APP_ID);
    expect(repair.calls[0]?.binding.recordAddressRef?.confirmedBy).toBe("operator@test");
  });

  it("does NOT fire the sweep when a different ref is confirmed", async () => {
    const unitOfWork = new FakeUnitOfWork();
    const repair = new SpyRepairTrigger();
    const service = new ResourceBindingService({ unitOfWork, recordAddressRepair: repair });

    const request: UpdateResourceBindingRequest = { refKind: "nativeIdRef" };
    await service.confirmOrCorrect(BINDING_ID, request, "operator@test");

    expect(repair.calls).toEqual([]);
  });

  it("confirms normally when no repair trigger is wired (optional dependency)", async () => {
    const service = new ResourceBindingService({ unitOfWork: new FakeUnitOfWork() });

    const request: UpdateResourceBindingRequest = { refKind: "recordAddressRef" };
    const result = await service.confirmOrCorrect(BINDING_ID, request, "operator@test");

    expect(result.binding.recordAddressRef?.confirmedBy).toBe("operator@test");
  });
});
