import type { CredentialMaterial } from "@mediator/credentials";
import { CredentialStore, DbCredentialPersistence } from "@mediator/credentials";
import type {
  CredentialMetadata,
  Database,
  ResourceBindingRefPatch,
  ScopePathBindingPatch,
  SourceScopeRefPatch,
} from "@mediator/db";
import {
  ApiSpecRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  tx,
} from "@mediator/db";
import type { KeyProvider } from "@mediator/credentials";
import type { CredentialStoreLogger } from "@mediator/credentials";
import type { EventBus } from "@mediator/event-bus";
import type {
  ApiSpec,
  ApiSpecRole,
  ApiSpecStatus,
  DomainEventEnvelope,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";

/**
 * The persistence seam for the registration API slice.
 *
 * Two injection styles, each chosen for where it fits:
 *
 * - **Reader ports** ({@link AppReader}/{@link SpecReader}/{@link BindingReader})
 *   are used by the read-only `GET` routes and run on the pooled connection.
 * - The **transactional write path** ({@link UnitOfWork} → {@link TxStores}) runs
 *   every registration/mutation inside one database transaction, so a failure
 *   persists nothing and emits no event (AR-1 crit 7 / EB-1). `TxStores.emit` is
 *   pre-bound to the open transaction, keeping the transactional-outbox
 *   guarantee (the `SpecIngested` row commits or rolls back with its spec).
 *
 * Splitting reads (pooled `Database`) from writes (a `DbTransaction`) is why the
 * two are separate ports rather than one handle: the concrete `@mediator/db`
 * repositories satisfy both shapes, and unit tests supply in-memory fakes for
 * each without a live Postgres.
 */

// ── Read ports (pooled) ──────────────────────────────────────────────────────

export interface AppReader {
  list(): Promise<RegisteredApp[]>;
  getById(id: string): Promise<RegisteredApp | undefined>;
}

export interface SpecReader {
  getById(id: string): Promise<ApiSpec | undefined>;
  listByAppId(appId: string): Promise<ApiSpec[]>;
}

export interface BindingReader {
  getById(id: string): Promise<ResourceBinding | undefined>;
  listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]>;
}

// ── Transactional write ports ────────────────────────────────────────────────

export interface AppTxRepo {
  create(app: RegisteredApp): Promise<RegisteredApp>;
  getById(id: string): Promise<RegisteredApp | undefined>;
}

export interface SpecTxRepo {
  create(spec: ApiSpec): Promise<ApiSpec>;
  getById(id: string): Promise<ApiSpec | undefined>;
  /** SL-1.1 — the single `active` spec of a `(app, role)` lineage (the version a re-ingest advances from). */
  findActiveByAppAndRole(appId: string, role: ApiSpecRole): Promise<ApiSpec | undefined>;
  /** SL-1.1 — advance a spec's lifecycle status (used to supersede the prior active version). */
  updateStatus(id: string, status: ApiSpecStatus): Promise<ApiSpec | undefined>;
  updateAnalysisExclusions(id: string, analysisExclusions: string[]): Promise<ApiSpec | undefined>;
}

export interface BindingTxRepo {
  createMany(bindings: ResourceBinding[]): Promise<ResourceBinding[]>;
  getById(id: string): Promise<ResourceBinding | undefined>;
  update(id: string, patch: ResourceBindingRefPatch): Promise<ResourceBinding | undefined>;
  updateScopePathBinding(
    id: string,
    patch: ScopePathBindingPatch,
  ): Promise<ResourceBinding | undefined>;
  updateSourceScopeRef(
    id: string,
    patch: SourceScopeRefPatch,
  ): Promise<ResourceBinding | undefined>;
}

/** The write-only credential entry point, bound to the current transaction. */
export interface CredentialTxStore {
  store(appId: string, material: CredentialMaterial): Promise<CredentialMetadata>;
}

/**
 * The repositories + event emit available inside one transaction. `emit` is
 * already bound to the open transaction (transactional outbox), so callers just
 * hand it a domain event.
 */
export interface TxStores {
  readonly registeredApps: AppTxRepo;
  readonly apiSpecs: SpecTxRepo;
  readonly resourceBindings: BindingTxRepo;
  readonly credentialStore: CredentialTxStore;
  emit(event: DomainEventEnvelope): Promise<void>;
}

/** Runs `work` inside a database transaction with a fully-built {@link TxStores}. */
export interface UnitOfWork {
  run<T>(work: (stores: TxStores) => Promise<T>): Promise<T>;
}

// ── Postgres-backed implementation ───────────────────────────────────────────

/**
 * The real {@link UnitOfWork}: opens a `@mediator/db` transaction and builds a
 * {@link TxStores} whose repositories, credential store, and event emit all run
 * on that one transaction handle. A per-transaction {@link CredentialStore} is
 * constructed here so `CredentialStore.store` participates in the same atomic
 * unit as the app + specs (AR-1 crit 7 / CR-1).
 */
export class DbUnitOfWork implements UnitOfWork {
  readonly #db: Database;
  readonly #keyProvider: KeyProvider;
  readonly #eventBus: EventBus;
  readonly #credentialLogger: CredentialStoreLogger | undefined;

  public constructor(
    db: Database,
    keyProvider: KeyProvider,
    eventBus: EventBus,
    credentialLogger?: CredentialStoreLogger,
  ) {
    this.#db = db;
    this.#keyProvider = keyProvider;
    this.#eventBus = eventBus;
    this.#credentialLogger = credentialLogger;
  }

  public run<T>(work: (stores: TxStores) => Promise<T>): Promise<T> {
    return tx(this.#db, (txn) =>
      work({
        registeredApps: new RegisteredAppRepository(txn),
        apiSpecs: new ApiSpecRepository(txn),
        resourceBindings: new ResourceBindingRepository(txn),
        credentialStore: new CredentialStore(
          new DbCredentialPersistence(txn),
          this.#keyProvider,
          this.#credentialLogger,
        ),
        emit: (event) => this.#eventBus.emit(event, txn),
      }),
    );
  }
}
