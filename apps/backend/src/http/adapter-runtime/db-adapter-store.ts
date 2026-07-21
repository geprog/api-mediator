import type { AdapterStore, EndpointState, MountedConsumerApp } from "@mediator/adapter-engine";
import {
  ApiSpecRepository,
  DownstreamArtifactRepository,
  RegisteredAppRepository,
  type Database,
} from "@mediator/db";

/**
 * The `@mediator/db`-backed implementation of the neutral {@link AdapterStore}
 * port. All persistence detail (Drizzle, SQL, the schema) stays here in the REST
 * runtime; the core sees only the port.
 *
 * The reads are the whole of what RT-2/RT-3/RT-4 need from persisted state, which
 * is what makes the mounted surface **re-derivable from persisted state alone** on
 * restart (RT-4.5).
 */
export class DbAdapterStore implements AdapterStore {
  public constructor(private readonly db: Database) {}

  /**
   * Every `active` `CONSUMER` `ApiSpec` whose owning `RegisteredApp` is `active`
   * (RT-2.1/RT-4). A **disabled** app is excluded even though disabling touches no
   * spec status (RT-4.2, `docs/architecture/extensibility.md` *App lifecycle*); a
   * **deregistered** app's specs are archived and its endpoints/bindings deleted, so
   * it too simply drops out here (RT-4.3). `PROVIDER` specs are never mounted — the
   * mediator never hosts a provider's own API as an adapter surface.
   */
  public async listMountableConsumerApps(): Promise<readonly MountedConsumerApp[]> {
    const [apps, specs] = await Promise.all([
      new RegisteredAppRepository(this.db).list(),
      new ApiSpecRepository(this.db).listActive(),
    ]);
    const activeAppIds = new Set(
      apps.filter((app) => app.status === "active").map((app) => app.id),
    );
    return specs
      .filter((spec) => spec.role === "CONSUMER" && activeAppIds.has(spec.appId))
      .map((spec) => ({ consumerAppId: spec.appId, ir: spec.parsedIR }));
  }

  /**
   * The `AdapterEndpoint` for `(consumerAppId, operationKey)` and all of its
   * `AdapterBinding`s (RT-3). The store only loads; the core's `resolveRequest`
   * decides `not-yet-mapped` / `endpoint-disabled` / `serve` from this state.
   */
  public async loadEndpointState(
    consumerAppId: string,
    operationKeyValue: string,
  ): Promise<EndpointState> {
    const repo = new DownstreamArtifactRepository(this.db);
    const endpoint = await repo.getAdapterEndpoint(consumerAppId, operationKeyValue);
    if (endpoint === undefined) {
      return { endpoint: undefined, bindings: [] };
    }
    const bindings = await repo.listAdapterBindingsByEndpoint(endpoint.id);
    return { endpoint, bindings };
  }
}
