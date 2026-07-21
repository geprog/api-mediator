import { randomUUID } from "node:crypto";

import { resolveRequest } from "@mediator/adapter-engine";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  EventOutboxRepository,
  MappingArtifactsRepository,
  ProcessedEventRepository,
  RegisteredAppRepository,
  adapterBinding,
  adapterEndpoint,
  apiSpec,
  approvedMapping,
  createDb,
  eventOutbox,
  graphEdge,
  processedEvent,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  syncRule,
  tx,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type { ApiSpec, ApprovedMapping, OperationMapping, RegisteredApp } from "@mediator/domain";
import {
  ConsumerRegistry,
  OutboxDispatcher,
  PostgresEventBus,
  ReconciliationSweep,
  createMappingApproved,
} from "@mediator/event-bus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildArtifactInstantiation } from "./modules/artifact-instantiation/background.js";

/**
 * Live-Postgres integration test for Phase-5 CO-1 — deriving `AdapterEndpoint`s from
 * `MappingApproved` for a consumer-provider mapping and auto-activating the first
 * binding. Excluded from `pnpm verify`; run with
 * `pnpm --filter @mediator/backend test:integration`. Self-skips when `DATABASE_URL`
 * is unresolvable; the only external dependency is the database.
 *
 * It proves, against the real `DownstreamArtifactRepository` and the shared outbox
 * dispatcher, the crux of CO-1: a first backend makes the endpoint LIVE (CO-1.2), a
 * second backend never silently changes what is served (CO-1.3 — the endpoint goes
 * `composition-required` while its prior active binding keeps serving), redelivery is
 * idempotent (CO-1.6), and the reconciliation sweep re-derives a lost one (CO-1.7).
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const CONSUMER_APP = randomUUID();
const CONSUMER_SPEC = randomUUID();
const BACKEND1_APP = randomUUID();
const BACKEND1_SPEC = randomUUID();
const BACKEND2_APP = randomUUID();
const BACKEND2_SPEC = randomUUID();
const MAPPING_1 = randomUUID(); // consumer -> backend1, searchIssues -> listIssues
const MAPPING_2 = randomUUID(); // consumer -> backend2, searchIssues -> listTickets (2nd backend)

// A second, independent landscape whose reaction is "lost" (no event) → the sweep.
const LOST_CONSUMER_APP = randomUUID();
const LOST_CONSUMER_SPEC = randomUUID();
const LOST_BACKEND_APP = randomUUID();
const LOST_BACKEND_SPEC = randomUUID();
const LOST_MAPPING = randomUUID(); // approved, but never got a MappingApproved

const CONSUMER_OP = "search/searchIssues";
const CREATED_AT = new Date("2026-07-21T00:00:00.000Z");

function appOf(id: string, name: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  };
}
function specOf(id: string, appId: string, role: ApiSpec["role"]): ApiSpec {
  return {
    id,
    appId,
    role,
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function consumerProviderMappingOf(input: {
  readonly id: string;
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
}): ApprovedMapping {
  return {
    ...input,
    variant: "consumer-provider",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}
function opMappingOf(
  mappingId: string,
  sourceOperationRef: string,
  targetOperationRef: string,
): OperationMapping {
  return { id: randomUUID(), mappingId, sourceOperationRef, targetOperationRef, action: "read" };
}

suite("Phase-5 CO-1 adapter-endpoint derivation integration (requires Postgres)", () => {
  let db: Database;
  let dispatcher: OutboxDispatcher<DbTransaction>;
  let sweep: ReconciliationSweep;
  let artifacts: DownstreamArtifactRepository;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);

    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await db.delete(eventOutbox);
    await db.delete(processedEvent);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(CONSUMER_APP, "consumer"));
      await apps.create(appOf(BACKEND1_APP, "backend-1"));
      await apps.create(appOf(BACKEND2_APP, "backend-2"));
      await apps.create(appOf(LOST_CONSUMER_APP, "lost-consumer"));
      await apps.create(appOf(LOST_BACKEND_APP, "lost-backend"));

      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(CONSUMER_SPEC, CONSUMER_APP, "CONSUMER"));
      await specs.create(specOf(BACKEND1_SPEC, BACKEND1_APP, "PROVIDER"));
      await specs.create(specOf(BACKEND2_SPEC, BACKEND2_APP, "PROVIDER"));
      await specs.create(specOf(LOST_CONSUMER_SPEC, LOST_CONSUMER_APP, "CONSUMER"));
      await specs.create(specOf(LOST_BACKEND_SPEC, LOST_BACKEND_APP, "PROVIDER"));

      const mappings = new ApprovedMappingRepository(txn);
      const artifactsRepo = new MappingArtifactsRepository(txn);

      // M1: consumer's searchIssues has ONE backend (backend1.listIssues) — the
      // zero-friction common case that auto-activates.
      await mappings.insert(
        consumerProviderMappingOf({
          id: MAPPING_1,
          sourceSpecId: CONSUMER_SPEC,
          targetSpecId: BACKEND1_SPEC,
          sourceAppId: CONSUMER_APP,
          targetAppId: BACKEND1_APP,
        }),
      );
      await artifactsRepo.replaceChildren(MAPPING_1, {
        fieldMappings: [],
        operationMappings: [opMappingOf(MAPPING_1, CONSUMER_OP, "issues/listIssues")],
        parameterMappings: [],
      });

      // M2: a SECOND backend (backend2.listTickets) for the SAME consumer op — a
      // distinct directional spec pair, so both mappings stay active.
      await mappings.insert(
        consumerProviderMappingOf({
          id: MAPPING_2,
          sourceSpecId: CONSUMER_SPEC,
          targetSpecId: BACKEND2_SPEC,
          sourceAppId: CONSUMER_APP,
          targetAppId: BACKEND2_APP,
        }),
      );
      await artifactsRepo.replaceChildren(MAPPING_2, {
        fieldMappings: [],
        operationMappings: [opMappingOf(MAPPING_2, CONSUMER_OP, "tickets/listTickets")],
        parameterMappings: [],
      });

      // LOST: approved, with an operation child, but no MappingApproved will be emitted.
      await mappings.insert(
        consumerProviderMappingOf({
          id: LOST_MAPPING,
          sourceSpecId: LOST_CONSUMER_SPEC,
          targetSpecId: LOST_BACKEND_SPEC,
          sourceAppId: LOST_CONSUMER_APP,
          targetAppId: LOST_BACKEND_APP,
        }),
      );
      await artifactsRepo.replaceChildren(LOST_MAPPING, {
        fieldMappings: [],
        operationMappings: [opMappingOf(LOST_MAPPING, "detail/getIssue", "issues/getIssue")],
        parameterMappings: [],
      });
    });

    const instantiation = buildArtifactInstantiation({ db });
    const registry = new ConsumerRegistry<DbTransaction>();
    registry.register(instantiation.consumer);
    dispatcher = new OutboxDispatcher<DbTransaction>(
      db,
      (txn) => new EventOutboxRepository(txn),
      (txn) => new ProcessedEventRepository(txn),
      registry,
    );
    sweep = new ReconciliationSweep();
    sweep.register(instantiation.reconciler);
    artifacts = new DownstreamArtifactRepository(db);
  });

  afterAll(async () => {
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(approvedMapping);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await db.delete(eventOutbox);
    await db.delete(processedEvent);
    await db.$client.end();
  });

  it("makes the endpoint LIVE on the first backend: active endpoint + active primary binding, safe defaults", async () => {
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: MAPPING_1, variant: "consumer-provider" }),
        txn,
      ),
    );
    expect(await dispatcher.runOnce()).toStrictEqual({ claimed: 1, published: 1, failed: 0 });

    const endpoint = await artifacts.getAdapterEndpoint(CONSUMER_APP, CONSUMER_OP);
    expect(endpoint?.status).toBe("active");
    expect(endpoint?.aggregationStrategy).toBe("single");
    expect(endpoint?.strictness).toBe("degraded");
    expect(endpoint?.cacheTtl).toBeUndefined(); // no caching

    const bindings = await artifacts.listAdapterBindingsByEndpoint(endpoint?.id ?? "");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe("active");
    expect(bindings[0]?.role).toBe("primary");
    expect(bindings[0]?.backendAppId).toBe(BACKEND1_APP);
    expect(bindings[0]?.backendOperationId).toBe("issues/listIssues"); // CO-1.4: target side
    expect(bindings[0]?.approvedMappingId).toBe(MAPPING_1);

    // CO-1.5: the adapter-dependency edge fired.
    expect(
      await artifacts.getGraphEdge(CONSUMER_APP, BACKEND1_APP, "adapter-dependency"),
    ).toBeDefined();
    // The point of CO-1: the runtime now resolves this endpoint to `serve`.
    if (endpoint !== undefined) {
      expect(resolveRequest({ endpoint, bindings }).kind).toBe("serve");
    }
    // Mutual exclusivity: no SyncRule for a consumer-provider mapping.
    expect(await artifacts.listSyncRulesByMapping(MAPPING_1)).toStrictEqual([]);
  });

  it("is idempotent under redelivery: no duplicate binding, endpoint stays active (never re-activated/reset)", async () => {
    const before = await artifacts.getAdapterEndpoint(CONSUMER_APP, CONSUMER_OP);
    const bindingsBefore = await artifacts.listAdapterBindingsByEndpoint(before?.id ?? "");

    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: MAPPING_1, variant: "consumer-provider" }),
        txn,
      ),
    );
    await dispatcher.runOnce();

    const after = await artifacts.getAdapterEndpoint(CONSUMER_APP, CONSUMER_OP);
    const bindingsAfter = await artifacts.listAdapterBindingsByEndpoint(after?.id ?? "");
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe("active");
    expect(bindingsAfter.map((b) => b.id).sort()).toStrictEqual(
      bindingsBefore.map((b) => b.id).sort(),
    );
    expect(bindingsAfter).toHaveLength(1);
    expect(bindingsAfter[0]?.status).toBe("active");
  });

  it("a SECOND backend never silently changes what is served: endpoint composition-required, prior binding keeps serving", async () => {
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: MAPPING_2, variant: "consumer-provider" }),
        txn,
      ),
    );
    await dispatcher.runOnce();

    const endpoint = await artifacts.getAdapterEndpoint(CONSUMER_APP, CONSUMER_OP);
    // The endpoint now needs a human composition decision…
    expect(endpoint?.status).toBe("composition-required");

    const bindings = await artifacts.listAdapterBindingsByEndpoint(endpoint?.id ?? "");
    expect(bindings).toHaveLength(2);
    const byMapping = new Map(bindings.map((b) => [b.approvedMappingId, b]));
    // …the prior active binding is untouched (still active/primary)…
    expect(byMapping.get(MAPPING_1)?.status).toBe("active");
    expect(byMapping.get(MAPPING_1)?.role).toBe("primary");
    // …and the new one is merely proposed.
    expect(byMapping.get(MAPPING_2)?.status).toBe("proposed");
    expect(byMapping.get(MAPPING_2)?.backendOperationId).toBe("tickets/listTickets");

    // The invariant, proven through the resolver: it STILL serves, via binding-1 only.
    if (endpoint !== undefined) {
      const outcome = resolveRequest({ endpoint, bindings });
      expect(outcome.kind).toBe("serve");
      if (outcome.kind === "serve") {
        expect(outcome.activeBindings.map((b) => b.approvedMappingId)).toStrictEqual([MAPPING_1]);
      }
    }
  });

  it("the reconciliation sweep re-derives a lost consumer-provider mapping into a live endpoint (CO-1.7)", async () => {
    // Only the lost mapping has no artifacts (M1/M2 have bindings).
    expect(await artifacts.listActiveMappingIdsWithoutArtifacts()).toStrictEqual([LOST_MAPPING]);

    expect((await sweep.runSweep()).outcomes).toStrictEqual([
      { name: "mapping-artifact-instantiation", status: "ok" },
    ]);

    const endpoint = await artifacts.getAdapterEndpoint(LOST_CONSUMER_APP, "detail/getIssue");
    expect(endpoint?.status).toBe("active");
    const bindings = await artifacts.listAdapterBindingsByEndpoint(endpoint?.id ?? "");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.status).toBe("active");
    expect(bindings[0]?.backendOperationId).toBe("issues/getIssue");
    expect(await artifacts.listActiveMappingIdsWithoutArtifacts()).toStrictEqual([]);

    // Idempotent re-sweep: no second binding, endpoint stays active.
    await sweep.runSweep();
    const reBindings = await artifacts.listAdapterBindingsByEndpoint(endpoint?.id ?? "");
    expect(reBindings).toHaveLength(1);
    expect((await artifacts.getAdapterEndpoint(LOST_CONSUMER_APP, "detail/getIssue"))?.status).toBe(
      "active",
    );
  });
});
