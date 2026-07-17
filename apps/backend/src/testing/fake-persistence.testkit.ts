import { randomUUID } from "node:crypto";

import { RESOURCE_BINDING_REF_KINDS } from "@mediator/contracts";
import type { CredentialMaterial } from "@mediator/credentials";
import type {
  CredentialMetadata,
  ResourceBindingRefPatch,
  ScopePathBindingPatch,
  SourceScopeRefPatch,
} from "@mediator/db";
import type {
  ApiSpec,
  DomainEventEnvelope,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";

import { AnalysisExclusionsService } from "../modules/analysis-exclusions.js";
import { FakeApprovalPersistence } from "../modules/approval/approval.testkit.js";
import type {
  AppReader,
  AppTxRepo,
  BindingReader,
  BindingTxRepo,
  CredentialTxStore,
  SpecReader,
  SpecTxRepo,
  TxStores,
  UnitOfWork,
} from "../modules/persistence.js";
import { RegistrationService } from "../modules/registration.js";
import { ResourceBindingService } from "../modules/resource-bindings.js";
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
    // Mirror ResourceBindingRepository.updateScopePathBinding exactly: rewrite
    // only the entry whose parameterName matches (per-parameter — SS-3.2),
    // leaving every sibling scope entry AND all operational refs untouched; when
    // no entry matches, write nothing and return the binding unchanged.
    const scope = existing.scopePathBindings ?? [];
    if (!scope.some((entry) => entry.parameterName === patch.parameterName)) {
      return Promise.resolve(existing);
    }
    const nextScope = scope.map((entry) =>
      entry.parameterName === patch.parameterName
        ? {
            ...entry,
            value: patch.value,
            confirmedBy: patch.confirmedBy,
            confirmedAt: patch.confirmedAt,
          }
        : entry,
    );
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
    };
    const stores: TxStores = {
      registeredApps: new FakeAppRepo(this.store),
      apiSpecs: new FakeSpecRepo(this.store),
      resourceBindings: new FakeBindingRepo(this.store),
      credentialStore: new FakeCredentialStore(this.store),
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
  }): void {
    replaceMap(this.store.apps, snapshot.apps);
    replaceMap(this.store.specs, snapshot.specs);
    replaceMap(this.store.bindings, snapshot.bindings);
    replaceArray(this.store.credentials, snapshot.credentials);
    replaceArray(this.store.events, snapshot.events);
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
