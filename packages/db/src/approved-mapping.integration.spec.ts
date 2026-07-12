import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  FieldMapping,
  Ir,
  MappingProposal,
  MappingProposalItem,
  OperationMapping,
  ParameterMapping,
  RegisteredApp,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
} from "./repositories/index.js";
import { apiSpec, approvedMapping, mappingProposal, registeredApp } from "./schema.js";

/**
 * Live-database integration test for the Phase-3 Approval Service persistence
 * (AS-2/AS-4/AS-5/AS-6 + the `mapping-decision` audit and per-item review update).
 * Requires the compose `postgres` service and a resolvable `DATABASE_URL`; excluded
 * from `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`.
 *
 * Proves every persistence mutation against a fresh migrated schema (chain
 * 0000→0008): the `ApprovedMapping` + child round-trip (with the null↔absent
 * collapse of every conditional column), `getActiveByDirectionalSpecPair`'s
 * active-only filter, update-in-place, `replaceChildren`'s reconcile, the
 * parameter join, counterpart linking, the partial-unique active-direction
 * invariant, the audit log, the per-item review update, and the `ON DELETE
 * CASCADE` of children.
 */
describe("Phase-3 approval persistence integration (requires Postgres)", () => {
  let db: Database;

  const appAId = randomUUID();
  const appBId = randomUUID();
  const sourceSpecId = randomUUID();
  const targetSpecId = randomUUID();
  const thirdSpecId = randomUUID();
  const proposalId = randomUUID();
  const itemId = randomUUID();
  const createdAt = new Date("2026-07-11T00:00:00.000Z");
  const approvedAt = new Date("2026-07-12T00:00:00.000Z");

  const mappingId = randomUUID();
  const reverseMappingId = randomUUID();
  const cpMappingId = randomUUID();

  const ir: Ir = [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
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

  const specOf = (id: string, appId: string): ApiSpec => ({
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

  const mainMapping: ApprovedMapping = {
    id: mappingId,
    sourceSpecId,
    targetSpecId,
    sourceAppId: appAId,
    targetAppId: appBId,
    variant: "peer-peer",
    approvedBy: "operator@example.test",
    approvedAt,
    status: "active",
  };

  const identityField: FieldMapping = {
    id: randomUUID(),
    mappingId,
    sourcePath: "issues/email",
    targetPath: "tasks/email",
    transform: "rename",
    isIdentityKey: true,
    targetLookupParamRef: "email",
  };
  const plainField: FieldMapping = {
    id: randomUUID(),
    mappingId,
    sourcePath: "issues/title",
    targetPath: "tasks/title",
    transform: "rename",
  };
  const updateOperation: OperationMapping = {
    id: randomUUID(),
    mappingId,
    sourceOperationRef: "issues/updateIssue",
    targetOperationRef: "tasks/updateTask",
    action: "update",
    targetIdParamRef: "tasks/updateTask#taskId",
  };
  const createOperation: OperationMapping = {
    id: randomUUID(),
    mappingId,
    sourceOperationRef: "issues/createIssue",
    targetOperationRef: "tasks/createTask",
    action: "create",
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(appAId, "AppA"));
      await apps.create(appOf(appBId, "AppB"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(sourceSpecId, appAId));
      await specs.create(specOf(targetSpecId, appBId));
      await specs.create(specOf(thirdSpecId, appBId));
    });
  });

  afterAll(async () => {
    // Break the self-referential counterpart links before deleting (M ↔ Mrev).
    for (const id of [mappingId, reverseMappingId, cpMappingId]) {
      await db
        .update(approvedMapping)
        .set({ counterpartMappingId: null })
        .where(eq(approvedMapping.id, id));
    }
    await db.delete(approvedMapping).where(eq(approvedMapping.sourceSpecId, sourceSpecId));
    await db.delete(approvedMapping).where(eq(approvedMapping.sourceSpecId, targetSpecId));
    await db.delete(mappingProposal).where(eq(mappingProposal.id, proposalId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appAId));
    await db.delete(apiSpec).where(eq(apiSpec.appId, appBId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appAId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appBId));
    await closeDb(db);
  });

  it("round-trips an ApprovedMapping and its children, collapsing null↔absent", async () => {
    await tx(db, async (txn) => {
      await new ApprovedMappingRepository(txn).insert(mainMapping);
      await new MappingArtifactsRepository(txn).replaceChildren(mappingId, {
        fieldMappings: [identityField, plainField],
        operationMappings: [updateOperation, createOperation],
        parameterMappings: [],
      });
    });

    const mappings = new ApprovedMappingRepository(db);
    const readMapping = await mappings.getById(mappingId);
    // A peer-peer mapping with no counterpart carries an ABSENT counterpartMappingId.
    expect(readMapping).toStrictEqual(mainMapping);
    expect(readMapping && "counterpartMappingId" in readMapping).toBe(false);

    const artifacts = new MappingArtifactsRepository(db);
    const fields = await artifacts.listFieldMappings(mappingId);
    const byId = new Map(fields.map((f) => [f.id, f]));
    expect(byId.get(identityField.id)).toStrictEqual(identityField);
    // The plain field carries no phase/isIdentityKey/targetLookupParamRef/conflictPolicy.
    const readPlain = byId.get(plainField.id);
    expect(readPlain).toStrictEqual(plainField);
    expect(readPlain && "isIdentityKey" in readPlain).toBe(false);
    expect(readPlain && "phase" in readPlain).toBe(false);

    const operations = await artifacts.listOperationMappings(mappingId);
    const opById = new Map(operations.map((o) => [o.id, o]));
    expect(opById.get(updateOperation.id)).toStrictEqual(updateOperation);
    // A create operation carries no targetIdParamRef.
    const readCreate = opById.get(createOperation.id);
    expect(readCreate).toStrictEqual(createOperation);
    expect(readCreate && "targetIdParamRef" in readCreate).toBe(false);
  });

  it("finds only the ACTIVE mapping by directional spec pair", async () => {
    const found = await new ApprovedMappingRepository(db).getActiveByDirectionalSpecPair(
      sourceSpecId,
      targetSpecId,
    );
    expect(found?.id).toBe(mappingId);
    // The reverse direction has no mapping yet.
    expect(
      await new ApprovedMappingRepository(db).getActiveByDirectionalSpecPair(
        targetSpecId,
        sourceSpecId,
      ),
    ).toBeUndefined();
  });

  it("rejects a second ACTIVE mapping for the same directional spec pair", async () => {
    const duplicate: ApprovedMapping = { ...mainMapping, id: randomUUID() };
    await expect(
      tx(db, (txn) => new ApprovedMappingRepository(txn).insert(duplicate)),
    ).rejects.toThrow();
  });

  it("updates an ApprovedMapping in place (approvedBy/approvedAt)", async () => {
    const later = new Date("2026-07-13T00:00:00.000Z");
    const updated = await new ApprovedMappingRepository(db).update({
      ...mainMapping,
      approvedBy: "operator2@example.test",
      approvedAt: later,
    });
    expect(updated?.approvedBy).toBe("operator2@example.test");
    expect(updated?.approvedAt).toStrictEqual(later);
    expect((await new ApprovedMappingRepository(db).getById(mappingId))?.approvedBy).toBe(
      "operator2@example.test",
    );
  });

  it("cross-links a counterpart mapping both ways", async () => {
    const reverse: ApprovedMapping = {
      id: reverseMappingId,
      sourceSpecId: targetSpecId,
      targetSpecId: sourceSpecId,
      sourceAppId: appBId,
      targetAppId: appAId,
      variant: "peer-peer",
      approvedBy: "operator@example.test",
      approvedAt,
      status: "active",
    };
    const mappings = new ApprovedMappingRepository(db);
    await mappings.insert(reverse);
    await mappings.setCounterpart(mappingId, reverseMappingId);
    await mappings.setCounterpart(reverseMappingId, mappingId);

    expect((await mappings.getById(mappingId))?.counterpartMappingId).toBe(reverseMappingId);
    expect((await mappings.getById(reverseMappingId))?.counterpartMappingId).toBe(mappingId);
  });

  it("reconciles children with replaceChildren (delete + insert) and joins parameters", async () => {
    // A consumer-provider mapping (distinct directional pair) with a parameter child.
    const cpMapping: ApprovedMapping = {
      id: cpMappingId,
      sourceSpecId,
      targetSpecId: thirdSpecId,
      sourceAppId: appAId,
      targetAppId: appBId,
      variant: "consumer-provider",
      approvedBy: "operator@example.test",
      approvedAt,
      status: "active",
    };
    const cpOperation: OperationMapping = {
      id: randomUUID(),
      mappingId: cpMappingId,
      sourceOperationRef: "search/searchIssues",
      targetOperationRef: "list/listTasks",
      action: "read",
    };
    const cpField: FieldMapping = {
      id: randomUUID(),
      mappingId: cpMappingId,
      sourcePath: "search/summary",
      targetPath: "list/title",
      transform: "rename",
      phase: "request",
    };
    const passThroughParam: ParameterMapping = {
      id: randomUUID(),
      operationMappingId: cpOperation.id,
      sourceParamRef: "search/searchIssues#owner",
      targetParamRef: "list/listTasks#project",
    };

    const artifacts = new MappingArtifactsRepository(db);
    await tx(db, async (txn) => {
      await new ApprovedMappingRepository(txn).insert(cpMapping);
      await new MappingArtifactsRepository(txn).replaceChildren(cpMappingId, {
        fieldMappings: [cpField],
        operationMappings: [cpOperation],
        parameterMappings: [passThroughParam],
      });
    });

    // The CP field's phase round-trips; the pass-through parameter carries no transform.
    expect(await artifacts.listFieldMappings(cpMappingId)).toStrictEqual([cpField]);
    const params = await artifacts.listParameterMappings(cpMappingId);
    expect(params).toStrictEqual([passThroughParam]);
    expect(params[0] && "transform" in params[0]).toBe(false);

    // Replace with a smaller set: the old operation (and its cascaded parameter) go.
    const replacementOp: OperationMapping = { ...cpOperation, id: randomUUID(), action: "create" };
    await tx(db, (txn) =>
      new MappingArtifactsRepository(txn).replaceChildren(cpMappingId, {
        fieldMappings: [],
        operationMappings: [replacementOp],
        parameterMappings: [],
      }),
    );
    expect(await artifacts.listFieldMappings(cpMappingId)).toStrictEqual([]);
    expect(await artifacts.listParameterMappings(cpMappingId)).toStrictEqual([]);
    expect((await artifacts.listOperationMappings(cpMappingId)).map((o) => o.id)).toStrictEqual([
      replacementOp.id,
    ]);
  });

  it("writes and lists mapping-decision audit entries", async () => {
    const perItem: AuditLogEntry = {
      id: randomUUID(),
      type: "mapping-decision",
      actor: "operator@example.test",
      decision: "accept",
      relatedProposalId: proposalId,
      relatedItemId: itemId,
      timestamp: new Date("2026-07-12T08:00:00.000Z"),
    };
    const approveEntry: AuditLogEntry = {
      id: randomUUID(),
      type: "mapping-decision",
      actor: "operator@example.test",
      decision: "approve",
      relatedProposalId: proposalId,
      relatedMappingId: mappingId,
      details: "approved",
      timestamp: new Date("2026-07-12T09:00:00.000Z"),
    };
    const audit = new AuditLogRepository(db);
    await audit.insert(perItem);
    await audit.insert(approveEntry);

    const byProposal = await audit.listByProposalId(proposalId);
    expect(byProposal).toStrictEqual([approveEntry, perItem]); // most recent first
    // The per-item entry carries no relatedMappingId/details.
    const readPerItem = byProposal.find((e) => e.id === perItem.id);
    expect(readPerItem && "relatedMappingId" in readPerItem).toBe(false);
    expect(readPerItem && "details" in readPerItem).toBe(false);

    const byMapping = await audit.listByMappingId(mappingId);
    expect(byMapping.map((e) => e.id)).toStrictEqual([approveEntry.id]);
  });

  it("applies a per-item review decision and reads a single item by id", async () => {
    const proposal: MappingProposal = {
      id: proposalId,
      sourceSpecId,
      targetSpecId,
      generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
      shortlistResult: { candidatePairs: [], noCounterpartResources: [] },
      status: "pending",
      createdAt,
    };
    const pendingItem: MappingProposalItem = {
      id: itemId,
      proposalId,
      kind: "field",
      sourceRef: { resourceRef: "issues", target: { kind: "field", path: "state" } },
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "state" } },
      transformSuggestion: { transform: "coerce" },
      confidenceScore: 0.5,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "state",
      reviewState: "pending",
    };
    const proposals = new MappingProposalRepository(db);
    await tx(db, (txn) => new MappingProposalRepository(txn).create(proposal, [pendingItem]));

    // Edit it: new targetRef + reviewState edited.
    const edited: MappingProposalItem = {
      ...pendingItem,
      targetRef: { resourceRef: "tasks", target: { kind: "field", path: "done" } },
      reviewState: "edited",
    };
    const updated = await proposals.updateItemReview(edited);
    expect(updated?.reviewState).toBe("edited");
    expect(updated?.targetRef).toStrictEqual({
      resourceRef: "tasks",
      target: { kind: "field", path: "done" },
    });

    const readBack = await proposals.getItemById(itemId);
    expect(readBack?.reviewState).toBe("edited");
    expect(await proposals.getItemById(randomUUID())).toBeUndefined();
  });

  it("cascades child rows when an ApprovedMapping is deleted", async () => {
    const doomedId = randomUUID();
    const doomed: ApprovedMapping = {
      ...mainMapping,
      id: doomedId,
      sourceSpecId: thirdSpecId,
      targetSpecId: sourceSpecId,
    };
    const doomedField: FieldMapping = {
      id: randomUUID(),
      mappingId: doomedId,
      sourcePath: "a/x",
      targetPath: "b/y",
      transform: "rename",
    };
    await tx(db, async (txn) => {
      await new ApprovedMappingRepository(txn).insert(doomed);
      await new MappingArtifactsRepository(txn).replaceChildren(doomedId, {
        fieldMappings: [doomedField],
        operationMappings: [],
        parameterMappings: [],
      });
    });
    expect(await new MappingArtifactsRepository(db).listFieldMappings(doomedId)).toHaveLength(1);

    await db.delete(approvedMapping).where(eq(approvedMapping.id, doomedId));
    expect(await new MappingArtifactsRepository(db).listFieldMappings(doomedId)).toStrictEqual([]);
  });
});
