import type { CredentialMaterial } from "@mediator/credentials";
import { CredentialStore, DbCredentialPersistence } from "@mediator/credentials";
import type {
  CredentialMetadata,
  Database,
  DetectionJobScope,
  ResourceBindingRefPatch,
  ScopePathBindingPatch,
  SourceScopeRefPatch,
  UnfinishedDetectionJob,
} from "@mediator/db";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DetectionJobRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncRuleRepository,
  tx,
} from "@mediator/db";
import type { KeyProvider } from "@mediator/credentials";
import type { CredentialStoreLogger } from "@mediator/credentials";
import type { EventBus } from "@mediator/event-bus";
import type {
  AdapterBinding,
  ApiSpec,
  ApiSpecRole,
  ApiSpecStatus,
  ApprovedMapping,
  AuditLogEntry,
  DomainEventEnvelope,
  FieldMapping,
  Ir,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  ScopeCorrespondence,
  SyncRule,
} from "@mediator/domain";
import type { ScopeCorrespondenceSide } from "@mediator/ir";

import { GraphProjection } from "./graph/index.js";
import type {
  CorrespondenceRevalidationResult,
  SpecScopeRevalidationResult,
} from "./sync/scope-lifecycle.js";
import { ScopeLifecycleService } from "./sync/scope-lifecycle.js";

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
  /** SL-2.4 — the bindings pinned to a spec version (the set carried forward on an additive advance). */
  listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]>;
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
 * The `ApprovedMapping` operations the SL-2 additive re-pin and the SL-4 breaking
 * reaction need inside the version-advance transaction: read the `active` mappings
 * pinned to the superseded version, and either re-pin each to the new one (a mapping
 * referencing no changed element) or mark it `stale` (one referencing a changed
 * element). Deliberately narrow — neither reaction touches mapping content.
 */
export interface ApprovedMappingTxRepo {
  /** SL-2.1 — the `active` mappings pinned to `specId` on either side. */
  listActiveBySpecId(specId: string): Promise<ApprovedMapping[]>;
  /** SL-2.1/2.2 — re-pin a mapping's spec ids only; every other column is untouched. */
  repinSpecs(
    id: string,
    sourceSpecId: string,
    targetSpecId: string,
  ): Promise<ApprovedMapping | undefined>;
  /**
   * SL-4.1/4.2/4.3 — set **only** `status = "stale"`; the pinned spec ids (stays on the
   * reviewed/superseded version), the counterpart, and the children are untouched.
   */
  markStale(id: string): Promise<ApprovedMapping | undefined>;
}

/**
 * SL-4.1 — the mapping's approved children the breaking reaction reads to decide whether
 * the mapping **references a changed element**: each `FieldMapping` path and each
 * `OperationMapping` operation ref (per side). Deliberately read-only and narrow — the
 * reaction never mutates the children, only matches their refs against the `SpecDiff`.
 */
export interface MappingArtifactsTxReader {
  listFieldMappings(mappingId: string): Promise<FieldMapping[]>;
  listOperationMappings(mappingId: string): Promise<OperationMapping[]>;
}

/**
 * SL-4.6 / XI-2 — the downstream adapter artifacts a stale consumer-provider mapping
 * derived, read so the coupled cache drop can target **every** `AdapterEndpoint` whose
 * binding's mapping went stale. Read-only; the reaction never mutates a binding (its
 * `status` is its own — SL-4.2). SL-5.2 additionally reads a mapping's `SyncRule`s to
 * re-validate their `pollOperationRef` against the new IR.
 */
export interface DownstreamArtifactTxReader {
  listAdapterBindingsByMapping(mappingId: string): Promise<AdapterBinding[]>;
  /** SL-5.2 — a mapping's `SyncRule`s, whose pinned source `pollOperationRef` is re-validated. */
  listSyncRulesByMapping(approvedMappingId: string): Promise<SyncRule[]>;
}

/**
 * **SL-5.2 — the `SyncRule` mutation the breaking reaction drives in-tx.** Returning a
 * rule's `pollOperationRef` to unconfirmed (clearing it) when a spec bump removed/renamed
 * the pinned source poll operation — the derived pause (SL-5.4). Deliberately narrow: the
 * reaction never writes a rule `status`, and the *re-confirm* (cursor/snapshot reset) is a
 * later human action, not part of this transaction.
 */
export interface SyncRuleTxRepo {
  clearPollOperationRef(id: string): Promise<void>;
}

/**
 * **SL-5.3 — the reverse lookup from the changed spec's resources to the scoped pairs they
 * participate in** (`ScopeCorrespondenceRepository.listByResourceSide`), so the breaking
 * reaction can find every `ScopeCorrespondence` to re-validate. Read-only; the write is the
 * `ScopeLifecycleService` below.
 */
export interface ScopeCorrespondenceSideTxReader {
  listByResourceSide(appId: string, resourceRef: string): Promise<ScopeCorrespondence[]>;
}

/**
 * **SL-5.1/5.3 — the SS-16 scope-artifact re-validation policy, bound to the transaction.**
 * The breaking reaction calls `revalidateSpecBindings` (returns broken `ResourceBinding`
 * refs to unconfirmed, retained in place) and `revalidateCorrespondence` (returns a scoped
 * pair's `ScopeCorrespondence` to unconfirmed and archives — never deletes — its
 * `ScopeLink`s). The concrete `ScopeLifecycleService` (over tx-bound repos) satisfies this
 * shape; a unit-test fake supplies a recording double.
 */
export interface ScopeRevalidationTxService {
  revalidateSpecBindings(specId: string, newIr: Ir): Promise<SpecScopeRevalidationResult>;
  revalidateCorrespondence(
    correspondence: ScopeCorrespondence,
    source: ScopeCorrespondenceSide,
    target: ScopeCorrespondenceSide,
  ): Promise<CorrespondenceRevalidationResult>;
}

/**
 * SL-4.6 / GR-2/GR-3 — recompute an affected app-pair's `GraphEdge` **within the
 * version-advance transaction**, so the projection commits atomically with the stale
 * transition and no stale graph edge masks the pause. Keyed by the stable `(app pair)`
 * (GR-1.4), never by a mapping/rule/binding id. In production these delegate to the
 * shared {@link GraphProjection}'s `recompute*EdgeWithin(handle, …)` seam bound to the
 * open transaction handle — the SAME seam CO-6 uses (no parallel mechanism).
 */
export interface GraphEdgeRecompute {
  /** A peer-peer mapping going stale → recompute its `(sourceApp → targetApp)` sync edge. */
  recomputeSyncEdge(sourceAppId: string, targetAppId: string): Promise<void>;
  /** A consumer-provider mapping going stale → recompute its `(consumerApp → backendApp)` adapter edge. */
  recomputeAdapterEdge(consumerAppId: string, backendAppId: string): Promise<void>;
}

/**
 * XI-2 / CH-5.3 — the by-endpoint cache-drop seam
 * (`CacheInvalidator.invalidateEndpoint`), the SAME one CO-6 recomposition drives
 * (CH-5.6: one mechanism, two key kinds). A local port (a low-level module must not
 * import the HTTP/serve layer), structurally satisfied by the shared
 * `ResponseCacheInvalidator` the composition root wires in. Coarse and
 * correctness-safe: a no-op for an endpoint with nothing cached, and it must **never**
 * fail the triggering transition (a missed drop only costs a spurious hit until
 * `cacheTtl`).
 */
export interface EndpointCacheInvalidator {
  invalidateEndpoint(endpointId: string): void;
}

/** Appends audit-log rows within the current transaction (SL-2.1 records each re-pin). */
export interface AuditTxRepo {
  insert(entry: AuditLogEntry): Promise<void>;
}

/**
 * The scoped-detection-job enqueue the SL-3 additive reaction drives **inside the
 * version-advance transaction**: it records the intent to run the scoped delta
 * analysis (the `DetectionJobScope` descriptor), committing atomically with the
 * re-pin/carry-forward. The slow LLM/network work runs later in the worker,
 * outside this transaction (DT-2). Deliberately narrow — the reaction only records
 * intent, exactly as the `SpecIngested` consumer records a full detection job.
 *
 * `enqueueScoped` reports whether it actually inserted: a scoped job freezes its
 * payload in the row, so a collapse against an un-finished job discards that
 * descriptor's work rather than deduplicating it. SL-9 resolves such a collapse
 * in-transaction via {@link lockUnfinishedJob} + {@link updateScope} rather than
 * committing a silent loss.
 */
export interface DetectionJobTxRepo {
  enqueueScoped(apiSpecId: string, scope: DetectionJobScope): Promise<boolean>;
  /** The spec's un-finished job, locked `FOR UPDATE` so the collapse resolution is race-free. */
  lockUnfinishedJob(apiSpecId: string): Promise<UnfinishedDetectionJob | undefined>;
  /** Replace a locked job's frozen `scope` (the SL-9 merge into a pending re-inclusion job). */
  updateScope(id: string, scope: DetectionJobScope): Promise<void>;
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
  // ── SL-2 additive re-pin / SL-4 breaking stale-mark ports ──
  readonly approvedMappings: ApprovedMappingTxRepo;
  readonly audit: AuditTxRepo;
  // ── SL-3 scoped-delta trigger (records the scoped analysis job in-tx) ──
  readonly detectionJobs: DetectionJobTxRepo;
  // ── SL-4 breaking reaction: match refs, drop caches, recompute graph edges ──
  readonly mappingArtifacts: MappingArtifactsTxReader;
  readonly downstreamArtifacts: DownstreamArtifactTxReader;
  readonly graph: GraphEdgeRecompute;
  readonly cacheInvalidator: EndpointCacheInvalidator;
  // ── SL-5 breaking reaction: re-validate the spec's operational refs to unconfirmed ──
  readonly syncRules: SyncRuleTxRepo;
  readonly scopeCorrespondences: ScopeCorrespondenceSideTxReader;
  readonly scopeLifecycle: ScopeRevalidationTxService;
  emit(event: DomainEventEnvelope): Promise<void>;
}

/** Runs `work` inside a database transaction with a fully-built {@link TxStores}. */
export interface UnitOfWork {
  run<T>(work: (stores: TxStores) => Promise<T>): Promise<T>;
}

// ── Postgres-backed implementation ───────────────────────────────────────────

/**
 * The real {@link UnitOfWork}: opens a `@mediator/db` transaction and builds a
 * {@link TxStores} whose repositories, credential store, event emit, and (SL-4)
 * graph-recompute all run on that one transaction handle. A per-transaction
 * {@link CredentialStore} is constructed here so `CredentialStore.store` participates
 * in the same atomic unit as the app + specs (AR-1 crit 7 / CR-1).
 *
 * The `graph` port binds the shared {@link GraphProjection}'s `recompute*EdgeWithin`
 * seam to the open handle, so the SL-4 breaking reaction's edge recompute commits
 * atomically with the stale transition. The `cacheInvalidator` is the process-level,
 * non-transactional by-endpoint cache-drop seam (XI-2 / CH-5.3); when none is wired
 * (a Phase-1..3 harness with no adapter runtime) it defaults to a no-op.
 */
export class DbUnitOfWork implements UnitOfWork {
  readonly #db: Database;
  readonly #keyProvider: KeyProvider;
  readonly #eventBus: EventBus;
  readonly #credentialLogger: CredentialStoreLogger | undefined;
  readonly #graphProjection: GraphProjection;
  readonly #cacheInvalidator: EndpointCacheInvalidator;

  public constructor(
    db: Database,
    keyProvider: KeyProvider,
    eventBus: EventBus,
    credentialLogger?: CredentialStoreLogger,
    cacheInvalidator?: EndpointCacheInvalidator,
    graphProjection?: GraphProjection,
  ) {
    this.#db = db;
    this.#keyProvider = keyProvider;
    this.#eventBus = eventBus;
    this.#credentialLogger = credentialLogger;
    // GraphProjection is stateless (db + a newId seam); default one if the caller wires
    // none. A no-injected-invalidator service simply drops no cache (XI-2 is coarse and
    // correctness-safe, so an un-wired cache is bounded staleness, never incorrectness).
    this.#graphProjection = graphProjection ?? new GraphProjection({ db });
    this.#cacheInvalidator = cacheInvalidator ?? { invalidateEndpoint: (): void => {} };
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
        approvedMappings: new ApprovedMappingRepository(txn),
        audit: new AuditLogRepository(txn),
        detectionJobs: new DetectionJobRepository(txn),
        mappingArtifacts: new MappingArtifactsRepository(txn),
        downstreamArtifacts: new DownstreamArtifactRepository(txn),
        graph: {
          recomputeSyncEdge: (sourceAppId, targetAppId) =>
            this.#graphProjection.recomputeSyncEdgeWithin(txn, sourceAppId, targetAppId),
          recomputeAdapterEdge: (consumerAppId, backendAppId) =>
            this.#graphProjection.recomputeAdapterEdgeWithin(txn, consumerAppId, backendAppId),
        },
        cacheInvalidator: this.#cacheInvalidator,
        // SL-5 — the operational-ref re-validation seams, all bound to this transaction so
        // the unconfirmed artifacts commit atomically with the stale-mark/re-pin.
        syncRules: new SyncRuleRepository(txn),
        scopeCorrespondences: new ScopeCorrespondenceRepository(txn),
        scopeLifecycle: new ScopeLifecycleService({
          resourceBindings: new ResourceBindingRepository(txn),
          scopeCorrespondences: new ScopeCorrespondenceRepository(txn),
          scopeLinks: new ScopeLinkRepository(txn),
        }),
        emit: (event) => this.#eventBus.emit(event, txn),
      }),
    );
  }
}
