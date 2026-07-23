import { randomUUID } from "node:crypto";

import { RESOURCE_BINDING_REF_KINDS } from "@mediator/contracts";
import type { CredentialMaterial } from "@mediator/credentials";
import type {
  CredentialMetadata,
  DetectionJobScope,
  ResourceBindingRefPatch,
  ScopePathBindingPatch,
  SourceScopeRefPatch,
  UnfinishedDetectionJob,
} from "@mediator/db";
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
  ScopePathBinding,
  SyncRule,
} from "@mediator/domain";
import { revalidateResourceBinding, revalidateScopeCorrespondence } from "@mediator/ir";
import type { ScopeCorrespondenceSide } from "@mediator/ir";
import Fastify, { type FastifyInstance } from "fastify";

import { AnalysisExclusionsService } from "../modules/analysis-exclusions.js";
import { FakeApprovalPersistence } from "../modules/approval/approval.testkit.js";
import type {
  CorrespondenceRevalidationResult,
  SpecScopeRevalidationResult,
} from "../modules/sync/scope-lifecycle.js";
import type {
  ApprovedMappingTxRepo,
  AppReader,
  AppTxRepo,
  AuditTxRepo,
  BindingReader,
  BindingTxRepo,
  CredentialTxStore,
  DownstreamArtifactTxReader,
  EndpointCacheInvalidator,
  GraphEdgeRecompute,
  MappingArtifactsTxReader,
  ScopeRevalidationTxService,
  SpecReader,
  DetectionJobTxRepo,
  SpecTxRepo,
  SyncRuleTxRepo,
  TxStores,
  UnitOfWork,
} from "../modules/persistence.js";
import { RegistrationService } from "../modules/registration.js";
import { ResourceBindingService } from "../modules/resource-bindings.js";
import {
  ScopeLinkAuthoringResolver,
  type ScopeCorrespondenceSideReader,
} from "../modules/scope-authoring.js";
import { SpecRegistry } from "../modules/spec-registry.js";
import { LocalAccountsAuthProvider } from "../http/auth/index.js";
import { registerErrorHandler } from "../http/errors.js";
import { registerAuthenticatedOperatorApi } from "../http/operator/api.js";
import { buildApprovalApiDeps, type ApprovalApiTestOptions } from "./approval-api.testkit.js";
import { TEST_OPERATOR_ACCOUNTS } from "./auth.testkit.js";

/**
 * In-memory persistence fakes for the operator-API unit tests. They implement
 * the same reader/tx ports as the real `@mediator/db` repositories over plain
 * `Map`s, so route → service orchestration runs end to end (with the **real**
 * `buildIr`, DTO mappers, and error handling) without a live Postgres.
 *
 * The credential fake records only `{ appId, type }` — never the secret — so a
 * test can assert a credential was stored while proving no response echoes it.
 * `FakeUnitOfWork` restores a pre-run snapshot on error, mimicking a transaction
 * rollback so atomicity is testable without a database.
 *
 * This is a `*.testkit.ts` file: excluded from `dist` (never shipped) but
 * type-checked by the dev tsconfig, and never collected as a Vitest suite.
 */

/** A recorded (secret-free) credential-store call. */
export interface RecordedCredential {
  readonly appId: string;
  readonly type: string;
  readonly scopeCount: number;
}

/** The shared in-memory state every fake reads from and writes to. */
export class InMemoryStore {
  public readonly apps = new Map<string, RegisteredApp>();
  public readonly specs = new Map<string, ApiSpec>();
  public readonly bindings = new Map<string, ResourceBinding>();
  public readonly credentials: RecordedCredential[] = [];
  public readonly events: DomainEventEnvelope[] = [];
  /**
   * Proposed/confirmed `ScopeCorrespondence`s (SS-10/SS-18), keyed by `resourcePairRef` —
   * the same "one per scoped resource pair" invariant the UNIQUE index enforces. Seed it
   * to make `scope-link` a selectable kind for a resource (SS-18.4).
   */
  public readonly scopeCorrespondences = new Map<string, ScopeCorrespondence>();
  /** SL-2/SL-4 — `ApprovedMapping`s keyed by id, so the additive re-pin / breaking stale-mark can find + advance them. */
  public readonly approvedMappings = new Map<string, ApprovedMapping>();
  /** SL-2/SL-4 — appended audit rows (re-pin + stale records are `mapping-decision`/`system` entries). */
  public readonly auditLog: AuditLogEntry[] = [];
  /** SL-3 — scoped detection jobs the additive reaction enqueued (recorded intent), so a test can assert the scoped analysis was triggered in-tx. */
  public readonly scopedDetectionJobs: {
    readonly apiSpecId: string;
    readonly scope: DetectionJobScope;
  }[] = [];
  /**
   * SL-9 — the un-finished (`pending`/`running`) `mapping_detection_job` blocking this
   * spec's enqueue, mirroring the real partial UNIQUE index over
   * `(api_spec_id) WHERE status in ('pending','running')`. Seed it to exercise the
   * collapse-resolution branches (merge / fold / 409); left `undefined`, a scoped
   * enqueue simply inserts, as it does against an empty table.
   */
  public unfinishedDetectionJob:
    | {
        readonly apiSpecId: string;
        readonly id: string;
        status: "pending" | "running";
        scope: DetectionJobScope | null;
      }
    | undefined = undefined;
  /** SL-4 — a mapping's approved `FieldMapping`/`OperationMapping` children, read by the breaking reaction to match referenced elements against the diff. */
  public readonly fieldMappings: FieldMapping[] = [];
  public readonly operationMappings: OperationMapping[] = [];
  /** SL-4.6 — the adapter bindings a consumer-provider mapping derived, read to target the coupled cache drop. */
  public readonly adapterBindings: AdapterBinding[] = [];
  /** SL-5.2 — `SyncRule`s keyed by id, so the breaking reaction can re-validate + clear their `pollOperationRef`. */
  public readonly syncRules = new Map<string, SyncRule>();
  /** SL-5.1 — the spec ids whose `ResourceBinding`s the breaking reaction re-validated (spy surface). */
  public readonly bindingRevalidations: string[] = [];
  /** SL-5.3 — the `ScopeCorrespondence`s the breaking reaction re-validated (spy surface: id + archive scope). */
  public readonly correspondenceRevalidations: {
    readonly correspondenceId: string;
    readonly archivedScopeLinks: number;
  }[] = [];
  /** SL-4.6 — the `GraphEdge` recomputes the breaking reaction requested (spy surface for tests). */
  public readonly graphRecomputes: {
    readonly type: "sync" | "adapter-dependency";
    readonly sourceAppId: string;
    readonly targetAppId: string;
  }[] = [];
  /** SL-4.6 / XI-2 — the `AdapterEndpoint` ids whose cache the breaking reaction dropped (spy surface for tests). */
  public readonly cacheInvalidations: string[] = [];
  /**
   * SL-4.6 / XI-2.5 — when `true`, {@link FakeEndpointCacheInvalidator} throws on every
   * `invalidateEndpoint`, so a test can prove the coarse cache drop NEVER fails the
   * triggering transition (it is guarded by `invalidateEndpointSafely`).
   */
  public failCacheInvalidation = false;
}

/**
 * Mirrors `ScopeCorrespondenceRepository.listByResourceSide`: every correspondence whose
 * canonical `resourcePairRef` names `(appId, resourceRef)` as one of its two
 * `"<appId>:<resourceRef>"` tokens. Exact token equality, as the real repo re-checks
 * after its SQL `LIKE` narrowing.
 */
class FakeScopeCorrespondenceRepo implements ScopeCorrespondenceSideReader {
  public constructor(private readonly store: InMemoryStore) {}
  public listByResourceSide(appId: string, resourceRef: string): Promise<ScopeCorrespondence[]> {
    const token = `${appId}:${resourceRef}`;
    return Promise.resolve(
      [...this.store.scopeCorrespondences.values()].filter((correspondence) =>
        correspondence.resourcePairRef.split("|").some((side) => side === token),
      ),
    );
  }
}

class FakeAppRepo implements AppReader, AppTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public create(app: RegisteredApp): Promise<RegisteredApp> {
    this.store.apps.set(app.id, app);
    return Promise.resolve(app);
  }
  public getById(id: string): Promise<RegisteredApp | undefined> {
    return Promise.resolve(this.store.apps.get(id));
  }
  public list(): Promise<RegisteredApp[]> {
    return Promise.resolve([...this.store.apps.values()]);
  }
}

class FakeSpecRepo implements SpecReader, SpecTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public create(spec: ApiSpec): Promise<ApiSpec> {
    this.store.specs.set(spec.id, spec);
    return Promise.resolve(spec);
  }
  public getById(id: string): Promise<ApiSpec | undefined> {
    return Promise.resolve(this.store.specs.get(id));
  }
  public listByAppId(appId: string): Promise<ApiSpec[]> {
    return Promise.resolve([...this.store.specs.values()].filter((spec) => spec.appId === appId));
  }
  public findActiveByAppAndRole(appId: string, role: ApiSpecRole): Promise<ApiSpec | undefined> {
    return Promise.resolve(
      [...this.store.specs.values()].find(
        (spec) => spec.appId === appId && spec.role === role && spec.status === "active",
      ),
    );
  }
  public updateStatus(id: string, status: ApiSpecStatus): Promise<ApiSpec | undefined> {
    const existing = this.store.specs.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: ApiSpec = { ...existing, status };
    this.store.specs.set(id, updated);
    return Promise.resolve(updated);
  }
  public updateAnalysisExclusions(
    id: string,
    analysisExclusions: string[],
  ): Promise<ApiSpec | undefined> {
    const existing = this.store.specs.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: ApiSpec = { ...existing, analysisExclusions };
    this.store.specs.set(id, updated);
    return Promise.resolve(updated);
  }
}

class FakeBindingRepo implements BindingReader, BindingTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public createMany(bindings: ResourceBinding[]): Promise<ResourceBinding[]> {
    for (const binding of bindings) this.store.bindings.set(binding.id, binding);
    return Promise.resolve(bindings);
  }
  public getById(id: string): Promise<ResourceBinding | undefined> {
    return Promise.resolve(this.store.bindings.get(id));
  }
  public listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]> {
    return Promise.resolve(
      [...this.store.bindings.values()].filter((binding) => binding.apiSpecId === apiSpecId),
    );
  }
  public update(id: string, patch: ResourceBindingRefPatch): Promise<ResourceBinding | undefined> {
    const existing = this.store.bindings.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: ResourceBinding = { ...existing };
    for (const kind of RESOURCE_BINDING_REF_KINDS) {
      const refPatch = patch[kind];
      if (refPatch === undefined) continue;
      const current = updated[kind];
      // Mirror ResourceBindingRepository.update exactly: a correction (value
      // present) upserts the ref, a pure confirmation updates an existing ref,
      // and confirming an absent ref is a no-op (real UPDATE matches 0 rows).
      if (refPatch.value !== undefined) {
        updated[kind] = {
          value: refPatch.value,
          confirmedBy:
            "confirmedBy" in refPatch
              ? (refPatch.confirmedBy ?? null)
              : (current?.confirmedBy ?? null),
          confirmedAt:
            "confirmedAt" in refPatch
              ? (refPatch.confirmedAt ?? null)
              : (current?.confirmedAt ?? null),
        };
      } else if (current !== undefined) {
        updated[kind] = {
          value: current.value,
          confirmedBy:
            "confirmedBy" in refPatch ? (refPatch.confirmedBy ?? null) : current.confirmedBy,
          confirmedAt:
            "confirmedAt" in refPatch ? (refPatch.confirmedAt ?? null) : current.confirmedAt,
        };
      }
    }
    this.store.bindings.set(id, updated);
    return Promise.resolve(updated);
  }

  public updateScopePathBinding(
    id: string,
    patch: ScopePathBindingPatch,
  ): Promise<ResourceBinding | undefined> {
    const existing = this.store.bindings.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    // Mirror ResourceBindingRepository.updateScopePathBinding (via
    // applyScopePathBindingPatch) exactly: rewrite only the entry whose
    // parameterName matches (per-parameter — SS-3.2) to the shape of the patch's
    // `kind` (a `constant`'s literal `value`, a `record-derived`'s `sourceScopeKey` +
    // optional `transform`, or a `scope-link`'s `scopeKeyRef`) — replacing the member,
    // not spreading over its prior fields — leaving every sibling scope entry AND all
    // operational refs untouched; when no entry matches, write nothing and return
    // unchanged. A `scope-link` patch may carry a NULL confirmation pair (SS-18.4's
    // select-without-confirming), which is stored verbatim exactly as the real repo does.
    const scope = existing.scopePathBindings ?? [];
    if (!scope.some((entry) => entry.parameterName === patch.parameterName)) {
      return Promise.resolve(existing);
    }
    const nextScope = scope.map((entry): ScopePathBinding => {
      if (entry.parameterName !== patch.parameterName) return entry;
      if (patch.kind === "constant") {
        return {
          kind: "constant",
          parameterName: patch.parameterName,
          value: patch.value,
          confirmedBy: patch.confirmedBy,
          confirmedAt: patch.confirmedAt,
        };
      }
      if (patch.kind === "record-derived") {
        return {
          kind: "record-derived",
          parameterName: patch.parameterName,
          sourceScopeKey: patch.sourceScopeKey,
          ...(patch.transform !== undefined ? { transform: patch.transform } : {}),
          confirmedBy: patch.confirmedBy,
          confirmedAt: patch.confirmedAt,
        };
      }
      return {
        kind: "scope-link",
        parameterName: patch.parameterName,
        scopeKeyRef: patch.scopeKeyRef,
        confirmedBy: patch.confirmedBy,
        confirmedAt: patch.confirmedAt,
      };
    });
    const updated: ResourceBinding = { ...existing, scopePathBindings: nextScope };
    this.store.bindings.set(id, updated);
    return Promise.resolve(updated);
  }

  public updateSourceScopeRef(
    id: string,
    patch: SourceScopeRefPatch,
  ): Promise<ResourceBinding | undefined> {
    const existing = this.store.bindings.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    // Mirror ResourceBindingRepository.updateSourceScopeRef exactly: replace the
    // whole `sourceScopeRef` (SS-7 confirms one ref whose value is the component
    // set), leaving the operational refs and scope-path bindings untouched.
    const updated: ResourceBinding = {
      ...existing,
      sourceScopeRef: {
        components: patch.components.map((component) => ({ ...component })),
        confirmedBy: patch.confirmedBy,
        confirmedAt: patch.confirmedAt,
      },
    };
    this.store.bindings.set(id, updated);
    return Promise.resolve(updated);
  }
}

class FakeCredentialStore implements CredentialTxStore {
  // Named `state` (not `store`) so the field does not collide with the `store`
  // method this fake implements.
  public constructor(private readonly state: InMemoryStore) {}
  public store(appId: string, material: CredentialMaterial): Promise<CredentialMetadata> {
    // Record metadata ONLY — never the secret (CR-2).
    this.state.credentials.push({
      appId,
      type: material.secret.type,
      scopeCount: material.scopes?.length ?? 0,
    });
    return Promise.resolve({
      id: randomUUID(),
      type: material.secret.type,
      scopes: [...(material.scopes ?? [])],
      lastRotatedAt: new Date(),
    });
  }
}

/**
 * Mirrors {@link ApprovedMappingRepository}'s SL-2 methods: the `active` mappings pinned
 * to a spec id (either side), and a spec-ids-only re-pin that leaves every other column
 * byte-identical.
 */
class FakeApprovedMappingRepo implements ApprovedMappingTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public listActiveBySpecId(specId: string): Promise<ApprovedMapping[]> {
    return Promise.resolve(
      [...this.store.approvedMappings.values()].filter(
        (mapping) =>
          mapping.status === "active" &&
          (mapping.sourceSpecId === specId || mapping.targetSpecId === specId),
      ),
    );
  }
  public repinSpecs(
    id: string,
    sourceSpecId: string,
    targetSpecId: string,
  ): Promise<ApprovedMapping | undefined> {
    const existing = this.store.approvedMappings.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    // Only the pinned spec ids change — every other column stays byte-identical (SL-2.2).
    const updated: ApprovedMapping = { ...existing, sourceSpecId, targetSpecId };
    this.store.approvedMappings.set(id, updated);
    return Promise.resolve(updated);
  }
  public markStale(id: string): Promise<ApprovedMapping | undefined> {
    const existing = this.store.approvedMappings.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    // Only `status` changes — the pinned spec ids, counterpart, and children are untouched
    // (SL-4.2/4.3: a stale mapping stays pinned to its reviewed/superseded version).
    const updated: ApprovedMapping = { ...existing, status: "stale" };
    this.store.approvedMappings.set(id, updated);
    return Promise.resolve(updated);
  }
}

/** Mirrors {@link MappingArtifactsRepository}'s SL-4 reads: a mapping's approved field/operation children. */
class FakeMappingArtifactsRepo implements MappingArtifactsTxReader {
  public constructor(private readonly store: InMemoryStore) {}
  public listFieldMappings(mappingId: string): Promise<FieldMapping[]> {
    return Promise.resolve(this.store.fieldMappings.filter((f) => f.mappingId === mappingId));
  }
  public listOperationMappings(mappingId: string): Promise<OperationMapping[]> {
    return Promise.resolve(this.store.operationMappings.filter((o) => o.mappingId === mappingId));
  }
}

/**
 * Mirrors {@link DownstreamArtifactRepository}'s by-mapping reads: adapter bindings (SL-4.6
 * coupled cache drop) and `SyncRule`s (SL-5.2 `pollOperationRef` re-validation).
 */
class FakeDownstreamArtifactRepo implements DownstreamArtifactTxReader {
  public constructor(private readonly store: InMemoryStore) {}
  public listAdapterBindingsByMapping(mappingId: string): Promise<AdapterBinding[]> {
    return Promise.resolve(
      this.store.adapterBindings.filter((b) => b.approvedMappingId === mappingId),
    );
  }
  public listSyncRulesByMapping(approvedMappingId: string): Promise<SyncRule[]> {
    return Promise.resolve(
      [...this.store.syncRules.values()].filter(
        (rule) => rule.approvedMappingId === approvedMappingId,
      ),
    );
  }
}

/**
 * SL-5.2 — mirrors {@link SyncRuleRepository.clearPollOperationRef}: returns a rule's
 * `pollOperationRef` to unconfirmed (an absent domain key). Only that field moves — the
 * cursor/snapshot stay (the re-confirm is a separate human action).
 */
class FakeSyncRuleRepo implements SyncRuleTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public clearPollOperationRef(id: string): Promise<void> {
    const existing = this.store.syncRules.get(id);
    if (existing !== undefined) {
      // The real repo NULLs the column, which the mapper reads back as an absent key.
      const next = { ...existing };
      delete next.pollOperationRef;
      this.store.syncRules.set(id, next);
    }
    return Promise.resolve();
  }
}

/**
 * SL-5.1/5.3 — a faithful {@link ScopeRevalidationTxService} fake that runs the **real**
 * `@mediator/ir` pure re-validation policy over the in-memory store and persists its
 * consequence, so a unit test proves the wiring end to end (a broken ref returned to
 * unconfirmed but RETAINED, a correspondence returned to unconfirmed) without a live
 * Postgres. The real archiving of `ScopeLink`s is proven against the DB in the integration
 * spec; here only the correspondence write + the archive-scope intent are recorded.
 */
class FakeScopeLifecycle implements ScopeRevalidationTxService {
  public constructor(private readonly store: InMemoryStore) {}

  public revalidateSpecBindings(specId: string, newIr: Ir): Promise<SpecScopeRevalidationResult> {
    this.store.bindingRevalidations.push(specId);
    const findings: SpecScopeRevalidationResult["findings"][number][] = [];
    const bindings: ResourceBinding[] = [];
    for (const binding of this.store.bindings.values()) {
      if (binding.apiSpecId !== specId) continue;
      const revalidation = revalidateResourceBinding(binding, newIr);
      findings.push(...revalidation.findings);
      // Retain-in-place (the SS-16 replaceRevalidated semantics), never drop.
      this.store.bindings.set(binding.id, revalidation.binding);
      bindings.push(revalidation.binding);
    }
    return Promise.resolve({ findings, bindings });
  }

  public revalidateCorrespondence(
    correspondence: ScopeCorrespondence,
    source: ScopeCorrespondenceSide,
    target: ScopeCorrespondenceSide,
  ): Promise<CorrespondenceRevalidationResult> {
    const revalidation = revalidateScopeCorrespondence({ correspondence, source, target });
    // Approximate the archived-link count by the pure archive scope (the real service reads
    // the live links; the unit test asserts only the call + the correspondence unconfirmed).
    const archivedScopeLinks =
      revalidation.archiveScopeLinks === "none" ? 0 : revalidation.findings.length;
    if (revalidation.findings.length > 0) {
      this.store.scopeCorrespondences.set(
        revalidation.correspondence.resourcePairRef,
        revalidation.correspondence,
      );
    }
    this.store.correspondenceRevalidations.push({
      correspondenceId: correspondence.id,
      archivedScopeLinks,
    });
    return Promise.resolve({
      findings: revalidation.findings,
      correspondence: revalidation.correspondence,
      archivedScopeLinks,
    });
  }
}

/** Records the GR-2/GR-3 edge recomputes the breaking reaction requested (no real projection here). */
class FakeGraphRecompute implements GraphEdgeRecompute {
  public constructor(private readonly store: InMemoryStore) {}
  public recomputeSyncEdge(sourceAppId: string, targetAppId: string): Promise<void> {
    this.store.graphRecomputes.push({ type: "sync", sourceAppId, targetAppId });
    return Promise.resolve();
  }
  public recomputeAdapterEdge(consumerAppId: string, backendAppId: string): Promise<void> {
    this.store.graphRecomputes.push({
      type: "adapter-dependency",
      sourceAppId: consumerAppId,
      targetAppId: backendAppId,
    });
    return Promise.resolve();
  }
}

/** Records the XI-2 by-endpoint cache drops the breaking reaction requested (spy surface). */
class FakeEndpointCacheInvalidator implements EndpointCacheInvalidator {
  public constructor(private readonly store: InMemoryStore) {}
  public invalidateEndpoint(endpointId: string): void {
    if (this.store.failCacheInvalidation) {
      // XI-2.5 — the reaction's `invalidateEndpointSafely` must swallow this so the
      // stale transition still commits (a missed drop only costs a spurious hit).
      throw new Error("simulated cache-drop failure");
    }
    this.store.cacheInvalidations.push(endpointId);
  }
}

class FakeAuditRepo implements AuditTxRepo {
  public constructor(private readonly store: InMemoryStore) {}
  public insert(entry: AuditLogEntry): Promise<void> {
    this.store.auditLog.push(entry);
    return Promise.resolve();
  }
}

/**
 * Mirrors {@link DetectionJobRepository}'s enqueue/collapse-resolution semantics at the
 * port level, so the SL-9 branches a test drives here match the real repository
 * ([[fakes-must-mirror-real-repos]]):
 *
 * - `enqueueScoped` inserts and returns `true` **only** when no un-finished job blocks
 *   the spec — mirroring `ON CONFLICT DO NOTHING … RETURNING` against the partial UNIQUE
 *   index — and returns `false` (recording nothing) when one does;
 * - `lockUnfinishedJob` returns that blocking job (the real one additionally takes a
 *   `FOR UPDATE` row lock, which has no in-memory analogue);
 * - `updateScope` rewrites the blocking job's frozen descriptor in place.
 */
class FakeDetectionJobRepo implements DetectionJobTxRepo {
  public constructor(private readonly store: InMemoryStore) {}

  public enqueueScoped(apiSpecId: string, scope: DetectionJobScope): Promise<boolean> {
    if (this.store.unfinishedDetectionJob?.apiSpecId === apiSpecId) {
      return Promise.resolve(false);
    }
    this.store.scopedDetectionJobs.push({ apiSpecId, scope });
    return Promise.resolve(true);
  }

  public lockUnfinishedJob(apiSpecId: string): Promise<UnfinishedDetectionJob | undefined> {
    const blocking = this.store.unfinishedDetectionJob;
    if (blocking === undefined || blocking.apiSpecId !== apiSpecId) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ id: blocking.id, status: blocking.status, scope: blocking.scope });
  }

  public updateScope(id: string, scope: DetectionJobScope): Promise<void> {
    const blocking = this.store.unfinishedDetectionJob;
    if (blocking !== undefined && blocking.id === id) {
      blocking.scope = scope;
    }
    return Promise.resolve();
  }
}

/**
 * A {@link UnitOfWork} over the in-memory {@link InMemoryStore}. On a thrown
 * error it restores a snapshot taken before `work` ran, mimicking a transaction
 * rollback so atomicity (AR-1 crit 7) is unit-testable.
 */
export class FakeUnitOfWork implements UnitOfWork {
  public constructor(private readonly store: InMemoryStore) {}

  public async run<T>(work: (stores: TxStores) => Promise<T>): Promise<T> {
    const snapshot = {
      apps: new Map(this.store.apps),
      specs: new Map(this.store.specs),
      bindings: new Map(this.store.bindings),
      credentials: [...this.store.credentials],
      events: [...this.store.events],
      approvedMappings: new Map(this.store.approvedMappings),
      auditLog: [...this.store.auditLog],
      scopedDetectionJobs: [...this.store.scopedDetectionJobs],
      // SL-9 — copied by value: a resolved collapse mutates this row's `scope` in place,
      // and a rolled-back transaction must un-mutate it.
      unfinishedDetectionJob:
        this.store.unfinishedDetectionJob === undefined
          ? undefined
          : { ...this.store.unfinishedDetectionJob },
      fieldMappings: [...this.store.fieldMappings],
      operationMappings: [...this.store.operationMappings],
      adapterBindings: [...this.store.adapterBindings],
      graphRecomputes: [...this.store.graphRecomputes],
      cacheInvalidations: [...this.store.cacheInvalidations],
      syncRules: new Map(this.store.syncRules),
      scopeCorrespondences: new Map(this.store.scopeCorrespondences),
      bindingRevalidations: [...this.store.bindingRevalidations],
      correspondenceRevalidations: [...this.store.correspondenceRevalidations],
    };
    const stores: TxStores = {
      registeredApps: new FakeAppRepo(this.store),
      apiSpecs: new FakeSpecRepo(this.store),
      resourceBindings: new FakeBindingRepo(this.store),
      credentialStore: new FakeCredentialStore(this.store),
      approvedMappings: new FakeApprovedMappingRepo(this.store),
      audit: new FakeAuditRepo(this.store),
      detectionJobs: new FakeDetectionJobRepo(this.store),
      mappingArtifacts: new FakeMappingArtifactsRepo(this.store),
      downstreamArtifacts: new FakeDownstreamArtifactRepo(this.store),
      graph: new FakeGraphRecompute(this.store),
      cacheInvalidator: new FakeEndpointCacheInvalidator(this.store),
      syncRules: new FakeSyncRuleRepo(this.store),
      scopeCorrespondences: new FakeScopeCorrespondenceRepo(this.store),
      scopeLifecycle: new FakeScopeLifecycle(this.store),
      emit: (event) => {
        this.store.events.push(event);
        return Promise.resolve();
      },
    };
    try {
      return await work(stores);
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  #restore(snapshot: {
    apps: Map<string, RegisteredApp>;
    specs: Map<string, ApiSpec>;
    bindings: Map<string, ResourceBinding>;
    credentials: RecordedCredential[];
    events: DomainEventEnvelope[];
    approvedMappings: Map<string, ApprovedMapping>;
    auditLog: AuditLogEntry[];
    scopedDetectionJobs: { readonly apiSpecId: string; readonly scope: DetectionJobScope }[];
    unfinishedDetectionJob: InMemoryStore["unfinishedDetectionJob"];
    fieldMappings: FieldMapping[];
    operationMappings: OperationMapping[];
    adapterBindings: AdapterBinding[];
    graphRecomputes: InMemoryStore["graphRecomputes"][number][];
    cacheInvalidations: string[];
    syncRules: Map<string, SyncRule>;
    scopeCorrespondences: Map<string, ScopeCorrespondence>;
    bindingRevalidations: string[];
    correspondenceRevalidations: InMemoryStore["correspondenceRevalidations"][number][];
  }): void {
    replaceMap(this.store.apps, snapshot.apps);
    replaceMap(this.store.specs, snapshot.specs);
    replaceMap(this.store.bindings, snapshot.bindings);
    replaceArray(this.store.credentials, snapshot.credentials);
    replaceArray(this.store.events, snapshot.events);
    replaceMap(this.store.approvedMappings, snapshot.approvedMappings);
    replaceArray(this.store.auditLog, snapshot.auditLog);
    replaceArray(this.store.scopedDetectionJobs, snapshot.scopedDetectionJobs);
    this.store.unfinishedDetectionJob = snapshot.unfinishedDetectionJob;
    replaceArray(this.store.fieldMappings, snapshot.fieldMappings);
    replaceArray(this.store.operationMappings, snapshot.operationMappings);
    replaceArray(this.store.adapterBindings, snapshot.adapterBindings);
    replaceArray(this.store.graphRecomputes, snapshot.graphRecomputes);
    replaceArray(this.store.cacheInvalidations, snapshot.cacheInvalidations);
    replaceMap(this.store.syncRules, snapshot.syncRules);
    replaceMap(this.store.scopeCorrespondences, snapshot.scopeCorrespondences);
    replaceArray(this.store.bindingRevalidations, snapshot.bindingRevalidations);
    replaceArray(this.store.correspondenceRevalidations, snapshot.correspondenceRevalidations);
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function replaceArray<T>(target: T[], source: readonly T[]): void {
  target.length = 0;
  target.push(...source);
}

/** A built test server + handles for asserting on the fake persistence. */
export interface TestServer {
  readonly app: FastifyInstance;
  readonly store: InMemoryStore;
  /**
   * The Phase-3 approval state (proposals/items/specs/approved mappings/audit/
   * events) the RA routes read and mutate. Seed it with `seedSpec`/`seedProposal`/
   * `seedApprovedMapping` and assert on its maps — it is a **separate** store from
   * {@link InMemoryStore} (which backs the Phase-1/2 routes).
   */
  readonly approval: FakeApprovalPersistence;
}

/**
 * Build a Fastify instance with the real operator API + error handler wired over
 * in-memory fakes and the real `SpecRegistry`/services and `buildIr`. The real
 * authentication hook and role guards (OA-1/OA-2) are installed, seeded with the
 * shared {@link TEST_OPERATOR_ACCOUNTS}, so requests must present an identity via
 * the `auth.testkit` header helpers. Call `app.inject(...)` to drive routes;
 * assert on `store` for persistence effects.
 */
export function buildTestServer(
  defaultPollInterval = 300000,
  approvalOptions: ApprovalApiTestOptions = {},
): TestServer {
  const store = new InMemoryStore();
  const unitOfWork = new FakeUnitOfWork(store);
  const specRegistry = new SpecRegistry();
  const readers = {
    appReader: new FakeAppRepo(store),
    specReader: new FakeSpecRepo(store),
    bindingReader: new FakeBindingRepo(store),
  };

  // The Phase-3 RA slice runs over its own in-memory approval store, seeded and
  // asserted on via the returned `approval` handle. Its LLM escape hatch is driven
  // by a `FakeProvider` (no live model).
  const approval = new FakeApprovalPersistence();
  const approvalDeps = buildApprovalApiDeps(approval, approvalOptions);

  const app = Fastify({ logger: false });
  registerAuthenticatedOperatorApi(
    app,
    {
      registrar: new RegistrationService({ unitOfWork, specRegistry, defaultPollInterval }),
      bindingConfirmer: new ResourceBindingService({ unitOfWork }),
      // SS-18.4 — over the same in-memory store, so seeding a `ScopeCorrespondence`
      // makes `scope-link` selectable on the bindings DTO exactly as in production.
      scopeLinkAuthoring: new ScopeLinkAuthoringResolver({
        correspondences: new FakeScopeCorrespondenceRepo(store),
        repos: { apiSpecs: readers.specReader, resourceBindings: readers.bindingReader },
      }),
      exclusionsReplacer: new AnalysisExclusionsService({ unitOfWork }),
      appReader: readers.appReader,
      specReader: readers.specReader,
      bindingReader: readers.bindingReader,
      proposalReadService: approvalDeps.proposalReadService,
      approvalService: approvalDeps.approvalService,
      escapeHatchService: approvalDeps.escapeHatchService,
    },
    new LocalAccountsAuthProvider(TEST_OPERATOR_ACCOUNTS),
  );
  registerErrorHandler(app);

  return { app, store, approval };
}
