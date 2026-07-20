import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  EventOutboxRepository,
  MappingArtifactsRepository,
  ProcessedEventRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
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
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  scopeCorrespondence,
  syncRule,
  tx,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  Ir,
  RegisteredApp,
  ResourceBinding,
} from "@mediator/domain";
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

// ── SS-18 scoped-pair landscape (Gitea `issues` -> Vikunja `tasks`) ───────────
const SCOPED_SOURCE_APP = randomUUID();
const SCOPED_TARGET_APP = randomUUID();
const SCOPED_SOURCE_SPEC = randomUUID();
const SCOPED_TARGET_SPEC = randomUUID();
const SCOPED_MAPPING = randomUUID();
const SCOPED_PAIR_REF = canonicalResourcePairRef(
  { appId: SCOPED_SOURCE_APP, resourceRef: "issues" },
  { appId: SCOPED_TARGET_APP, resourceRef: "tasks" },
);

/** The source spec's IR: a scoped `issues` record resource + an enumerable `repos` container. */
const SCOPED_SOURCE_IR: Ir = [
  { resourceRef: "issues", name: "issues", operations: [], schemas: [], crossResourceRefs: [] },
  {
    resourceRef: "repos",
    name: "repos",
    operations: [
      {
        operationId: "repos_list",
        method: "get",
        path: "/repos",
        parameters: [],
        responseSchema: {
          name: "Repository",
          fields: [
            { name: "id", type: "integer", required: true },
            { name: "name", type: "string", required: true },
          ],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

/** The target spec's IR: `PUT /projects/{id}/tasks` — `{id}` is the CONTAINER, not the record id. */
const SCOPED_TARGET_IR: Ir = [
  {
    resourceRef: "tasks",
    name: "tasks",
    operations: [
      {
        operationId: "tasks_create",
        method: "put",
        path: "/projects/{id}/tasks",
        parameters: [{ name: "id", location: "path", required: true, type: "integer" }],
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
  {
    resourceRef: "projects",
    name: "projects",
    operations: [
      {
        operationId: "projects_list",
        method: "get",
        path: "/projects",
        parameters: [],
        responseSchema: {
          name: "Project",
          fields: [
            { name: "id", type: "integer", required: true },
            { name: "title", type: "string", required: true },
          ],
        },
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  },
];

function bindingOf(
  overrides: Partial<ResourceBinding> & { apiSpecId: string; resourceRef: string },
): ResourceBinding {
  return { id: randomUUID(), ...overrides };
}

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
function specOf(id: string, appId: string, parsedIR: Ir = []): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR,
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
  let correspondences: ScopeCorrespondenceRepository;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);

    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(scopeCorrespondence);
    await db.delete(approvedMapping);
    await db.delete(resourceBindingRef);
    await db.delete(resourceBinding);
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

      // ── SS-18: a genuinely SCOPED pair, with the IR + bindings the derivation reads ──
      await apps.create(appOf(SCOPED_SOURCE_APP, "scoped-source"));
      await apps.create(appOf(SCOPED_TARGET_APP, "scoped-target"));
      await specs.create(specOf(SCOPED_SOURCE_SPEC, SCOPED_SOURCE_APP, SCOPED_SOURCE_IR));
      await specs.create(specOf(SCOPED_TARGET_SPEC, SCOPED_TARGET_APP, SCOPED_TARGET_IR));

      const bindings = new ResourceBindingRepository(txn);
      await bindings.createMany([
        // The source record resource captures its container (SS-7), derived-unconfirmed.
        bindingOf({
          apiSpecId: SCOPED_SOURCE_SPEC,
          resourceRef: "issues",
          sourceScopeRef: {
            components: [{ key: "name", fieldPath: "repository.name" }],
            confirmedBy: null,
            confirmedAt: null,
          },
        }),
        // The source container IS enumerable (a derived collection read) -> sourceContainerRef.
        bindingOf({
          apiSpecId: SCOPED_SOURCE_SPEC,
          resourceRef: "repos",
          nativeIdRef: {
            value: { kind: "field", path: "id" },
            confirmedBy: null,
            confirmedAt: null,
          },
          collectionReadRef: {
            value: { kind: "operation", operationId: "repos_list" },
            confirmedBy: null,
            confirmedAt: null,
          },
        }),
        // The target record resource with its SS-2-derived, unconfirmed `{id}` scope entry.
        bindingOf({
          apiSpecId: SCOPED_TARGET_SPEC,
          resourceRef: "tasks",
          scopePathBindings: [
            {
              kind: "constant",
              parameterName: "id",
              value: "",
              confirmedBy: null,
              confirmedAt: null,
            },
          ],
        }),
        bindingOf({
          apiSpecId: SCOPED_TARGET_SPEC,
          resourceRef: "projects",
          nativeIdRef: {
            value: { kind: "field", path: "id" },
            confirmedBy: null,
            confirmedAt: null,
          },
          collectionReadRef: {
            value: { kind: "operation", operationId: "projects_list" },
            confirmedBy: null,
            confirmedAt: null,
          },
        }),
      ]);

      await mappings.insert(
        peerMappingOf({
          id: SCOPED_MAPPING,
          sourceSpecId: SCOPED_SOURCE_SPEC,
          targetSpecId: SCOPED_TARGET_SPEC,
          sourceAppId: SCOPED_SOURCE_APP,
          targetAppId: SCOPED_TARGET_APP,
        }),
      );
      await new MappingArtifactsRepository(txn).replaceChildren(SCOPED_MAPPING, {
        fieldMappings: [fieldOf(SCOPED_MAPPING, "issues/title", "tasks/title")],
        // The approved target WRITE operation — the SS-18.1 detection signal.
        operationMappings: [
          {
            id: randomUUID(),
            mappingId: SCOPED_MAPPING,
            sourceOperationRef: "issues/issues_create",
            targetOperationRef: "tasks/tasks_create",
            action: "create",
          },
        ],
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
    correspondences = new ScopeCorrespondenceRepository(db);
  });

  afterAll(async () => {
    await db.delete(syncRule);
    await db.delete(adapterBinding);
    await db.delete(adapterEndpoint);
    await db.delete(graphEdge);
    await db.delete(scopeCorrespondence);
    await db.delete(approvedMapping);
    await db.delete(resourceBindingRef);
    await db.delete(resourceBinding);
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

  // ── SS-18: the ScopeCorrespondence proposal rides the same MappingApproved reaction ──

  it("proposes an UNCONFIRMED ScopeCorrespondence for the scoped pair on MappingApproved (SS-18.1)", async () => {
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: SCOPED_MAPPING, variant: "peer-peer" }),
        txn,
      ),
    );
    const result = await dispatcher.runOnce();
    expect(result).toStrictEqual({ claimed: 1, published: 1, failed: 0 });

    const correspondence = await correspondences.getByResourcePair(SCOPED_PAIR_REF);
    expect(correspondence).toBeDefined();
    // Nothing is auto-confirmed — the SS-15.4 panel is the only writer of these two.
    expect(correspondence?.confirmedBy).toBeNull();
    expect(correspondence?.confirmedAt).toBeNull();
    // SS-18.2 — both container resources derived; the source container IS enumerable here.
    expect(correspondence?.targetContainerRef).toStrictEqual({
      appId: SCOPED_TARGET_APP,
      resourceRef: "projects",
    });
    expect(correspondence?.sourceContainerRef).toStrictEqual({
      appId: SCOPED_SOURCE_APP,
      resourceRef: "repos",
    });
    // SS-18.3 — the candidate pairs source `name` to target `title`, value-preservingly.
    expect(correspondence?.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "rename" } },
    ]);

    // It rode the SAME transaction as the artifact instantiation: the rule is there too.
    expect(await artifacts.listSyncRulesByMapping(SCOPED_MAPPING)).toHaveLength(1);
  });

  it("proposes NOTHING for a non-scoped pair — no regression to L1/L2 authoring (SS-18 out of scope)", async () => {
    // PEER_MAPPING covers `issues -> tasks` and `users -> members` with no target write op
    // and no scoped IR at all; its pairs must own no correspondence.
    const rows = await db.select().from(scopeCorrespondence);
    expect(rows.map((row) => row.resourcePairRef)).toStrictEqual([SCOPED_PAIR_REF]);
  });

  it("re-derivation is idempotent and never clobbers a confirmed identity key (SS-18.6)", async () => {
    const before = await correspondences.getByResourcePair(SCOPED_PAIR_REF);
    expect(before).toBeDefined();
    if (before === undefined) return;

    // An operator confirms (and corrects) the candidate through the SS-15.4 confirm path.
    const confirmedAt = new Date("2026-07-20T09:00:00.000Z");
    await correspondences.confirmOrUpdate({
      ...before,
      scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "identifier" }],
      confirmedBy: "operator",
      confirmedAt,
    });

    // A second approval re-runs the whole reaction, proposal included.
    await tx(db, (txn) =>
      new PostgresEventBus().emit(
        createMappingApproved({ approvedMappingId: SCOPED_MAPPING, variant: "peer-peer" }),
        txn,
      ),
    );
    await dispatcher.runOnce();

    const after = await correspondences.getByResourcePair(SCOPED_PAIR_REF);
    // One per pair, still — and the operator's confirmed key survived untouched.
    expect(await db.select().from(scopeCorrespondence)).toHaveLength(1);
    expect(after?.id).toBe(before.id);
    expect(after?.confirmedBy).toBe("operator");
    expect(after?.confirmedAt).toStrictEqual(confirmedAt);
    expect(after?.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "name", targetFieldPath: "identifier" },
    ]);
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
