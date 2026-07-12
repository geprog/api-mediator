import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  eventOutbox,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import { PostgresEventBus } from "@mediator/event-bus";
import type {
  ApiSpec,
  Ir,
  MappingProposal,
  MappingProposalItem,
  RegisteredApp,
} from "@mediator/domain";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BadRequestError } from "../../app-errors.js";
import { ApprovalService } from "./approval-service.js";
import { DbApprovalUnitOfWork } from "./persistence.js";

/**
 * End-to-end integration test for the Approval Service against a live Postgres
 * (compose `postgres`), driving the REAL {@link DbApprovalUnitOfWork} — not the
 * in-memory fake. Excluded from `pnpm verify`; run with
 * `pnpm --filter @mediator/backend test:integration`.
 *
 * It proves AS-3/AS-6 atomicity for real: an approve whose accepted item fails
 * edit-path validation against the target IR throws and its transaction rolls
 * back — committing **no** `approved_mapping`/child row, **no** `mapping-decision`
 * audit row, and **no** `MappingApproved` outbox event (AS-3 criterion 5, AS-6
 * criterion 6). The `ApprovedMapping` and its event are always produced together
 * or not at all.
 */
describe("Approval Service atomicity integration (requires Postgres)", () => {
  let db: Database;
  let service: ApprovalService;

  const appAId = randomUUID();
  const appBId = randomUUID();
  const sourceSpecId = randomUUID();
  const targetSpecId = randomUUID();
  const proposalId = randomUUID();
  const acceptedItemId = randomUUID();
  const createdAt = new Date("2026-07-12T00:00:00.000Z");

  const issuesIr: Ir = [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [{ name: "Issue", fields: [{ name: "x", type: "string", required: true }] }],
      crossResourceRefs: [],
    },
  ];
  // The `tasks` resource exists but has NO `ghost` field — so the accepted item's
  // targetRef fails AS-3 validation.
  const tasksIr: Ir = [
    {
      resourceRef: "tasks",
      name: "Tasks",
      operations: [{ operationId: "listTasks", method: "get", path: "/tasks", parameters: [] }],
      schemas: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }],
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

  // Accepted as-is, but points at a target field that does not exist (AS-3 crit 6).
  const brokenItem: MappingProposalItem = {
    id: acceptedItemId,
    proposalId,
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "x" } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: "ghost" } },
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "x → ghost",
    reviewState: "accepted",
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(appAId, "AppA"));
      await apps.create(appOf(appBId, "AppB"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(sourceSpecId, appAId, issuesIr));
      await specs.create(specOf(targetSpecId, appBId, tasksIr));
      await new MappingProposalRepository(txn).create(proposal, [brokenItem]);
    });
    service = new ApprovalService({
      unitOfWork: new DbApprovalUnitOfWork(db, new PostgresEventBus()),
    });
  });

  afterAll(async () => {
    await db.delete(auditLog).where(eq(auditLog.relatedProposalId, proposalId));
    await db.delete(mappingProposal).where(eq(mappingProposal.id, proposalId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appAId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appBId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appAId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appBId));
    await closeDb(db);
  });

  it("rolls back the whole approve when AS-3 edit-path validation fails", async () => {
    const mappingApprovedBefore = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.type, "MappingApproved"));

    await expect(service.approve({ proposalId }, "operator@example.test")).rejects.toBeInstanceOf(
      BadRequestError,
    );

    // No ApprovedMapping (and therefore no child rows, which FK it) was committed.
    expect(
      await db.select().from(approvedMapping).where(eq(approvedMapping.sourceSpecId, sourceSpecId)),
    ).toStrictEqual([]);

    // No mapping-decision audit row for this proposal was committed.
    expect(
      await db.select().from(auditLog).where(eq(auditLog.relatedProposalId, proposalId)),
    ).toStrictEqual([]);

    // No new MappingApproved outbox event was appended.
    const mappingApprovedAfter = await db
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.type, "MappingApproved"));
    expect(mappingApprovedAfter).toHaveLength(mappingApprovedBefore.length);

    // The proposal's status is untouched (updateStatus rolled back too).
    expect((await new MappingProposalRepository(db).getById(proposalId))?.status).toBe("pending");
  });

  it("committed nothing that references the proposal (belt-and-braces)", async () => {
    // A committed approve would have left at least one non-null related_mapping_id
    // audit row referencing the proposal; none exists.
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.relatedProposalId, proposalId), isNotNull(auditLog.relatedMappingId)));
    expect(audits).toStrictEqual([]);
  });
});
