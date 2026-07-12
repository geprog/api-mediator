import { randomUUID } from "node:crypto";

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
import type { ApiSpec, ApprovedMapping, RegisteredApp } from "@mediator/domain";
import {
  ConsumerRegistry,
  OutboxDispatcher,
  PostgresEventBus,
  ReconciliationSweep,
  createMappingApproved,
} from "@mediator/event-bus";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildArtifactInstantiation } from "./modules/artifact-instantiation/background.js";
import { canonicalResourcePairRef } from "./modules/artifact-instantiation/derive.js";

/**
 * End-to-end integration test for the Phase-3 `MappingApproved` reaction
 * (AI-1..AI-3) against a live Postgres. Excluded from `pnpm verify`; run with
 * `pnpm --filter @mediator/backend test:integration`. Self-skips when
 * `DATABASE_URL` is unresolvable; the only external dependency is the database
 * (no LLM, no network).
 *
 * It proves the crux of AI-3: on `MappingApproved`, the SINGLE shared outbox
 * dispatcher delivers the event to the artifact-instantiation consumer, which
 * instantiates the approval's disabled artifacts **inside the dispatcher
 * transaction** (pure DB, no offload); a redelivery is deduped to one committed
 * set; and the reconciler re-derives a mapping whose reaction never happened.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_A = randomUUID();
const APP_B = randomUUID();
const SPEC_A = randomUUID();
const SPEC_B = randomUUID();
const PEER_MAPPING = randomUUID();
const LOST_MAPPING = randomUUID(); // approved, but its reaction was "lost" (no event)
const CREATED_AT = new Date("2026-07-12T00:00:00.000Z");

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
function specOf(id: string, appId: string): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [],
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: CREATED_AT,
  };
}
function peerMappingOf(input: {
  readonly id: string;
  readonly sourceSpecId: string;
  readonly targetSpecId: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
}): ApprovedMapping {
  return {
    ...input,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

suite("Phase-3 artifact-instantiation integration (requires Postgres)", () => {
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
      await apps.create(appOf(APP_A, "prov-a"));
      await apps.create(appOf(APP_B, "prov-b"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A, APP_A));
      await specs.create(specOf(SPEC_B, APP_B));
      const mappings = new ApprovedMappingRepository(txn);
      // A peer-peer mapping (A→B) covering two resource pairs.
      await mappings.insert(
        peerMappingOf({
          id: PEER_MAPPING,
          sourceSpecId: SPEC_A,
          targetSpecId: SPEC_B,
          sourceAppId: APP_A,
          targetAppId: APP_B,
        }),
      );
      await new MappingArtifactsRepository(txn).replaceChildren(PEER_MAPPING, {
        fieldMappings: [
          fieldOf(PEER_MAPPING, "issues/title", "tasks/title"),
          fieldOf(PEER_MAPPING, "users/email", "members/email"),
        ],
        operationMappings: [],
        parameterMappings: [],
      });
      // The counterpart mapping (B→A) whose reaction was "lost" — no MappingApproved
      // emitted. A distinct directional spec pair (does not collide on the
      // active-direction unique index).
      await mappings.insert(
        peerMappingOf({
          id: LOST_MAPPING,
          sourceSpecId: SPEC_B,
          targetSpecId: SPEC_A,
          sourceAppId: APP_B,
          targetAppId: APP_A,
        }),
      );
      await new MappingArtifactsRepository(txn).replaceChildren(LOST_MAPPING, {
        fieldMappings: [fieldOf(LOST_MAPPING, "tasks/title", "issues/title")],
        operationMappings: [],
        parameterMappings: [],
      });
    });

    // The single shared outbox dispatcher, with ONLY the artifact-instantiation
    // consumer registered (this suite emits no other event types).
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

  it("a dispatcher pass instantiates the disabled artifacts inside the dispatcher tx", async () => {
    // Emit MappingApproved on the transactional outbox.
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: PEER_MAPPING, variant: "peer-peer" }),
        txn,
      ),
    );

    const result = await dispatcher.runOnce();
    expect(result).toStrictEqual({ claimed: 1, published: 1, failed: 0 });

    // Two disabled SyncRules (one per resource pair) + a sync GraphEdge.
    const rules = await artifacts.listSyncRulesByMapping(PEER_MAPPING);
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.status === "disabled")).toBe(true);
    expect(rules.map((rule) => rule.resourcePairRef).sort()).toStrictEqual(
      [
        canonicalResourcePairRef(
          { appId: APP_A, resourceRef: "issues" },
          { appId: APP_B, resourceRef: "tasks" },
        ),
        canonicalResourcePairRef(
          { appId: APP_A, resourceRef: "users" },
          { appId: APP_B, resourceRef: "members" },
        ),
      ].sort(),
    );
    const edge = await artifacts.getGraphEdge(APP_A, APP_B, "sync");
    expect(edge?.status).toBe("disabled");
    // Nothing executes: no polling started, no outbound call — only rows exist.
    expect(await artifacts.listAdapterBindingsByMapping(PEER_MAPPING)).toStrictEqual([]);
  });

  it("is idempotent under redelivery: re-emitting or re-dispatching produces no duplicates", async () => {
    const rulesBefore = await artifacts.listSyncRulesByMapping(PEER_MAPPING);
    const ruleIds = rulesBefore.map((rule) => rule.id).sort();

    // Redelivery of a NEW MappingApproved event for the SAME mapping (an incremental
    // re-approval with no new coverage): the natural-key upserts keep the set at two.
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: PEER_MAPPING, variant: "peer-peer" }),
        txn,
      ),
    );
    await dispatcher.runOnce();

    const rulesAfter = await artifacts.listSyncRulesByMapping(PEER_MAPPING);
    expect(rulesAfter.map((rule) => rule.id).sort()).toStrictEqual(ruleIds); // unchanged
  });

  it("the reconciler re-triggers a mapping whose reaction was lost, and leaves instantiated ones alone", async () => {
    // LOST_MAPPING was approved but never got a MappingApproved → no artifacts.
    const missingBefore = await artifacts.listActiveMappingIdsWithoutArtifacts();
    expect(missingBefore).toStrictEqual([LOST_MAPPING]);

    const sweepResult = await sweep.runSweep();
    expect(sweepResult.outcomes).toStrictEqual([
      { name: "mapping-artifact-instantiation", status: "ok" },
    ]);

    // LOST_MAPPING now has its rule; PEER_MAPPING was not re-touched.
    const lostRules = await artifacts.listSyncRulesByMapping(LOST_MAPPING);
    expect(lostRules).toHaveLength(1);
    expect(await artifacts.listActiveMappingIdsWithoutArtifacts()).toStrictEqual([]);

    // Idempotent re-sweep: nothing new.
    await sweep.runSweep();
    expect(await artifacts.listSyncRulesByMapping(LOST_MAPPING)).toHaveLength(1);
  });
});

function fieldOf(
  mappingId: string,
  sourcePath: string,
  targetPath: string,
): {
  id: string;
  mappingId: string;
  sourcePath: string;
  targetPath: string;
  transform: "rename";
} {
  return { id: randomUUID(), mappingId, sourcePath, targetPath, transform: "rename" };
}
