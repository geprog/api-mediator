import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  type Database,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  closeDb,
  createDb,
  credential,
  mappingProposal,
  registeredApp,
  resolveDatabaseUrl,
  resourceBinding,
  runMigrations,
  tx,
} from "@mediator/db";
import type {
  ApiSpec,
  MappingProposal,
  MappingProposalItem,
  RegisteredApp,
} from "@mediator/domain";
import { FakeProvider } from "@mediator/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbProposalStore, createDbSpecSource, runDetectionForSpec } from "./run.js";
import {
  giteaIssues,
  giteaMilestones,
  giteaVikunjaShortlist,
  issuesToTasksPeerPeer,
  malformedShortlist,
  tasksToIssuesPeerPeer,
  vikunjaTasks,
} from "./fixtures.js";

/**
 * Live-database integration test for `runDetectionForSpec` (PP-1..3 persistence
 * path). Requires the compose `postgres` service and a resolvable `DATABASE_URL`;
 * excluded from `pnpm verify`, run via
 * `pnpm --filter @mediator/mapping-engine test:integration`. It self-skips when
 * `DATABASE_URL` is unresolvable, and still uses the deterministic `FakeProvider`
 * (no Ollama), so the only external dependency is Postgres.
 *
 * Fixed, ordered spec UUIDs pin a deterministic canonical shortlist orientation
 * (Gitea's id < Vikunja's id → Gitea is the canonical source), so the scripted
 * `giteaVikunjaShortlist` (`issues` ↔ `tasks`) is valid regardless of run order.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}

const APP_GITEA = "11111111-1111-1111-1111-111111111111";
const APP_VIKUNJA = "22222222-2222-2222-2222-222222222222";
const SPEC_GITEA = "aaaaaaaa-0000-0000-0000-000000000001";
const SPEC_VIKUNJA = "bbbbbbbb-0000-0000-0000-000000000002";
const CREATED_AT = new Date("2026-07-10T00:00:00.000Z");

const suite = databaseUrl === undefined ? describe.skip : describe;

suite("runDetectionForSpec persistence integration (requires Postgres)", () => {
  let db: Database;

  const appOf = (id: string, name: string): RegisteredApp => ({
    id,
    name,
    status: "active",
    baseUrl: `https://${name}.example.test`,
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt: CREATED_AT,
  });

  const giteaSpecRow: ApiSpec = {
    id: SPEC_GITEA,
    appId: APP_GITEA,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [giteaIssues, giteaMilestones],
    analysisExclusions: [],
    version: 1,
    contentHash: "sha256:gitea",
    status: "active",
    createdAt: CREATED_AT,
  };
  const vikunjaSpecRow: ApiSpec = {
    id: SPEC_VIKUNJA,
    appId: APP_VIKUNJA,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIR: [vikunjaTasks],
    analysisExclusions: [],
    version: 1,
    contentHash: "sha256:vikunja",
    status: "active",
    createdAt: CREATED_AT,
  };

  function newSequentialId(): () => string {
    let n = 0;
    // A fresh UUID-shaped id per call, deterministic across a run.
    return () => `cccccccc-0000-0000-0000-${String((n += 1)).padStart(12, "0")}`;
  }

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    // Clean slate so `listActive` sees only this test's two specs.
    await db.delete(mappingProposal);
    await db.delete(resourceBinding);
    await db.delete(credential);
    await db.delete(apiSpec);
    await db.delete(registeredApp);

    await tx(db, async (txn) => {
      const apps = new RegisteredAppRepository(txn);
      await apps.create(appOf(APP_GITEA, "gitea"));
      await apps.create(appOf(APP_VIKUNJA, "vikunja"));
      const specs = new ApiSpecRepository(txn);
      await specs.create(giteaSpecRow);
      await specs.create(vikunjaSpecRow);
    });
  });

  afterAll(async () => {
    await db.delete(mappingProposal);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("persists both directional peer-peer proposals with their items (pending)", async () => {
    const provider = new FakeProvider({
      shortlistKey: () => "sl",
      shortlist: { sl: [giteaVikunjaShortlist] },
      detail: {
        "issues=>tasks@peer-peer": [issuesToTasksPeerPeer],
        "tasks=>issues@peer-peer": [tasksToIssuesPeerPeer],
      },
    });

    const result = await runDetectionForSpec(SPEC_GITEA, {
      provider,
      maxRetries: 3,
      promptVersion: "test-prompt-v1",
      newId: newSequentialId(),
      now: () => CREATED_AT,
      specSource: createDbSpecSource(db),
      proposalStore: createDbProposalStore(db),
    });
    expect(result.analyses).toHaveLength(2);

    const repo = new MappingProposalRepository(db);
    const forward = (await repo.listBySourceSpecId(SPEC_GITEA))[0];
    expect(forward).toBeDefined();
    if (forward === undefined) return;

    expect(forward.targetSpecId).toBe(SPEC_VIKUNJA);
    expect(forward.status).toBe("pending");
    expect(forward.shortlistResult?.noCounterpartResources).toEqual([
      { specId: SPEC_GITEA, resourceRef: "milestones" },
    ]);
    expect(forward.shortlistResult?.candidatePairs[0]?.analysisFailed).toBe(false);

    const items = await repo.listItems(forward.id);
    expect(items.filter((i) => i.kind === "operation")).toHaveLength(2);
    const title = items.find(
      (i) =>
        i.kind === "field" &&
        i.sourceRef.target.kind === "field" &&
        i.sourceRef.target.path === "title",
    );
    expect(title?.transformSuggestion).toEqual({ transform: "rename" });
    // The peer-peer identity suggestion (identityCandidate + targetLookupParamRef)
    // was threaded onto the field item and persisted through the real DB round-trip.
    expect(title?.identityCandidate).toBe(true);
    expect(title?.targetLookupParamRef).toBe("filter");
    // The absent/null distinctions survived a real DB round-trip.
    const op = items.find((i) => i.kind === "operation");
    expect(op?.transformSuggestion).toBeNull();
    const unmapped = items.find((i) => i.unmapped);
    expect(unmapped && "targetRef" in unmapped).toBe(false);

    // The reverse direction persisted too (consumer of the shared shortlist).
    const reverse = (await repo.listBySourceSpecId(SPEC_VIKUNJA))[0];
    expect(reverse?.status).toBe("pending");
  });

  it("persists a failed proposal (shortlist cap) with NULL shortlist and no items", async () => {
    // Wipe the pending proposals from the previous case, then re-run with a
    // shortlist that never validates → both directions fail.
    await db.delete(mappingProposal);
    const provider = new FakeProvider({
      shortlistKey: () => "sl",
      shortlist: { sl: [malformedShortlist] },
    });

    await runDetectionForSpec(SPEC_GITEA, {
      provider,
      maxRetries: 1,
      promptVersion: "test-prompt-v1",
      newId: newSequentialId(),
      now: () => CREATED_AT,
      specSource: createDbSpecSource(db),
      proposalStore: createDbProposalStore(db),
    });

    const repo = new MappingProposalRepository(db);
    const forward = (await repo.listBySourceSpecId(SPEC_GITEA))[0];
    expect(forward?.status).toBe("failed");
    expect(forward?.shortlistResult).toBeNull();
    expect(forward === undefined ? [] : await repo.listItems(forward.id)).toEqual([]);
  });

  it("persistAll is atomic: a failure on a later proposal rolls back the earlier one", async () => {
    await db.delete(mappingProposal);
    const store = createDbProposalStore(db);

    const goodId = randomUUID();
    const good: MappingProposal = {
      id: goodId,
      sourceSpecId: SPEC_GITEA,
      targetSpecId: SPEC_VIKUNJA,
      generatedBy: { providerId: "fake", model: "fake-model", promptVersion: "v1" },
      shortlistResult: {
        candidatePairs: [
          {
            sourceResource: "issues",
            targetResource: "tasks",
            confidence: 0.8,
            rationale: "x",
            analysisFailed: false,
          },
        ],
        noCounterpartResources: [],
      },
      status: "pending",
      createdAt: CREATED_AT,
    };
    const goodItem: MappingProposalItem = {
      id: randomUUID(),
      proposalId: goodId,
      kind: "operation",
      sourceRef: {
        resourceRef: "issues",
        target: { kind: "operation", operationId: "listIssues" },
      },
      targetRef: { resourceRef: "tasks", target: { kind: "operation", operationId: "listTasks" } },
      transformSuggestion: null,
      confidenceScore: 0.5,
      ambiguousAlternatives: [],
      unmapped: false,
      rationale: "list ↔ list",
      reviewState: "pending",
    };
    // The second proposal targets a non-existent spec → FK violation on its insert.
    const bad: MappingProposal = { ...good, id: randomUUID(), targetSpecId: randomUUID() };

    await expect(
      store.persistAll([
        { proposal: good, items: [goodItem] },
        { proposal: bad, items: [] },
      ]),
    ).rejects.toThrow();

    // All-or-nothing: the good proposal (and its item) were rolled back with the
    // bad one — zero proposals for the spec, so a re-run produces the set once.
    const repo = new MappingProposalRepository(db);
    expect(await repo.listBySourceSpecId(SPEC_GITEA)).toEqual([]);
    expect(await repo.getById(goodId)).toBeUndefined();
    expect(await repo.listItems(goodId)).toEqual([]);
  });
});
