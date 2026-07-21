import type { Ir } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { MountManager } from "./mount-manager.js";
import type { AdapterStore, MountedConsumerApp, ProtocolServer } from "./ports.js";
import type { EndpointState } from "./resolution.js";

const emptyIr: Ir = [];

function app(consumerAppId: string): MountedConsumerApp {
  return { consumerAppId, ir: emptyIr };
}

/** Records every surface handed to it, so a test can assert what was mounted and when. */
class RecordingProtocolServer implements ProtocolServer {
  public readonly applied: MountedConsumerApp[][] = [];
  public setMountedSurface(apps: readonly MountedConsumerApp[]): void {
    this.applied.push([...apps]);
  }
}

/** A store whose mountable set can change between reconciles (persisted-state changes). */
class MutableStore implements AdapterStore {
  public constructor(private mountable: MountedConsumerApp[]) {}
  public setMountable(apps: MountedConsumerApp[]): void {
    this.mountable = apps;
  }
  public listMountableConsumerApps(): Promise<readonly MountedConsumerApp[]> {
    return Promise.resolve([...this.mountable]);
  }
  public loadEndpointState(): Promise<EndpointState> {
    return Promise.resolve({ endpoint: undefined, bindings: [] });
  }
}

describe("MountManager.reconcile", () => {
  it("derives the desired surface from the store and applies it (RT-4.5, re-derive from persisted state)", async () => {
    const store = new MutableStore([app("a"), app("b")]);
    const server = new RecordingProtocolServer();
    await new MountManager({ store, protocolServer: server }).reconcile();

    expect(server.applied).toHaveLength(1);
    expect(server.applied[0]?.map((each) => each.consumerAppId)).toEqual(["a", "b"]);
  });

  it("is idempotent — reconciling twice against the same state applies the same surface (RT-2.5)", async () => {
    const store = new MutableStore([app("a")]);
    const server = new RecordingProtocolServer();
    const manager = new MountManager({ store, protocolServer: server });

    await manager.reconcile();
    await manager.reconcile();

    expect(server.applied.map((surface) => surface.map((each) => each.consumerAppId))).toEqual([
      ["a"],
      ["a"],
    ]);
  });

  it("reflects a newly-mountable app on the next reconcile (RT-4.1, live ingest)", async () => {
    const store = new MutableStore([app("a")]);
    const server = new RecordingProtocolServer();
    const manager = new MountManager({ store, protocolServer: server });

    await manager.reconcile();
    store.setMountable([app("a"), app("b")]);
    await manager.reconcile();

    expect(server.applied.at(-1)?.map((each) => each.consumerAppId)).toEqual(["a", "b"]);
  });

  it("drops an app that is no longer mountable (RT-4.2/4.3, disable/deregister)", async () => {
    const store = new MutableStore([app("a"), app("b")]);
    const server = new RecordingProtocolServer();
    const manager = new MountManager({ store, protocolServer: server });

    await manager.reconcile();
    store.setMountable([app("a")]);
    await manager.reconcile();

    expect(server.applied.at(-1)?.map((each) => each.consumerAppId)).toEqual(["a"]);
  });

  it("serializes overlapping reconciles so the last applied surface reflects the latest state", async () => {
    // A store whose read for the FIRST reconcile is deliberately slow; the second
    // reconcile is triggered while the first is still reading. Serialization must
    // make the second apply land AFTER the first, never interleaved before it.
    const order: string[] = [];
    let call = 0;
    const store: AdapterStore = {
      listMountableConsumerApps: async () => {
        call += 1;
        const which = call;
        await new Promise((resolve) => setTimeout(resolve, which === 1 ? 20 : 0));
        return [app(`state-${String(which)}`)];
      },
      loadEndpointState: () => Promise.resolve({ endpoint: undefined, bindings: [] }),
    };
    const server: ProtocolServer = {
      setMountedSurface: (apps) => {
        order.push(apps[0]?.consumerAppId ?? "empty");
      },
    };
    const manager = new MountManager({ store, protocolServer: server });

    await Promise.all([manager.reconcile(), manager.reconcile()]);

    // Applied strictly in trigger order despite the first read being slower.
    expect(order).toEqual(["state-1", "state-2"]);
  });

  it("a failed reconcile does not poison the chain — the next one still runs", async () => {
    let attempts = 0;
    const store: AdapterStore = {
      listMountableConsumerApps: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("store unavailable"));
        }
        return Promise.resolve([app("a")]);
      },
      loadEndpointState: () => Promise.resolve({ endpoint: undefined, bindings: [] }),
    };
    const server = new RecordingProtocolServer();
    const manager = new MountManager({ store, protocolServer: server });

    await expect(manager.reconcile()).rejects.toThrow("store unavailable");
    await manager.reconcile();

    expect(server.applied.at(-1)?.map((each) => each.consumerAppId)).toEqual(["a"]);
  });
});
