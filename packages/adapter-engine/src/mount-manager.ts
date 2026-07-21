import type { AdapterStore, ProtocolServer } from "./ports.js";

export interface MountManagerDeps {
  readonly store: AdapterStore;
  readonly protocolServer: ProtocolServer;
}

/**
 * Keeps the live mounted surface in agreement with persisted state (RT-4). It holds
 * **no** mount state of its own — every `reconcile()` re-derives the desired surface
 * from the store and hands it to the {@link ProtocolServer} — so a restart, a new
 * `SpecIngested`, an app disable, and a deregister are all handled by the *same*
 * idempotent operation (RT-4.1/4.2/4.3/4.5). The runtime calls `reconcile()` once at
 * startup, from the `SpecIngested` event consumer, and from the periodic reconciler.
 *
 * Reconciles are **serialized**: each awaits the previous before it reads and applies,
 * so two overlapping triggers can never interleave into a torn or stale surface (a
 * slow reconcile's apply landing after a newer one's). Each call still returns its own
 * promise, so its caller sees its own errors, and one failed reconcile does not poison
 * the chain.
 */
export class MountManager {
  #tail: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: MountManagerDeps) {}

  /** Re-derive the mounted surface from persisted state and apply it. Idempotent. */
  public reconcile(): Promise<void> {
    const run = this.#tail.then(
      () => this.#reconcileOnce(),
      () => this.#reconcileOnce(),
    );
    // Keep the chain alive but swallow the tail's rejection so one failure never
    // blocks the next reconcile; the caller still observes `run`'s own rejection.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #reconcileOnce(): Promise<void> {
    const apps = await this.deps.store.listMountableConsumerApps();
    this.deps.protocolServer.setMountedSurface(apps);
  }
}
