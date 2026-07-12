import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  closeDb,
  createDb,
  graphEdge,
  mappingDetectionJob,
  mappingProposal,
  registeredApp,
  runMigrations,
  tx,
  type Database,
} from "@mediator/db";
import type { ApprovedMapping, SyncRule } from "@mediator/domain";
import { eq, inArray, or } from "drizzle-orm";

import { DATABASE_URL } from "./env.js";
import type { PeerPeerProposalFixture } from "./proposal-fixture.js";

/**
 * Direct database access for the RU-5 journey: it seeds a **replayed** proposal
 * (no LLM) straight into the compose Postgres and inspects the artifacts the
 * approve/instantiation path produces, exactly as the backend's approval
 * integration test does — but from the Playwright process so a single journey can
 * both seed and assert.
 *
 * One pooled {@link Database} is shared for the worker (workers = 1); migrations
 * run once (idempotent). The spec that uses this closes it in its `afterAll`.
 */

let db: Database | undefined;
let migrated = false;

/** Lazily create the shared pool and ensure the schema is migrated. */
export async function getTestDb(): Promise<Database> {
  if (db === undefined) {
    db = createDb(DATABASE_URL);
  }
  if (!migrated) {
    await runMigrations(db);
    migrated = true;
  }
  return db;
}

/** Close the shared pool (call once, from the last spec's `afterAll`). */
export async function closeTestDb(): Promise<void> {
  if (db !== undefined) {
    await closeDb(db);
    db = undefined;
    migrated = false;
  }
}

/**
 * Seed the fixture's two apps + two specs + proposal + items in one transaction —
 * the persisted, LLM-free proposal the journey opens (RU-5 crit 1).
 */
export async function seedPeerPeerProposal(fixture: PeerPeerProposalFixture): Promise<void> {
  const handle = await getTestDb();
  await tx(handle, async (txn) => {
    const apps = new RegisteredAppRepository(txn);
    await apps.create(fixture.sourceApp);
    await apps.create(fixture.targetApp);
    const specs = new ApiSpecRepository(txn);
    await specs.create(fixture.sourceSpec);
    await specs.create(fixture.targetSpec);
    await new MappingProposalRepository(txn).create(fixture.proposal, [...fixture.allItems]);
  });
}

/**
 * Remove everything the fixture (and any approve it triggered) created, in
 * FK-safe order. `approved_mapping` deletion cascades its `sync_rule` +
 * field/operation/parameter children; `mapping_proposal` cascades its items.
 */
export async function cleanupPeerPeerProposal(fixture: PeerPeerProposalFixture): Promise<void> {
  const handle = await getTestDb();
  const appIds = [fixture.sourceApp.id, fixture.targetApp.id];
  const specIds = [fixture.sourceSpec.id, fixture.targetSpec.id];

  await handle.delete(auditLog).where(eq(auditLog.relatedProposalId, fixture.proposal.id));
  await handle
    .delete(graphEdge)
    .where(or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)));
  await handle
    .delete(approvedMapping)
    .where(
      or(
        inArray(approvedMapping.sourceAppId, appIds),
        inArray(approvedMapping.targetAppId, appIds),
      ),
    );
  // Defensive: the reconciliation sweep (5-min interval) could enqueue detection
  // jobs for the seeded specs; remove any before dropping the specs.
  await handle.delete(mappingDetectionJob).where(inArray(mappingDetectionJob.apiSpecId, specIds));
  await handle.delete(mappingProposal).where(eq(mappingProposal.id, fixture.proposal.id));
  await handle.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
  await handle.delete(registeredApp).where(inArray(registeredApp.id, appIds));
}

/** The single active `ApprovedMapping` for a directional spec pair, if approval created one. */
export async function getActiveMapping(
  sourceSpecId: string,
  targetSpecId: string,
): Promise<ApprovedMapping | undefined> {
  const handle = await getTestDb();
  return new ApprovedMappingRepository(handle).getActiveByDirectionalSpecPair(
    sourceSpecId,
    targetSpecId,
  );
}

/** The disabled `SyncRule`s instantiated for a mapping (empty until the reaction settles). */
export async function listSyncRules(mappingId: string): Promise<SyncRule[]> {
  const handle = await getTestDb();
  return new DownstreamArtifactRepository(handle).listSyncRulesByMapping(mappingId);
}

/** A proposal's current `status` (e.g. `pending` / `partially_approved`). */
export async function getProposalStatus(proposalId: string): Promise<string | undefined> {
  const handle = await getTestDb();
  const proposal = await new MappingProposalRepository(handle).getById(proposalId);
  return proposal?.status;
}

/** The audit entry `type`s recorded against a proposal (all should be `mapping-decision`). */
export async function listAuditTypesForProposal(proposalId: string): Promise<string[]> {
  const handle = await getTestDb();
  const rows = await handle
    .select({ type: auditLog.type })
    .from(auditLog)
    .where(eq(auditLog.relatedProposalId, proposalId));
  return rows.map((row) => row.type);
}
