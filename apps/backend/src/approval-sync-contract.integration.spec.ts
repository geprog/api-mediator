import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import type {
  ApiSpec,
  FieldMapping,
  Ir,
  MappingProposal,
  MappingProposalItem,
  RegisteredApp,
} from "@mediator/domain";
import { PostgresEventBus } from "@mediator/event-bus";
import {
  FakeIdentityResolutionMetrics,
  FakeRecordLinkStore,
  FakeSyncEventRecorder,
  FakeSyncFieldStateStore,
  FakeTargetIdentityLookup,
  IdentityMatchSeeder,
  IdentityResolutionStage,
  type DetectedChange,
  type ResolutionContext,
} from "@mediator/sync-engine";
import { applyFieldMappings } from "@mediator/transform";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApprovalService } from "./modules/approval/approval-service.js";
import { DbApprovalUnitOfWork } from "./modules/approval/persistence.js";
import { fieldMappingsForResourcePair } from "./modules/sync/resolution.js";

/**
 * **The Approval Service ↔ Sync Engine contract test.** Requires a live Postgres
 * (compose `postgres`); excluded from `pnpm verify` — run with
 * `pnpm --filter @mediator/backend test:integration`.
 *
 * Both sides of this seam were individually well-tested and internally consistent,
 * yet **no real approval had ever produced a working sync round**: the Approval
 * Service stores `FieldMapping` paths **resource-qualified** (`issues/title`, per
 * `docs/architecture/data-model.md` `FieldMapping`), while live payload JSON is
 * **record-relative** (`title`). `pathSegments` splits on `.` only, so an unreduced
 * `issues/title` is a single literal segment no record carries → ABSENT. Every
 * existing test hand-built `FieldMapping`s with bare paths, so the seam was never
 * crossed.
 *
 * This test crosses it: it drives a **real approval** through the real
 * `DbApprovalUnitOfWork`, **reads the stored `ApprovedMapping` artifacts back out
 * of Postgres**, and feeds *those* into the real transform and identity paths. It
 * asserts the stored contract (paths ARE qualified) and the consumer contract (they
 * resolve against real records) in one place, so the two can never drift again.
 *
 * The approval deliberately spans **two resource pairs** (`issues→tasks` and
 * `users→members`), which is also what makes the resource-pair scoping assertion
 * real: an `ApprovedMapping` covers N pairs, and each `SyncRule` must see only its
 * own.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

suite("Approval → Sync field-path contract (requires Postgres)", () => {
  let db: Database;
  let service: ApprovalService;
  let stored: readonly FieldMapping[];

  const appAId = randomUUID();
  const appBId = randomUUID();
  const sourceSpecId = randomUUID();
  const targetSpecId = randomUUID();
  const proposalId = randomUUID();
  const titleItemId = randomUUID();
  const bodyItemId = randomUUID();
  const emailItemId = randomUUID();
  const createdAt = new Date("2026-07-20T00:00:00.000Z");

  // Source IR: `issues` (title, body) + `users` (email) — two resource pairs.
  const sourceIr: Ir = [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [
        {
          name: "Issue",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "body", type: "string", required: false },
          ],
        },
      ],
      crossResourceRefs: [],
    },
    {
      resourceRef: "users",
      name: "Users",
      operations: [{ operationId: "listUsers", method: "get", path: "/users", parameters: [] }],
      schemas: [{ name: "User", fields: [{ name: "email", type: "string", required: true }] }],
      crossResourceRefs: [],
    },
  ];

  // Target IR: `tasks` (title, description) + `members` (email).
  const targetIr: Ir = [
    {
      resourceRef: "tasks",
      name: "Tasks",
      operations: [{ operationId: "listTasks", method: "get", path: "/tasks", parameters: [] }],
      schemas: [
        {
          name: "Task",
          fields: [
            { name: "title", type: "string", required: true },
            { name: "description", type: "string", required: false },
          ],
        },
      ],
      crossResourceRefs: [],
    },
    {
      resourceRef: "members",
      name: "Members",
      operations: [{ operationId: "listMembers", method: "get", path: "/members", parameters: [] }],
      schemas: [{ name: "Member", fields: [{ name: "email", type: "string", required: true }] }],
      crossResourceRefs: [],
    },
  ];

  const appOf = (id: string, name: string): RegisteredApp => ({
    id,
    name,
    status: "active",
    baseUrl: "https://example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt,
  });

  const specOf = (id: string, appId: string, ir: Ir): ApiSpec => ({
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: "fixture", version: "1" } },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt,
  });

  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: { candidatePairs: [], noCounterpartResources: [] },
    status: "pending",
    createdAt,
  };

  const fieldItem = (
    id: string,
    sourceResource: string,
    sourceField: string,
    targetResource: string,
    targetField: string,
  ): MappingProposalItem => ({
    id,
    proposalId,
    kind: "field",
    sourceRef: { resourceRef: sourceResource, target: { kind: "field", path: sourceField } },
    targetRef: { resourceRef: targetResource, target: { kind: "field", path: targetField } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.95,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: `${sourceField} → ${targetField}`,
    reviewState: "accepted",
  });

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(appAId, "SourceApp"));
      await apps.create(appOf(appBId, "TargetApp"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(sourceSpecId, appAId, sourceIr));
      await specs.create(specOf(targetSpecId, appBId, targetIr));
      await new MappingProposalRepository(txn).create(proposal, [
        fieldItem(titleItemId, "issues", "title", "tasks", "title"),
        fieldItem(bodyItemId, "issues", "body", "tasks", "description"),
        // A SECOND resource pair under the same mapping (users → members).
        fieldItem(emailItemId, "users", "email", "members", "email"),
      ]);
    });
    service = new ApprovalService({
      unitOfWork: new DbApprovalUnitOfWork(db, new PostgresEventBus()),
    });

    // The real approve — `issues/title` confirmed as the identity key (AS-5), which the
    // schema restricts to the value-preserving `rename`.
    const result = await service.approve(
      { proposalId, identityKeys: [{ itemId: titleItemId }] },
      "operator@example.test",
    );
    if (result.outcome === "rejected") {
      throw new Error("fixture approve was rejected");
    }
    // Read the artifacts back OUT of Postgres — the sync side's actual input.
    stored = await tx(db, async (txn) =>
      new MappingArtifactsRepository(txn).listFieldMappings(result.mapping.id),
    );
  });

  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.relatedProposalId, proposalId));
    await db.delete(approvedMapping).where(eq(approvedMapping.sourceSpecId, sourceSpecId));
    await db.delete(mappingProposal).where(eq(mappingProposal.id, proposalId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appAId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appBId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appAId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appBId));
    await closeDb(db);
  });

  /** The `issues → tasks` fields, scoped exactly as the sync rule for that pair scopes them. */
  function issuesToTasks(): readonly FieldMapping[] {
    return fieldMappingsForResourcePair(stored, "issues", "tasks");
  }

  it("stores field paths resource-qualified (the producer half of the contract)", () => {
    expect(
      stored.map((field) => ({ sourcePath: field.sourcePath, targetPath: field.targetPath })),
    ).toEqual(
      expect.arrayContaining([
        { sourcePath: "issues/title", targetPath: "tasks/title" },
        { sourcePath: "issues/body", targetPath: "tasks/description" },
        { sourcePath: "users/email", targetPath: "members/email" },
      ]),
    );
  });

  it("scopes a mapping's fields to ONE resource pair — a rule never sees a foreign pair's fields", () => {
    expect(issuesToTasks().map((field) => field.sourcePath)).toEqual([
      "issues/title",
      "issues/body",
    ]);
    // The counterpart pair is scoped just as strictly, and the two never overlap.
    expect(
      fieldMappingsForResourcePair(stored, "users", "members").map((f) => f.sourcePath),
    ).toEqual(["users/email"]);
  });

  it("transforms a real source record into the target payload (symptoms 1 & 3)", () => {
    // A real polled `issues` record — record-relative keys, as every live API returns.
    const observed = { id: "42", title: "Broken login", body: "Steps to reproduce…" };

    const { output } = applyFieldMappings(issuesToTasks(), observed);

    // Before the fix this threw `TransformError("missing-input")` — the dead-letter.
    // The payload keys must be the target app's REAL keys, never `tasks/description`.
    expect(output).toEqual({ title: "Broken login", description: "Steps to reproduce…" });
    expect(Object.keys(output)).not.toContain("tasks/description");
  });

  it("matches an existing target record by identity key instead of duplicating it (symptom 2)", async () => {
    const identity = issuesToTasks().find((field) => field.isIdentityKey === true);
    expect(identity).toBeDefined();
    if (identity === undefined) {
      throw new Error("no identity FieldMapping");
    }
    // Identity semantics preserved exactly: value-preserving `rename` only.
    expect(identity.transform).toBe("rename");

    const links = new FakeRecordLinkStore();
    const fieldState = new FakeSyncFieldStateStore();
    const lookup = new FakeTargetIdentityLookup();
    const events = new FakeSyncEventRecorder();
    const metrics = new FakeIdentityResolutionMetrics();
    const clock = (): Date => createdAt;
    let counter = 0;
    const newId = (): string => `id-${String(++counter)}`;
    const stage = new IdentityResolutionStage(
      { links, seeder: new IdentityMatchSeeder(fieldState, { clock, newId }), lookup, events },
      { metrics, clock, newId },
    );

    // A CORRECTLY-MATCHING target record already exists in the target app.
    lookup.setTarget(appBId, {
      identityFieldPath: "title",
      records: [{ nativeId: "task-7", record: { id: "task-7", title: "Broken login" } }],
    });

    const change: DetectedChange = {
      ruleId: "rule-1",
      mappingId: "map-1",
      sourceAppId: appAId,
      targetAppId: appBId,
      resourcePairRef: `${appAId}:issues|${appBId}:tasks`,
      sourceNativeId: "42",
      changeKind: "create",
      observedRecord: { id: "42", title: "Broken login", body: "Steps to reproduce…" },
    };
    const context: ResolutionContext = {
      appAId,
      appBId,
      identitySourcePath: identity.sourcePath,
      identityTargetPath: identity.targetPath,
      // fetch-and-match: the mediator compares candidates in memory on
      // `identityTargetPath` — the exact comparison that read ABSENT before the fix,
      // making every record look new and creating a DUPLICATE.
      targetLookup: {
        kind: "fetch-and-match",
        binding: { collectionReadOperationId: "listTasks", nativeIdPath: "id" },
      },
      hasApprovedCreateOperation: true,
      fieldMappings: issuesToTasks(),
    };

    const outcome = await stage.resolve(change, context);

    // The whole point: an existing target record is MATCHED and linked, not duplicated.
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") {
      throw new Error(`expected a resolved outcome, got ${outcome.kind}`);
    }
    expect(outcome.establishedByIdentityMatch).toBe(true);
    // A matched create is downgraded to an update — it must not create a second record.
    expect(outcome.effectiveChangeKind).toBe("update");
    expect(outcome.link.appBNativeId).toBe("task-7");

    // The seeder's target-side baseline resolved too (the fourth symptom): a seeded row
    // carrying `lastSyncedHash` proves the two sides were read as AGREEING, rather than
    // the target reading ABSENT and poisoning every baseline with `null`.
    const seeded = await fieldState.findByLink(outcome.link.id);
    // `identity.targetPath` ("tasks/title") is distinct from its source path
    // ("issues/title"), so matching on it alone identifies the target-side row.
    const titleRow = seeded.find((row) => row.fieldPath === identity.targetPath);
    expect(titleRow?.lastSyncedHash).toBeDefined();
  });
});
