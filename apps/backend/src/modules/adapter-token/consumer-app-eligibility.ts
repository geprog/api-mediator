import type { ConsumerAppEligibility, ConsumerAppEligibilityReader } from "@mediator/credentials";
import { ApiSpecRepository, RegisteredAppRepository, type DbHandle } from "@mediator/db";

/**
 * The Postgres-backed {@link ConsumerAppEligibilityReader}: whether an app may hold
 * or use an adapter token. An app is **eligible** when it exists, carries an active
 * `CONSUMER` `ApiSpec` (it has a generated adapter surface — AT-1.4/AT-3.4), and is
 * itself `active` (a disabled app's token is revoked implicitly — AT-4.4; a
 * deregistered app's specs are archived, so it drops to `not-consumer`).
 *
 * Bound to a {@link DbHandle} so the same check runs on the pool (per-request
 * validation) or inside an issue/rotate/cutover transaction.
 */
export class DbConsumerAppEligibilityReader implements ConsumerAppEligibilityReader {
  readonly #apps: RegisteredAppRepository;
  readonly #specs: ApiSpecRepository;

  public constructor(db: DbHandle) {
    this.#apps = new RegisteredAppRepository(db);
    this.#specs = new ApiSpecRepository(db);
  }

  public async check(appId: string): Promise<ConsumerAppEligibility> {
    const app = await this.#apps.getById(appId);
    if (app === undefined) {
      return { kind: "not-found" };
    }
    const specs = await this.#specs.listByAppId(appId);
    const hasConsumerSurface = specs.some(
      (spec) => spec.role === "CONSUMER" && spec.status === "active",
    );
    if (!hasConsumerSurface) {
      return { kind: "not-consumer" };
    }
    if (app.status !== "active") {
      return { kind: "not-active" };
    }
    return { kind: "eligible" };
  }
}
