import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  OrderingQueueRepository,
  RecordLinkRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  credential,
  fieldMapping,
  operationMapping,
  orderingQueue,
  pollSnapshot,
  recordLink,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  resourceBindingRef,
  runMigrations,
  syncFieldState,
  syncRule,
  tx,
  type Database,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  ConfirmableRef,
  FieldMapping,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  ScopePathBinding,
  SourceScopeRef,
  SyncRule,
} from "@mediator/domain";
import type { OutboundRequest, OutboundResponse, ProtocolClient } from "@mediator/outbound";
import type { JsonRecord, JsonValue } from "@mediator/transform";
import { pino } from "pino";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildSyncBackground, type SyncBackground } from "./modules/sync/background.js";
import { TEST_OPERATOR_ACCOUNTS } from "./testing/auth.testkit.js";

/**
 * Live-Postgres backend integration for **SS-8b — the `record-derived` scope runtime**.
 * It drives the REAL sync runtime (`buildSyncBackground`: the real `RepoPollPlanResolver`,
 * `RestSourceReader`, `RepoSyncPipelineContextLoader`, binding resolvers, ordering-queue
 * dispatcher, and Outbound Call Executor over the real repos) with only the external HTTP
 * faked by a {@link FakeLandscape}. It proves the Layer-2 payoff end to end:
 *
 *  - a scoped rule whose **source** resource has a confirmed `sourceScopeRef` and whose
 *    **target** resource carries a `record-derived` scope binding → the deterministic poll
 *    captures each record's scope from the cross-scope read, the change rides that scope
 *    through the ordering queue, and the composed write URL fills the target's
 *    `{owner}`/`{repo}` from the captured value (`/repos/alice/phoenix/issues`), not a
 *    literal `{owner}`;
 *  - a **non-scoped** rule (no `sourceScopeRef`, unscoped target op) is unaffected — no
 *    scope is captured and the write composes its plain URL (`/notes`).
 *
 * The enablement gate + kind-selection UI for `record-derived` are **SS-9 (out of scope
 * here)**, and the current gate is constant-only, so the test seeds an already-live rule
 * and drives the runtime hooks directly (`pollOnce` + `queueDispatcher.runOnce`) — exactly
 * the RL/EP/CF/TX/OC pipeline SS-8b feeds, without the gate.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

// ── Fixture ids ──────────────────────────────────────────────────────────────
const APP_A = randomUUID();
const APP_B = randomUUID();
// Each resource gets its own spec pair so the two active A→B mappings do not collide on
// `approved_mapping_active_direction_uq` (partial-unique per source/target spec pair).
const SPEC_A_ISSUES = randomUUID();
const SPEC_B_ISSUES = randomUUID();
const SPEC_A_NOTES = randomUUID();
const SPEC_B_NOTES = randomUUID();
const MAPPING_ISSUES = randomUUID();
const MAPPING_NOTES = randomUUID();
const BINDING_A_ISSUES = randomUUID();
const BINDING_B_ISSUES = randomUUID();
const BINDING_A_NOTES = randomUUID();
const BINDING_B_NOTES = randomUUID();
const RULE_ISSUES = randomUUID();
const RULE_NOTES = randomUUID();
const CREATED_AT = new Date("2026-07-13T00:00:00.000Z");
const CONFIRMED_AT = new Date("2026-07-13T01:00:00.000Z");
const BASE_A = "https://app-a.test";
const BASE_B = "https://app-b.test";
const SOURCE_SECRET = "source-secret";
const TARGET_SECRET = "target-secret";

function pairRef(resourceRef: string): string {
  const tokenA = `${APP_A}:${resourceRef}`;
  const tokenB = `${APP_B}:${resourceRef}`;
  return tokenA <= tokenB ? `${tokenA}|${tokenB}` : `${tokenB}|${tokenA}`;
}

// ── IR fixtures ────────────────────────────────────────────────────────────────
function issueFields(): IrResourceGroup["operations"][number]["responseSchema"] {
  return {
    name: "Issue",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "code", type: "string", required: true },
      { name: "title", type: "string", required: false },
    ],
  };
}

/** Source `issues`: a cross-scope collection read `GET /issues/search` (no path params). */
const SOURCE_ISSUES_GROUP: IrResourceGroup = {
  resourceRef: "issues",
  name: "Issues",
  operations: [
    {
      operationId: "searchIssues",
      method: "get",
      path: "/issues/search",
      parameters: [],
      responseSchema: issueFields(),
    },
  ],
  schemas: [],
  crossResourceRefs: [],
};

/** Target `issues`: a repo-scoped create `POST /repos/{owner}/{repo}/issues`. */
const TARGET_ISSUES_GROUP: IrResourceGroup = {
  resourceRef: "issues",
  name: "Issues",
  operations: [
    {
      operationId: "createIssue",
      method: "post",
      path: "/repos/{owner}/{repo}/issues",
      parameters: [
        { name: "owner", location: "path", required: true, type: "string" },
        { name: "repo", location: "path", required: true, type: "string" },
      ],
      requestSchema: {
        name: "CreateIssue",
        fields: [{ name: "title", type: "string", required: false }],
      },
      responseSchema: issueFields(),
    },
  ],
  schemas: [],
  crossResourceRefs: [],
};

/** An UNSCOPED `notes` resource on both sides (the non-scoped control). */
function notesGroup(): IrResourceGroup {
  return {
    resourceRef: "notes",
    name: "Notes",
    operations: [
      {
        operationId: "listNotes",
        method: "get",
        path: "/notes",
        parameters: [],
        responseSchema: issueFields(),
      },
      {
        operationId: "createNote",
        method: "post",
        path: "/notes",
        parameters: [],
        requestSchema: {
          name: "CreateNote",
          fields: [{ name: "title", type: "string", required: false }],
        },
        responseSchema: issueFields(),
      },
    ],
    schemas: [],
    crossResourceRefs: [],
  };
}

function appOf(id: string, name: string, baseUrl: string): RegisteredApp {
  return {
    id,
    name,
    status: "active",
    baseUrl,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60_000,
    },
    createdAt: CREATED_AT,
  };
}

function specOf(id: string, appId: string, parsedIR: IrResourceGroup[]): ApiSpec {
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

function confirmedRef(value: ConfirmableRef["value"]): ConfirmableRef {
  return { value, confirmedBy: "operator", confirmedAt: CONFIRMED_AT };
}

/** Confirmed Gitea-style `sourceScopeRef`: owner+name from `repository.owner`/`repository.name`. */
const GITEA_SOURCE_SCOPE_REF: SourceScopeRef = {
  components: [
    { key: "owner", fieldPath: "repository.owner" },
    { key: "name", fieldPath: "repository.name" },
  ],
  confirmedBy: "operator",
  confirmedAt: CONFIRMED_AT,
};

function recordDerived(parameterName: string, sourceScopeKey: string): ScopePathBinding {
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    confirmedBy: "operator",
    confirmedAt: CONFIRMED_AT,
  };
}

function bindingOf(
  id: string,
  apiSpecId: string,
  resourceRef: string,
  collectionReadOperationId: string | undefined,
  extra: Partial<ResourceBinding>,
): ResourceBinding {
  return {
    id,
    apiSpecId,
    resourceRef,
    nativeIdRef: confirmedRef({ kind: "field", path: "id" }),
    ...(collectionReadOperationId !== undefined
      ? {
          collectionReadRef: confirmedRef({
            kind: "operation",
            operationId: collectionReadOperationId,
          }),
        }
      : {}),
    scopePathBindings: [],
    ...extra,
  };
}

function mappingOf(id: string, sourceSpecId: string, targetSpecId: string): ApprovedMapping {
  return {
    id,
    sourceSpecId,
    targetSpecId,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: CREATED_AT,
    status: "active",
  };
}

function fieldsOf(mappingId: string): FieldMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourcePath: "code",
      targetPath: "code",
      transform: "rename",
      isIdentityKey: true,
    },
    { id: randomUUID(), mappingId, sourcePath: "title", targetPath: "title", transform: "rename" },
  ];
}

/** A create-only operation mapping (targetLookup = none → straight-create, no target read). */
function createOnlyOps(mappingId: string, targetOperationRef: string): OperationMapping[] {
  return [
    {
      id: randomUUID(),
      mappingId,
      sourceOperationRef: `issues/searchIssues`,
      targetOperationRef,
      action: "create",
    },
  ];
}

function ruleOf(
  id: string,
  mappingId: string,
  resourceRef: string,
  pollOperationRef: string,
): SyncRule {
  return {
    id,
    approvedMappingId: mappingId,
    resourcePairRef: pairRef(resourceRef),
    status: "enabled",
    backfillStatus: "completed",
    backfillMode: "link-only",
    pollOperationRef,
  };
}

// ── Fake landscape (the ONLY thing faked: the external HTTP) ────────────────────
interface RecordedWrite {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue | undefined;
}

function resp(status: number, body: JsonValue | undefined): Promise<OutboundResponse> {
  return Promise.resolve({ status, headers: {}, body });
}
function asRecord(body: JsonValue | undefined): JsonRecord {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
}

class FakeLandscape implements ProtocolClient {
  public readonly targetWrites: RecordedWrite[] = [];
  #created = 0;

  public reset(): void {
    this.targetWrites.length = 0;
    this.#created = 0;
  }

  public send(request: OutboundRequest): Promise<OutboundResponse> {
    const { method, url } = request;
    const isA = url.startsWith(BASE_A);
    const path = url.slice((isA ? BASE_A : BASE_B).length);
    const bare = path.split("?")[0] ?? path;

    // ── Source (app A) collection reads — record self-carries its scope. ──
    if (isA && method === "GET" && bare === "/issues/search") {
      return resp(200, [
        {
          id: "a1",
          code: "W-100",
          title: "Alpha",
          repository: { owner: "alice", name: "phoenix" },
        },
      ]);
    }
    if (isA && method === "GET" && bare === "/notes") {
      return resp(200, [{ id: "an1", code: "N-1", title: "NoteAlpha" }]);
    }

    // ── Target (app B) scoped/unscoped creates — record the composed URL. ──
    if (!isA && method === "POST") {
      this.#created += 1;
      const created: JsonRecord = { ...asRecord(request.body), id: `gen-${String(this.#created)}` };
      this.targetWrites.push({ method, path: bare, body: request.body });
      return resp(200, created);
    }
    return resp(404, undefined);
  }
}

function testConfig(url: string): AppConfig {
  return {
    http: { port: 0 },
    database: { url },
    telemetry: { enabled: false },
    mappingLlm: {
      provider: "ollama",
      ollamaBaseUrl: "http://localhost:11434",
      model: "test",
      temperature: 0,
      thinking: false,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      reviewThreshold: 0.7,
    },
    credentials: { masterKey: Buffer.alloc(32, 7) },
    registration: { defaultPollInterval: 60_000 },
    auth: { accounts: [...TEST_OPERATOR_ACCOUNTS] },
    sync: { testPollTrigger: false },
  };
}

async function clearRuntimeState(db: Database): Promise<void> {
  await db.delete(orderingQueue);
  await db.delete(syncFieldState);
  await db.delete(pollSnapshot);
  await db.delete(recordLink);
  await db.delete(auditLog);
  await db.delete(syncRule);
}

async function clearAll(db: Database): Promise<void> {
  await clearRuntimeState(db);
  await db.delete(credential);
  await db.delete(operationMapping);
  await db.delete(fieldMapping);
  await db.delete(resourceBindingRef);
  await db.delete(resourceBinding);
  await db.delete(approvedMapping);
  await db.delete(apiSpec);
  await db.delete(registeredApp);
}

suite("SS-8b record-derived scope runtime — live Postgres", () => {
  let db: Database;
  let sync: SyncBackground;
  const config = testConfig(databaseUrl ?? "");
  const logger: FastifyBaseLogger = pino({ level: "silent" });
  const landscape = new FakeLandscape();

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    await clearAll(db);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_A, "app-a", BASE_A));
      await apps.create(appOf(APP_B, "app-b", BASE_B));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(SPEC_A_ISSUES, APP_A, [SOURCE_ISSUES_GROUP]));
      await specs.create(specOf(SPEC_B_ISSUES, APP_B, [TARGET_ISSUES_GROUP]));
      await specs.create(specOf(SPEC_A_NOTES, APP_A, [notesGroup()]));
      await specs.create(specOf(SPEC_B_NOTES, APP_B, [notesGroup()]));
      await new ResourceBindingRepository(txn).createMany([
        // Source `issues`: a confirmed sourceScopeRef (record-carried scope), unscoped read.
        bindingOf(BINDING_A_ISSUES, SPEC_A_ISSUES, "issues", "searchIssues", {
          sourceScopeRef: GITEA_SOURCE_SCOPE_REF,
        }),
        // Target `issues`: record-derived owner/repo, NO collection read → targetLookup none.
        bindingOf(BINDING_B_ISSUES, SPEC_B_ISSUES, "issues", undefined, {
          scopePathBindings: [recordDerived("owner", "owner"), recordDerived("repo", "name")],
        }),
        // Non-scoped `notes`: no sourceScopeRef, unscoped ops.
        bindingOf(BINDING_A_NOTES, SPEC_A_NOTES, "notes", "listNotes", {}),
        bindingOf(BINDING_B_NOTES, SPEC_B_NOTES, "notes", undefined, {}),
      ]);
      const mappings = new ApprovedMappingRepository(txn);
      await mappings.insert(mappingOf(MAPPING_ISSUES, SPEC_A_ISSUES, SPEC_B_ISSUES));
      await mappings.insert(mappingOf(MAPPING_NOTES, SPEC_A_NOTES, SPEC_B_NOTES));
      const artifacts = new MappingArtifactsRepository(txn);
      await artifacts.replaceChildren(MAPPING_ISSUES, {
        fieldMappings: fieldsOf(MAPPING_ISSUES),
        operationMappings: createOnlyOps(MAPPING_ISSUES, "issues/createIssue"),
        parameterMappings: [],
      });
      await artifacts.replaceChildren(MAPPING_NOTES, {
        fieldMappings: fieldsOf(MAPPING_NOTES),
        operationMappings: createOnlyOps(MAPPING_NOTES, "notes/createNote"),
        parameterMappings: [],
      });
    });

    const credentialStore = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(config.credentials.masterKey),
    );
    await credentialStore.store(APP_A, { secret: { type: "apiKey", apiKey: SOURCE_SECRET } });
    await credentialStore.store(APP_B, { secret: { type: "apiKey", apiKey: TARGET_SECRET } });

    sync = buildSyncBackground({ db, config, logger, protocolClient: landscape });
  });

  beforeEach(async () => {
    await clearRuntimeState(db);
    const downstream = new DownstreamArtifactRepository(db);
    await downstream.insertSyncRuleIfAbsent(
      ruleOf(RULE_ISSUES, MAPPING_ISSUES, "issues", "issues/searchIssues"),
    );
    await downstream.insertSyncRuleIfAbsent(
      ruleOf(RULE_NOTES, MAPPING_NOTES, "notes", "notes/listNotes"),
    );
    landscape.reset();
  });

  afterAll(async () => {
    await sync.stop();
    await clearAll(db);
    await closeDb(db);
  });

  it("scoped rule: poll captures scope → the create write composes /repos/alice/phoenix/issues from the captured value", async () => {
    // One cross-scope poll: the source issue self-carries repository.owner/name.
    const outcome = await sync.pollOnce(RULE_ISSUES);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.enqueued).toHaveLength(1);
      expect(outcome.enqueued[0]?.changeKind).toBe("create");
    }

    // The enqueued change carried the captured scope through the ordering-queue payload.
    const queue = new OrderingQueueRepository(db);
    const pending = await queue.listByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({
      capturedScope: { owner: "alice", name: "phoenix" },
    });

    // Running the dispatcher drives RL/EP/TX/OC: the composed write URL fills owner/repo
    // from the captured scope (record-derived), not a literal {owner}.
    const tick = await sync.queueDispatcher.runOnce();
    expect(tick.outcome).toBe("done");

    expect(landscape.targetWrites).toHaveLength(1);
    const write = landscape.targetWrites[0];
    expect(write?.method).toBe("POST");
    expect(write?.path).toBe("/repos/alice/phoenix/issues");
    expect(write?.path).not.toContain("{");
    // The transformed body is the mapped record — the scope is in the URL, not the body.
    expect(write?.body).toMatchObject({ code: "W-100", title: "Alpha" });

    // Create-propagation established the RecordLink from the create response's native id.
    const link = await new RecordLinkRepository(db).findActiveByRecord(pairRef("issues"), {
      appId: APP_A,
      nativeId: "a1",
    });
    expect(link).toBeDefined();
    // The target side of the link is the create response's native id (gen-1).
    const targetNativeId = link?.appAId === APP_A ? link.appBNativeId : link?.appANativeId;
    expect(targetNativeId).toBe("gen-1");
  });

  it("non-scoped rule: no scope is captured and the write composes its plain URL (/notes)", async () => {
    const outcome = await sync.pollOnce(RULE_NOTES);
    expect(outcome.kind).toBe("completed");

    // No sourceScopeRef → the enqueued change carries no captured scope (constant/non-scoped
    // rules are unaffected).
    const queue = new OrderingQueueRepository(db);
    const pending = await queue.listByStatus("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).not.toHaveProperty("capturedScope");

    const tick = await sync.queueDispatcher.runOnce();
    expect(tick.outcome).toBe("done");

    expect(landscape.targetWrites).toHaveLength(1);
    expect(landscape.targetWrites[0]?.path).toBe("/notes");
  });
});
