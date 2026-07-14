import { randomUUID } from "node:crypto";

import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  credential,
  graphEdge,
  orderingQueue,
  parkedConflict,
  recordLink,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
  tx,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  ConfirmableRef,
  FieldMapping,
  Ir,
  IrRefTarget,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";
import { inArray, or } from "drizzle-orm";

import { getTestDb } from "../db.js";
import { CREDENTIAL_MASTER_KEY } from "../env.js";
import { GITEA_BASE_URL, VIKUNJA_BASE_URL, type LandscapeTokens } from "./env.js";
import {
  GITEA_COMMENTS_EDIT_OP,
  GITEA_COMMENTS_GROUP,
  GITEA_COMMENTS_LIST_OP,
  GITEA_ISSUES_EDIT_ID_PARAM,
  GITEA_ISSUES_EDIT_OP,
  GITEA_ISSUES_GROUP,
  GITEA_ISSUES_LIST_OP,
  VIKUNJA_COMMENTS_GROUP,
  VIKUNJA_COMMENTS_UPDATE_ID_PARAM,
  VIKUNJA_COMMENTS_UPDATE_OP,
  VIKUNJA_TASKS_GROUP,
  VIKUNJA_TASKS_LIST_OP,
  VIKUNJA_TASKS_UPDATE_ID_PARAM,
  VIKUNJA_TASKS_UPDATE_OP,
} from "./ir.js";

/**
 * The **replayed-mapping scaffold** for the SU-6 capstone: everything the LLM/review
 * flow would have produced, seeded directly into Postgres over the **real** running
 * Gitea/Vikunja apps. This is the "only the LLM is replayed" boundary — the two apps
 * (real base URLs + real `.tokens.env` credentials, encrypted under the backend's own
 * master key), their specs (the faithful minimal IR in `ir.ts`, at the apps' real
 * paths), the confirmed `ResourceBinding`s, the two counterpart peer-peer
 * `ApprovedMapping`s (issues↔tasks, title = identity), and the two disabled `SyncRule`s
 * are all seeded; the sync round, its outbound writes, and the loop-echo skip are then
 * exercised for real against the live containers.
 *
 * A third mapping/rule for the **identity-less** issue-comments↔task-comments pair
 * (`ground-truth.yaml`: comments have no natural business key) is seeded with **no**
 * identity `FieldMapping`, so the enablement gate blocks it on "still needs identity
 * key" (SU-6.5).
 *
 * Mirrors `apps/backend/.../sync-poll-trigger.integration.spec.ts`'s seeding, but with
 * real URLs/tokens/refs instead of a fake landscape.
 */

/** A 24h poll interval so the wall-clock Scheduler never auto-polls mid-journey — every poll is the deterministic trigger. */
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The identity value both apps share for the exercised work item ("title"). */
export const SYNCED_ITEM_TITLE = "Fix login button alignment";

/** Handles to everything the journey drives + cleans up. */
export interface SyncScaffold {
  readonly giteaAppId: string;
  readonly vikunjaAppId: string;
  readonly mappingG2VId: string;
  readonly mappingV2GId: string;
  readonly mappingCommentsId: string;
  /** Gitea→Vikunja issues rule (the writing direction). */
  readonly ruleG2VId: string;
  /** Vikunja→Gitea issues rule (the echo direction). */
  readonly ruleV2GId: string;
  /** Gitea→Vikunja comments rule (identity-less — enablement stays blocked). */
  readonly ruleCommentsId: string;
  readonly issuesPairRef: string;
  readonly commentsPairRef: string;
}

const now = (): Date => new Date();

function confirmed(value: IrRefTarget): ConfirmableRef {
  return { value, confirmedBy: "operator", confirmedAt: now() };
}
function confirmedOp(operationId: string): ConfirmableRef {
  return confirmed({ kind: "operation", operationId });
}
function confirmedField(path: string): ConfirmableRef {
  return confirmed({ kind: "field", path });
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
      defaultPollInterval: POLL_INTERVAL_MS,
    },
    createdAt: now(),
  };
}

function specOf(id: string, appId: string, parsedIR: Ir): ApiSpec {
  return {
    id,
    appId,
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0", info: { title: "su6-fixture", version: "1" } },
    parsedIR,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: now(),
  };
}

function mappingOf(
  id: string,
  sourceSpecId: string,
  targetSpecId: string,
  sourceAppId: string,
  targetAppId: string,
): ApprovedMapping {
  return {
    id,
    sourceSpecId,
    targetSpecId,
    sourceAppId,
    targetAppId,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: now(),
    status: "active",
  };
}

/** The canonical, direction-agnostic `resourcePairRef` (`appId:resourceRef` sorted). */
function canonicalPairRef(
  a: { appId: string; resourceRef: string },
  b: { appId: string; resourceRef: string },
): string {
  const ta = `${a.appId}:${a.resourceRef}`;
  const tb = `${b.appId}:${b.resourceRef}`;
  return ta <= tb ? `${ta}|${tb}` : `${tb}|${ta}`;
}

/** An `issues↔tasks` field set for one direction (title = value-preserving identity key). */
function issuesFields(mappingId: string, direction: "g2v" | "v2g"): FieldMapping[] {
  const bodyField: FieldMapping =
    direction === "g2v"
      ? { id: randomUUID(), mappingId, sourcePath: "body", targetPath: "description", transform: "rename" }
      : { id: randomUUID(), mappingId, sourcePath: "description", targetPath: "body", transform: "rename" };
  return [
    {
      id: randomUUID(),
      mappingId,
      sourcePath: "title",
      targetPath: "title",
      transform: "rename",
      isIdentityKey: true,
    },
    bodyField,
  ];
}

function issuesUpdateOp(
  mappingId: string,
  sourceOperationRef: string,
  targetOperationRef: string,
  targetIdParamRef: string,
): OperationMapping {
  return {
    id: randomUUID(),
    mappingId,
    sourceOperationRef,
    targetOperationRef,
    action: "update",
    targetIdParamRef,
  };
}

/** Seed the whole scaffold in one transaction; store credentials after (pooled). */
export async function seedSyncScaffold(tokens: LandscapeTokens): Promise<SyncScaffold> {
  const db = await getTestDb();

  const giteaAppId = randomUUID();
  const vikunjaAppId = randomUUID();
  // One spec per resource group: an `ApprovedMapping` is unique per active
  // (source_spec_id, target_spec_id) direction, so issues↔tasks and comments↔comments
  // must live in distinct spec pairs (they share the two apps, not the two specs).
  const giteaIssuesSpecId = randomUUID();
  const giteaCommentsSpecId = randomUUID();
  const vikunjaTasksSpecId = randomUUID();
  const vikunjaCommentsSpecId = randomUUID();
  const mappingG2VId = randomUUID();
  const mappingV2GId = randomUUID();
  const mappingCommentsId = randomUUID();
  const ruleG2VId = randomUUID();
  const ruleV2GId = randomUUID();
  const ruleCommentsId = randomUUID();

  const issuesPairRef = canonicalPairRef(
    { appId: giteaAppId, resourceRef: "issues" },
    { appId: vikunjaAppId, resourceRef: "tasks" },
  );
  const commentsPairRef = canonicalPairRef(
    { appId: giteaAppId, resourceRef: "comments" },
    { appId: vikunjaAppId, resourceRef: "comments" },
  );

  const bindings: ResourceBinding[] = [
    {
      id: randomUUID(),
      apiSpecId: giteaIssuesSpecId,
      resourceRef: "issues",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("giteaSearchIssues"),
    },
    {
      id: randomUUID(),
      apiSpecId: giteaCommentsSpecId,
      resourceRef: "comments",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("giteaListComments"),
    },
    {
      id: randomUUID(),
      apiSpecId: vikunjaTasksSpecId,
      resourceRef: "tasks",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("vikunjaListTasks"),
    },
    {
      id: randomUUID(),
      apiSpecId: vikunjaCommentsSpecId,
      resourceRef: "comments",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("vikunjaListComments"),
    },
  ];

  const ruleG2V: SyncRule = {
    id: ruleG2VId,
    approvedMappingId: mappingG2VId,
    resourcePairRef: issuesPairRef,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: GITEA_ISSUES_LIST_OP,
  };
  const ruleV2G: SyncRule = {
    id: ruleV2GId,
    approvedMappingId: mappingV2GId,
    resourcePairRef: issuesPairRef,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: VIKUNJA_TASKS_LIST_OP,
  };
  const ruleComments: SyncRule = {
    id: ruleCommentsId,
    approvedMappingId: mappingCommentsId,
    resourcePairRef: commentsPairRef,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: GITEA_COMMENTS_LIST_OP,
  };

  await tx(db, async (txn) => {
    const apps = new RegisteredAppRepository(txn);
    await apps.create(appOf(giteaAppId, `su6-gitea-${giteaAppId.slice(0, 8)}`, GITEA_BASE_URL));
    await apps.create(
      appOf(vikunjaAppId, `su6-vikunja-${vikunjaAppId.slice(0, 8)}`, VIKUNJA_BASE_URL),
    );

    const specs = new ApiSpecRepository(txn);
    await specs.create(specOf(giteaIssuesSpecId, giteaAppId, [GITEA_ISSUES_GROUP]));
    await specs.create(specOf(giteaCommentsSpecId, giteaAppId, [GITEA_COMMENTS_GROUP]));
    await specs.create(specOf(vikunjaTasksSpecId, vikunjaAppId, [VIKUNJA_TASKS_GROUP]));
    await specs.create(specOf(vikunjaCommentsSpecId, vikunjaAppId, [VIKUNJA_COMMENTS_GROUP]));

    await new ResourceBindingRepository(txn).createMany(bindings);

    const mappings = new ApprovedMappingRepository(txn);
    await mappings.insert(
      mappingOf(mappingG2VId, giteaIssuesSpecId, vikunjaTasksSpecId, giteaAppId, vikunjaAppId),
    );
    await mappings.insert(
      mappingOf(mappingV2GId, vikunjaTasksSpecId, giteaIssuesSpecId, vikunjaAppId, giteaAppId),
    );
    await mappings.insert(
      mappingOf(mappingCommentsId, giteaCommentsSpecId, vikunjaCommentsSpecId, giteaAppId, vikunjaAppId),
    );
    await mappings.setCounterpart(mappingG2VId, mappingV2GId);
    await mappings.setCounterpart(mappingV2GId, mappingG2VId);

    const artifacts = new MappingArtifactsRepository(txn);
    await artifacts.replaceChildren(mappingG2VId, {
      fieldMappings: issuesFields(mappingG2VId, "g2v"),
      operationMappings: [
        issuesUpdateOp(
          mappingG2VId,
          GITEA_ISSUES_EDIT_OP,
          VIKUNJA_TASKS_UPDATE_OP,
          VIKUNJA_TASKS_UPDATE_ID_PARAM,
        ),
      ],
      parameterMappings: [],
    });
    await artifacts.replaceChildren(mappingV2GId, {
      fieldMappings: issuesFields(mappingV2GId, "v2g"),
      operationMappings: [
        issuesUpdateOp(
          mappingV2GId,
          VIKUNJA_TASKS_UPDATE_OP,
          GITEA_ISSUES_EDIT_OP,
          GITEA_ISSUES_EDIT_ID_PARAM,
        ),
      ],
      parameterMappings: [],
    });
    // The identity-less comments mapping: a body↔comment rename, NO identity FieldMapping.
    await artifacts.replaceChildren(mappingCommentsId, {
      fieldMappings: [
        { id: randomUUID(), mappingId: mappingCommentsId, sourcePath: "body", targetPath: "comment", transform: "rename" },
      ],
      operationMappings: [
        issuesUpdateOp(
          mappingCommentsId,
          GITEA_COMMENTS_EDIT_OP,
          VIKUNJA_COMMENTS_UPDATE_OP,
          VIKUNJA_COMMENTS_UPDATE_ID_PARAM,
        ),
      ],
      parameterMappings: [],
    });

    const downstream = new DownstreamArtifactRepository(txn);
    await downstream.insertSyncRuleIfAbsent(ruleG2V);
    await downstream.insertSyncRuleIfAbsent(ruleV2G);
    await downstream.insertSyncRuleIfAbsent(ruleComments);
  });

  // Credentials (write-only, encrypted under the SAME master key the backend boots with).
  const store = new CredentialStore(
    new DbCredentialPersistence(db),
    new EnvKeyProvider(Buffer.from(CREDENTIAL_MASTER_KEY, "base64")),
  );
  await store.store(giteaAppId, { secret: { type: "apiKey", apiKey: tokens.gitea } });
  await store.store(vikunjaAppId, { secret: { type: "apiKey", apiKey: tokens.vikunja } });

  return {
    giteaAppId,
    vikunjaAppId,
    mappingG2VId,
    mappingV2GId,
    mappingCommentsId,
    ruleG2VId,
    ruleV2GId,
    ruleCommentsId,
    issuesPairRef,
    commentsPairRef,
  };
}

/** Remove everything the scaffold (and any sync run it drove) created, in FK-safe order. */
export async function cleanupSyncScaffold(scaffold: SyncScaffold): Promise<void> {
  const db = await getTestDb();
  const appIds = [scaffold.giteaAppId, scaffold.vikunjaAppId];
  const mappingIds = [scaffold.mappingG2VId, scaffold.mappingV2GId, scaffold.mappingCommentsId];
  const ruleIds = [scaffold.ruleG2VId, scaffold.ruleV2GId, scaffold.ruleCommentsId];
  const pairRefs = [scaffold.issuesPairRef, scaffold.commentsPairRef];

  // Runtime tables with no FK cascade to lean on (recordLink has no inbound FK by design):
  // ordering queue + parked conflicts are only ever populated by this sync journey.
  await db.delete(orderingQueue);
  await db.delete(parkedConflict);
  // recordLink → syncFieldState cascades on delete.
  await db.delete(recordLink).where(inArray(recordLink.resourcePairRef, pairRefs));
  await db.delete(auditLog).where(inArray(auditLog.relatedRuleId, ruleIds));
  await db.delete(auditLog).where(inArray(auditLog.relatedMappingId, mappingIds));

  // Break the counterpart self-reference before deleting the mappings.
  await new ApprovedMappingRepository(db).setCounterpart(scaffold.mappingG2VId, null);
  await new ApprovedMappingRepository(db).setCounterpart(scaffold.mappingV2GId, null);
  // approvedMapping delete cascades sync_rule (→ poll_snapshot) + field/operation mappings.
  await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));

  await db.delete(credential).where(inArray(credential.appId, appIds));
  // resource_binding(+_ref) do NOT cascade from api_spec — delete them first (refs → bindings).
  const specRows = await db
    .select({ id: apiSpec.id })
    .from(apiSpec)
    .where(inArray(apiSpec.appId, appIds));
  const specIds = specRows.map((row) => row.id);
  if (specIds.length > 0) {
    const bindingRows = await db
      .select({ id: resourceBinding.id })
      .from(resourceBinding)
      .where(inArray(resourceBinding.apiSpecId, specIds));
    const bindingIds = bindingRows.map((row) => row.id);
    if (bindingIds.length > 0) {
      await db
        .delete(resourceBindingRef)
        .where(inArray(resourceBindingRef.resourceBindingId, bindingIds));
    }
    await db.delete(resourceBinding).where(inArray(resourceBinding.apiSpecId, specIds));
  }
  await db.delete(apiSpec).where(inArray(apiSpec.appId, appIds));
  await db
    .delete(graphEdge)
    .where(or(inArray(graphEdge.sourceNodeId, appIds), inArray(graphEdge.targetNodeId, appIds)));
  await db.delete(registeredApp).where(inArray(registeredApp.id, appIds));
}

/** A rule's current row (status + backfillStatus), for awaiting backfill completion / go-live. */
export async function getRule(ruleId: string): Promise<SyncRule | undefined> {
  const db = await getTestDb();
  return new SyncRuleRepository(db).getById(ruleId);
}

/** The sync-event audit rows for a rule, optionally filtered by status (e.g. `skipped-loop`). */
export async function listRuleSyncEvents(
  ruleId: string,
  status?: AuditLogEntry["status"],
): Promise<AuditLogEntry[]> {
  const db = await getTestDb();
  return new AuditLogRepository(db).querySyncEvents({
    relatedRuleId: ruleId,
    ...(status !== undefined ? { status } : {}),
    limit: 100,
  });
}
