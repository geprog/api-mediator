import { randomUUID } from "node:crypto";

import type {
  ApiSpec,
  Ir,
  MappingProposal,
  MappingProposalItem,
  RegisteredApp,
  ShortlistResult,
} from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  ApiSpecRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
} from "./repositories/index.js";
import { apiSpec, mappingProposal, mappingProposalItem, registeredApp } from "./schema.js";

/**
 * Live-database integration test for the Phase-2 proposal-persistence
 * repository (PP-1..3). Requires the compose `postgres` service and a resolvable
 * `DATABASE_URL`; excluded from `pnpm verify`, run via
 * `pnpm --filter @mediator/db test:integration`.
 *
 * Proves the whole slice end-to-end against a fresh migrated schema (chain
 * 0000→0005): a peer-peer proposal with an operation item, an identity-key field
 * item, and an unmapped item round-trips with items; a `failed` proposal carries
 * a NULL `shortlist_result` and no items; `updateStatus` and `setShortlistResult`
 * (marking a pair `analysisFailed`) persist; and `ON DELETE CASCADE` removes a
 * proposal's items when the proposal is deleted.
 */
describe("Phase-2 proposal persistence integration (requires Postgres)", () => {
  let db: Database;

  const appId = randomUUID();
  const sourceSpecId = randomUUID();
  const targetSpecId = randomUUID();
  const proposalId = randomUUID();
  const failedProposalId = randomUUID();
  const cascadeProposalId = randomUUID();
  const createdAt = new Date("2026-07-10T00:00:00.000Z");

  const ir: Ir = [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [{ operationId: "listIssues", method: "get", path: "/issues", parameters: [] }],
      schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
      crossResourceRefs: [],
    },
  ];

  const app: RegisteredApp = {
    id: appId,
    name: "Gitea",
    status: "active",
    baseUrl: "https://gitea.example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt,
  };

  const specOf = (id: string, contentHash: string): ApiSpec => ({
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: "Gitea", version: "1" } },
    parsedIR: ir,
    analysisExclusions: [],
    version: 1,
    contentHash,
    status: "active",
    createdAt,
  });

  // Shared, direction-agnostic shortlist (candidate pairs + no-counterpart set).
  const shortlistResult: ShortlistResult = {
    candidatePairs: [
      {
        sourceResource: "issues",
        targetResource: "tasks",
        confidence: 0.625,
        rationale: "both track work items",
        analysisFailed: false,
      },
    ],
    noCounterpartResources: [{ specId: sourceSpecId, resourceRef: "milestones" }],
  };

  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "ollama", model: "glm-4.7-flash", promptVersion: "v1" },
    shortlistResult,
    status: "pending",
    createdAt,
  };

  const operationItem: MappingProposalItem = {
    id: randomUUID(),
    proposalId,
    kind: "operation",
    sourceRef: { resourceRef: "issues", target: { kind: "operation", operationId: "listIssues" } },
    targetRef: { resourceRef: "tasks", target: { kind: "operation", operationId: "listTasks" } },
    // An operation item carries an explicit `null` transformSuggestion.
    transformSuggestion: null,
    confidenceScore: 0.5,
    ambiguousAlternatives: [],
    unmapped: false,
    rationale: "list ↔ list",
    reviewState: "pending",
  };

  // The identity-key-derived field pairing (email ↔ email, value-preserving).
  const identityFieldItem: MappingProposalItem = {
    id: randomUUID(),
    proposalId,
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "email" } },
    targetRef: { resourceRef: "tasks", target: { kind: "field", path: "email" } },
    // Peer-peer field items carry NO phase.
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.75,
    ambiguousAlternatives: [
      {
        targetRef: { resourceRef: "tasks", target: { kind: "field", path: "userEmail" } },
        confidence: 0.5,
      },
    ],
    unmapped: false,
    rationale: "shared identity value",
    reviewState: "pending",
  };

  const unmappedItem: MappingProposalItem = {
    id: randomUUID(),
    proposalId,
    kind: "field",
    sourceRef: { resourceRef: "issues", target: { kind: "field", path: "legacyCode" } },
    // targetRef and transformSuggestion are absent for an unmapped item.
    confidenceScore: 0.25,
    ambiguousAlternatives: [],
    unmapped: true,
    rationale: "no counterpart",
    reviewState: "pending",
  };

  const items = [operationItem, identityFieldItem, unmappedItem];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      const specs = new ApiSpecRepository(txn);
      await specs.create(specOf(sourceSpecId, "sha256:source"));
      await specs.create(specOf(targetSpecId, "sha256:target"));
    });
  });

  afterAll(async () => {
    // Delete proposals first (their items cascade); specs are FK'd with no action.
    for (const id of [proposalId, failedProposalId, cascadeProposalId]) {
      await db.delete(mappingProposal).where(eq(mappingProposal.id, id));
    }
    await db.delete(apiSpec).where(eq(apiSpec.appId, appId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("creates a proposal with items in one tx() and reads it back equal, with items", async () => {
    await tx(db, (txn) => new MappingProposalRepository(txn).create(proposal, items));

    const repo = new MappingProposalRepository(db);
    expect(await repo.getById(proposalId)).toStrictEqual(proposal);

    const readItems = await repo.listItems(proposalId);
    const byId = new Map(readItems.map((item) => [item.id, item]));
    expect(byId.get(operationItem.id)).toStrictEqual(operationItem);
    expect(byId.get(identityFieldItem.id)).toStrictEqual(identityFieldItem);
    expect(byId.get(unmappedItem.id)).toStrictEqual(unmappedItem);

    // The absent/null distinctions survive a real DB round-trip.
    expect("transformSuggestion" in (byId.get(operationItem.id) as MappingProposalItem)).toBe(true);
    expect(byId.get(operationItem.id)?.transformSuggestion).toBeNull();
    expect("transformSuggestion" in (byId.get(unmappedItem.id) as MappingProposalItem)).toBe(false);
    expect("targetRef" in (byId.get(unmappedItem.id) as MappingProposalItem)).toBe(false);
    expect("phase" in (byId.get(identityFieldItem.id) as MappingProposalItem)).toBe(false);
  });

  it("is queryable by source spec id", async () => {
    const found = await new MappingProposalRepository(db).listBySourceSpecId(sourceSpecId);
    expect(found.map((p) => p.id)).toContain(proposalId);
  });

  it("persists a failed proposal with NULL shortlist_result and no items", async () => {
    const failed: MappingProposal = {
      id: failedProposalId,
      sourceSpecId,
      targetSpecId,
      generatedBy: { providerId: "ollama", model: "glm-4.7-flash", promptVersion: "v1" },
      shortlistResult: null,
      status: "failed",
      createdAt,
    };
    await tx(db, (txn) => new MappingProposalRepository(txn).create(failed, []));

    const repo = new MappingProposalRepository(db);
    const readBack = await repo.getById(failedProposalId);
    expect(readBack?.status).toBe("failed");
    expect(readBack?.shortlistResult).toBeNull();
    expect(await repo.listItems(failedProposalId)).toStrictEqual([]);
  });

  it("updates status", async () => {
    const repo = new MappingProposalRepository(db);
    const updated = await repo.updateStatus(proposalId, "partially_approved");
    expect(updated?.status).toBe("partially_approved");
    expect((await repo.getById(proposalId))?.status).toBe("partially_approved");
  });

  it("enriches shortlist_result by marking a candidate pair analysisFailed", async () => {
    const repo = new MappingProposalRepository(db);
    const enriched: ShortlistResult = {
      ...shortlistResult,
      candidatePairs: shortlistResult.candidatePairs.map((pair) => ({
        ...pair,
        analysisFailed: true,
      })),
    };
    const updated = await repo.setShortlistResult(proposalId, enriched);
    expect(updated?.shortlistResult).toStrictEqual(enriched);
    expect(
      (await repo.getById(proposalId))?.shortlistResult?.candidatePairs[0]?.analysisFailed,
    ).toBe(true);
  });

  it("ON DELETE CASCADE removes a proposal's items when the proposal is deleted", async () => {
    const repo = new MappingProposalRepository(db);
    const cascadeProposal: MappingProposal = { ...proposal, id: cascadeProposalId };
    const cascadeItems: MappingProposalItem[] = items.map((item) => ({
      ...item,
      id: randomUUID(),
      proposalId: cascadeProposalId,
    }));
    await tx(db, (txn) => new MappingProposalRepository(txn).create(cascadeProposal, cascadeItems));
    expect(await repo.listItems(cascadeProposalId)).toHaveLength(3);

    await db.delete(mappingProposal).where(eq(mappingProposal.id, cascadeProposalId));

    expect(await repo.listItems(cascadeProposalId)).toStrictEqual([]);
    // Belt-and-braces: no orphan item rows remain for the deleted proposal.
    const orphans = await db
      .select()
      .from(mappingProposalItem)
      .where(eq(mappingProposalItem.proposalId, cascadeProposalId));
    expect(orphans).toStrictEqual([]);
  });
});
