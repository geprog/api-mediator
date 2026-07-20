import { randomUUID } from "node:crypto";

import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  PollScopeStateRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
  SyncRuleRepository,
  apiSpec,
  approvedMapping,
  auditLog,
  credential,
  graphEdge,
  mappingProposal,
  orderingQueue,
  parkedConflict,
  recordLink,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
  scopeCorrespondence,
  tx,
  type PollScopeStateRecord,
} from "@mediator/db";
import type {
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  ConfirmableRef,
  FieldMapping,
  Ir,
  IrRefTarget,
  MappingProposal,
  MappingProposalItem,
  OperationMapping,
  ProposalElementRef,
  RecordLink,
  RegisteredApp,
  ResourceBinding,
  ScopeComponent,
  ScopeCorrespondence,
  ScopeLink,
  ScopePathBinding,
  SyncRule,
} from "@mediator/domain";
import { eq, inArray, or, sql } from "drizzle-orm";

import { getTestDb } from "../db.js";
import { CREDENTIAL_MASTER_KEY } from "../env.js";
import { GITEA_BASE_URL, VIKUNJA_BASE_URL, type LandscapeTokens } from "./env.js";
import {
  GITEA_REPOS_GROUP,
  GITEA_SCOPED_ISSUES_CREATE_OP,
  GITEA_SCOPED_ISSUES_EDIT_ID_PARAM,
  GITEA_SCOPED_ISSUES_EDIT_OP,
  GITEA_SCOPED_ISSUES_GROUP,
  VIKUNJA_PROJECTS_GROUP,
  VIKUNJA_SCOPED_TASKS_GROUP,
  VIKUNJA_SCOPED_TASKS_LIST_OP,
} from "./scoped-ir.js";

/**
 * The **Slice-D scoped scaffold**: everything the Layer-3 capstone needs seeded over the
 * **real** running Gitea/Vikunja containers, and nothing that the capstone is supposed to
 * prove the mediator does itself.
 *
 * ## What is seeded vs. what the journey drives for real
 *
 * Seeded (the "only the LLM is replayed" boundary, as SU-6 draws it):
 *  - the two apps at their real base URLs, with the real `.tokens.env` credentials;
 *  - one `PROVIDER` spec per app, each carrying **both** the record resource group and its
 *    **container** resource group (`issues`+`repos`, `tasks`+`projects`) — they must share a
 *    spec because SS-18.2 resolves a container resource within the record resource's own IR;
 *  - the four `ResourceBinding`s, with confirmation states chosen so the journey has real
 *    work to do: the container bindings' `collectionReadRef`s are **unconfirmed** (so the
 *    SS-15.2 `container-list-op` gate blocker is genuine), and the record bindings' scope
 *    path parameters are **unconfirmed `constant`** entries — exactly the SS-2 derived
 *    default ingestion produces, so the journey performs the real SS-18.4 kind switch to
 *    `scope-link` rather than being handed one;
 *  - a replayed `MappingProposal` (no LLM) for the issues↔tasks pair;
 *  - the **counterpart** Vikunja→Gitea `ApprovedMapping` + `SyncRule`, which exist only to
 *    prove the no-echo guarantee (assertion 5) and are not the subject of the L3 chain.
 *
 * NOT seeded — the journey makes the mediator produce all of it:
 *  - the `ScopeCorrespondence` (SS-18 must **propose** it on `MappingApproved`);
 *  - the Gitea→Vikunja `ApprovedMapping` + `SyncRule` (the real approve API instantiates them);
 *  - every `ScopeLink` (SS-11/SS-17 discovery must establish them by identity match);
 *  - every `PollScopeState` (SS-13.3/SS-17.4 backfill fan-out must seed them per scope);
 *  - every `RecordLink` and every outbound write.
 *
 * ## Why the counterpart mapping is seeded rather than approved
 *
 * `ScopeCorrespondence` is **one row per canonical resource pair**, and
 * `ScopeCorrespondenceRepository.propose` refreshes an unconfirmed row on conflict. Approving
 * the *reverse* direction would therefore re-derive the same pair's container refs from the
 * reverse direction's write ops (target = Gitea `repos`, and no enumerable Vikunja source
 * container), overwriting the forward proposal and flipping the derived poll mode from
 * `per-scope-enumerated` to `per-scope-pinned`. The capstone approves exactly one direction
 * and seeds the counterpart, so the assertion under test is the forward derivation.
 */

/** A 24h poll interval so the wall-clock Scheduler never races the deterministic SP-5 triggers. */
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Handles to everything the capstone drives + cleans up. */
export interface ScopedSyncScaffold {
  readonly giteaAppId: string;
  readonly vikunjaAppId: string;
  readonly giteaSpecId: string;
  readonly vikunjaSpecId: string;
  /** Gitea `issues` — carries the source-side scope path parameters `owner`/`repo`. */
  readonly giteaIssuesBindingId: string;
  /** Gitea `repos` — the **source container**; its `collectionReadRef` starts unconfirmed. */
  readonly giteaReposBindingId: string;
  /** Vikunja `tasks` — carries the target-side scope path parameter `id`. */
  readonly vikunjaTasksBindingId: string;
  /** Vikunja `projects` — the **target container**; its `collectionReadRef` starts unconfirmed. */
  readonly vikunjaProjectsBindingId: string;
  readonly proposalId: string;
  readonly proposalItems: ScopedProposalItemIds;
  /** The seeded counterpart (Vikunja→Gitea) mapping + rule — the echo direction. */
  readonly mappingV2GId: string;
  readonly ruleV2GId: string;
  /** The canonical, direction-agnostic pair ref both directions and the correspondence share. */
  readonly resourcePairRef: string;
}

/** The proposal's item ids, so the journey can decide each precisely. */
export interface ScopedProposalItemIds {
  readonly listOp: string;
  readonly createOp: string;
  readonly updateOp: string;
  readonly titleField: string;
  readonly bodyField: string;
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
/** A derived-but-unconfirmed operational ref — what ingestion emits before RB-3 confirmation. */
function unconfirmedOp(operationId: string): ConfirmableRef {
  return { value: { kind: "operation", operationId }, confirmedBy: null, confirmedAt: null };
}

/**
 * An **unconfirmed `constant`** scope path binding — the SS-2 derived default. The journey
 * switches it to `scope-link` through the SS-18.4 kind selector; seeding it already
 * `scope-link` would skip the very step Slice C/SS-18.4 exist for.
 */
function unconfirmedScopeConstant(parameterName: string): ScopePathBinding {
  return { kind: "constant", parameterName, value: "", confirmedBy: null, confirmedAt: null };
}

/** A confirmed `sourceScopeRef` (SS-7 is not what this capstone exercises). */
function confirmedSourceScopeRef(components: ScopeComponent[]): ResourceBinding["sourceScopeRef"] {
  return { components, confirmedBy: "operator", confirmedAt: now() };
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
    rawDocument: { openapi: "3.1.0", info: { title: "slice-d-fixture", version: "1" } },
    parsedIR,
    analysisExclusions: [],
    version: 1,
    contentHash: `sha256:${id}`,
    status: "active",
    createdAt: now(),
  };
}

/** The canonical, direction-agnostic `resourcePairRef` (`appId:resourceRef` sorted). */
export function canonicalPairRef(
  a: { appId: string; resourceRef: string },
  b: { appId: string; resourceRef: string },
): string {
  const ta = `${a.appId}:${a.resourceRef}`;
  const tb = `${b.appId}:${b.resourceRef}`;
  return ta <= tb ? `${ta}|${tb}` : `${tb}|${ta}`;
}

function operationRef(resourceRef: string, operationId: string): ProposalElementRef {
  return { resourceRef, target: { kind: "operation", operationId } };
}
function fieldRef(resourceRef: string, path: string): ProposalElementRef {
  return { resourceRef, target: { kind: "field", path } };
}

/** Seed the whole scaffold in one transaction; store credentials after (pooled). */
export async function seedScopedSyncScaffold(tokens: LandscapeTokens): Promise<ScopedSyncScaffold> {
  const db = await getTestDb();

  const giteaAppId = randomUUID();
  const vikunjaAppId = randomUUID();
  const giteaSpecId = randomUUID();
  const vikunjaSpecId = randomUUID();
  const giteaIssuesBindingId = randomUUID();
  const giteaReposBindingId = randomUUID();
  const vikunjaTasksBindingId = randomUUID();
  const vikunjaProjectsBindingId = randomUUID();
  const proposalId = randomUUID();
  const mappingV2GId = randomUUID();
  const ruleV2GId = randomUUID();

  const resourcePairRef = canonicalPairRef(
    { appId: giteaAppId, resourceRef: "issues" },
    { appId: vikunjaAppId, resourceRef: "tasks" },
  );

  const bindings: ResourceBinding[] = [
    {
      id: giteaIssuesBindingId,
      apiSpecId: giteaSpecId,
      resourceRef: "issues",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("giteaListIssues"),
      // The per-record container capture (SS-7). A Gitea ISSUE carries
      // `repository.owner` as a plain string and `repository.name` — these two component
      // KEYS (`owner`, `name`) are the source side of every `ScopeLink` scope key, and
      // `name` is what SS-18.3 pairs to the Vikunja project's `title`.
      sourceScopeRef: confirmedSourceScopeRef([
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ]),
      // Derived-unconfirmed `constant`s (SS-2). The journey switches BOTH to `scope-link`.
      scopePathBindings: [unconfirmedScopeConstant("owner"), unconfirmedScopeConstant("repo")],
    },
    {
      id: giteaReposBindingId,
      apiSpecId: giteaSpecId,
      resourceRef: "repos",
      nativeIdRef: confirmedField("id"),
      // UNCONFIRMED on purpose: SS-15.2 must block the rule with `container-list-op`
      // (side `source`) until the operator confirms this container list op (SS-18.5).
      collectionReadRef: unconfirmedOp("giteaListUserRepos"),
      // The same component KEYS as the issues binding, read from a REPOSITORY record
      // (`owner` is an object here, so the path differs) — this is what discovery
      // captures per enumerated source container.
      sourceScopeRef: confirmedSourceScopeRef([
        { key: "owner", fieldPath: "owner.login" },
        { key: "name", fieldPath: "name" },
      ]),
    },
    {
      id: vikunjaTasksBindingId,
      apiSpecId: vikunjaSpecId,
      resourceRef: "tasks",
      nativeIdRef: confirmedField("id"),
      // The CONTAINER-SCOPED collection read — SS-14.1 fills its `{id}` so an identity
      // lookup searches only within the record's own project.
      collectionReadRef: confirmedOp("vikunjaListProjectTasks"),
      // The Vikunja-side capture for the counterpart direction: a task's own container.
      sourceScopeRef: confirmedSourceScopeRef([{ key: "id", fieldPath: "project_id" }]),
      scopePathBindings: [unconfirmedScopeConstant("id")],
    },
    {
      id: vikunjaProjectsBindingId,
      apiSpecId: vikunjaSpecId,
      resourceRef: "projects",
      nativeIdRef: confirmedField("id"),
      // UNCONFIRMED on purpose — the `container-list-op` blocker for side `target`.
      collectionReadRef: unconfirmedOp("vikunjaListProjects"),
    },
  ];

  const proposal: MappingProposal = {
    id: proposalId,
    sourceSpecId: giteaSpecId,
    targetSpecId: vikunjaSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: {
      candidatePairs: [
        {
          sourceResource: "issues",
          targetResource: "tasks",
          confidence: 0.9,
          rationale: "both track work items, one per container",
          analysisFailed: false,
        },
      ],
      noCounterpartResources: [],
    },
    status: "pending",
    createdAt: now(),
  };

  const base = { proposalId, ambiguousAlternatives: [], reviewState: "pending" as const };
  const listOp: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "operation",
    sourceRef: operationRef("issues", "giteaListIssues"),
    targetRef: operationRef("tasks", "vikunjaListProjectTasks"),
    transformSuggestion: null,
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "scoped list ↔ scoped list",
  };
  const createOp: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "operation",
    sourceRef: operationRef("issues", "giteaCreateIssue"),
    targetRef: operationRef("tasks", "vikunjaCreateTask"),
    transformSuggestion: null,
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "create ↔ create (Vikunja creates with PUT)",
  };
  const updateOp: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "operation",
    sourceRef: operationRef("issues", "giteaEditIssue"),
    targetRef: operationRef("tasks", "vikunjaUpdateTask"),
    transformSuggestion: null,
    confidenceScore: 0.85,
    unmapped: false,
    rationale: "update ↔ update (Vikunja updates with POST)",
  };
  const titleField: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "field",
    sourceRef: fieldRef("issues", "title"),
    targetRef: fieldRef("tasks", "title"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.95,
    unmapped: false,
    rationale: "title ↔ title — the record identity key",
    identityCandidate: true,
  };
  const bodyField: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "field",
    sourceRef: fieldRef("issues", "body"),
    targetRef: fieldRef("tasks", "description"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "body ↔ description",
  };
  const allItems = [listOp, createOp, updateOp, titleField, bodyField];

  // ── The counterpart (Vikunja→Gitea) direction: seeded, not approved (see the note above) ──
  const mappingV2G: ApprovedMapping = {
    id: mappingV2GId,
    sourceSpecId: vikunjaSpecId,
    targetSpecId: giteaSpecId,
    sourceAppId: vikunjaAppId,
    targetAppId: giteaAppId,
    variant: "peer-peer",
    approvedBy: "operator",
    approvedAt: now(),
    status: "active",
  };
  const v2gFields: FieldMapping[] = [
    {
      id: randomUUID(),
      mappingId: mappingV2GId,
      sourcePath: "title",
      targetPath: "title",
      transform: "rename",
      isIdentityKey: true,
    },
    {
      id: randomUUID(),
      mappingId: mappingV2GId,
      sourcePath: "description",
      targetPath: "body",
      transform: "rename",
    },
  ];
  const v2gOperations: OperationMapping[] = [
    {
      id: randomUUID(),
      mappingId: mappingV2GId,
      sourceOperationRef: "tasks/vikunjaUpdateTask",
      targetOperationRef: GITEA_SCOPED_ISSUES_EDIT_OP,
      action: "update",
      targetIdParamRef: GITEA_SCOPED_ISSUES_EDIT_ID_PARAM,
    },
    {
      id: randomUUID(),
      mappingId: mappingV2GId,
      sourceOperationRef: "tasks/vikunjaCreateTask",
      targetOperationRef: GITEA_SCOPED_ISSUES_CREATE_OP,
      action: "create",
    },
  ];
  const ruleV2G: SyncRule = {
    id: ruleV2GId,
    approvedMappingId: mappingV2GId,
    resourcePairRef,
    status: "disabled",
    backfillStatus: "pending",
    backfillMode: "link-only",
    pollOperationRef: VIKUNJA_SCOPED_TASKS_LIST_OP,
  };

  await tx(db, async (txn) => {
    const apps = new RegisteredAppRepository(txn);
    await apps.create(appOf(giteaAppId, `sliced-gitea-${giteaAppId.slice(0, 8)}`, GITEA_BASE_URL));
    await apps.create(
      appOf(vikunjaAppId, `sliced-vikunja-${vikunjaAppId.slice(0, 8)}`, VIKUNJA_BASE_URL),
    );

    const specs = new ApiSpecRepository(txn);
    await specs.create(
      specOf(giteaSpecId, giteaAppId, [GITEA_SCOPED_ISSUES_GROUP, GITEA_REPOS_GROUP]),
    );
    await specs.create(
      specOf(vikunjaSpecId, vikunjaAppId, [VIKUNJA_SCOPED_TASKS_GROUP, VIKUNJA_PROJECTS_GROUP]),
    );

    await new ResourceBindingRepository(txn).createMany(bindings);
    await new MappingProposalRepository(txn).create(proposal, allItems);

    const mappings = new ApprovedMappingRepository(txn);
    await mappings.insert(mappingV2G);
    await new MappingArtifactsRepository(txn).replaceChildren(mappingV2GId, {
      fieldMappings: v2gFields,
      operationMappings: v2gOperations,
      parameterMappings: [],
    });
    await new DownstreamArtifactRepository(txn).insertSyncRuleIfAbsent(ruleV2G);
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
    giteaSpecId,
    vikunjaSpecId,
    giteaIssuesBindingId,
    giteaReposBindingId,
    vikunjaTasksBindingId,
    vikunjaProjectsBindingId,
    proposalId,
    proposalItems: {
      listOp: listOp.id,
      createOp: createOp.id,
      updateOp: updateOp.id,
      titleField: titleField.id,
      bodyField: bodyField.id,
    },
    mappingV2GId,
    ruleV2GId,
    resourcePairRef,
  };
}

// ── Read helpers the capstone asserts through ────────────────────────────────────────

/** The pair's `ScopeCorrespondence` (SS-10) — `undefined` until SS-18 proposes it. */
export async function getScopeCorrespondence(
  resourcePairRef: string,
): Promise<ScopeCorrespondence | undefined> {
  const db = await getTestDb();
  return new ScopeCorrespondenceRepository(db).getByResourcePair(resourcePairRef);
}

/** Every `ScopeLink` established under a correspondence (SS-11 / SS-17 discovery output). */
export async function listScopeLinks(correspondenceId: string): Promise<ScopeLink[]> {
  const db = await getTestDb();
  return new ScopeLinkRepository(db).listByCorrespondence(correspondenceId);
}

/**
 * A rule's per-`(rule, scope)` polling state (SS-13.3) — the direct evidence that a
 * per-scope backfill fanned out and seeded **each** scope's own snapshot/cursor (SS-17.4/17.5)
 * rather than doing one un-scoped read.
 */
export async function listPollScopeStates(ruleId: string): Promise<PollScopeStateRecord[]> {
  const db = await getTestDb();
  return new PollScopeStateRepository(db).listByRule(ruleId);
}

/** The `RecordLink`s of a pair — one per correlated record, each carrying its `scopeRef`. */
export async function listRecordLinks(resourcePairRef: string): Promise<RecordLink[]> {
  const db = await getTestDb();
  const rows = await db
    .select()
    .from(recordLink)
    .where(eq(recordLink.resourcePairRef, resourcePairRef));
  return rows as unknown as RecordLink[];
}

/**
 * The sync-event audit rows for a rule, optionally filtered by status (e.g. `skipped-loop`).
 * Read straight from the store rather than through `GET /api/sync-events`, so an assertion
 * about *engine behavior* does not also depend on the audit DTO's shape.
 */
export async function listScopedRuleSyncEvents(
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

/** An approved mapping's assembled field + operation mappings (what the sync pipeline reads). */
export async function listMappingArtifacts(
  mappingId: string,
): Promise<{ fieldMappings: FieldMapping[]; operationMappings: OperationMapping[] }> {
  const db = await getTestDb();
  const repo = new MappingArtifactsRepository(db);
  return {
    fieldMappings: await repo.listFieldMappings(mappingId),
    operationMappings: await repo.listOperationMappings(mappingId),
  };
}

/** The `SyncRule`s instantiated for an approved mapping. */
export async function listSyncRulesForMapping(mappingId: string): Promise<SyncRule[]> {
  const db = await getTestDb();
  return new DownstreamArtifactRepository(db).listSyncRulesByMapping(mappingId);
}

/** A rule's current row (status + backfillStatus), for awaiting backfill completion / go-live. */
export async function getScopedRule(ruleId: string): Promise<SyncRule | undefined> {
  const db = await getTestDb();
  return new SyncRuleRepository(db).getById(ruleId);
}

/** The single active `ApprovedMapping` for a directional spec pair, once approval created one. */
export async function getActiveDirectionalMapping(
  sourceSpecId: string,
  targetSpecId: string,
): Promise<ApprovedMapping | undefined> {
  const db = await getTestDb();
  return new ApprovedMappingRepository(db).getActiveByDirectionalSpecPair(
    sourceSpecId,
    targetSpecId,
  );
}

// ── Cleanup ─────────────────────────────────────────────────────────────────────────

/** Remove everything the scaffold (and any sync run it drove) created, in FK-safe order. */
export async function cleanupScopedSyncScaffold(scaffold: ScopedSyncScaffold): Promise<void> {
  const db = await getTestDb();
  const appIds = [scaffold.giteaAppId, scaffold.vikunjaAppId];

  // The runtime tables this journey is the only writer of.
  await db.delete(orderingQueue);
  await db.delete(parkedConflict);
  await db.delete(recordLink).where(eq(recordLink.resourcePairRef, scaffold.resourcePairRef));
  // `scope_link` is not re-exported from `@mediator/db`'s schema surface (only its
  // repository is), and it has no ON DELETE CASCADE from `scope_correspondence` — so the
  // links must go first, by statement, or the correspondence delete hits an FK violation.
  await db.execute(
    sql`delete from scope_link where resource_pair_ref = ${scaffold.resourcePairRef}`,
  );
  await db
    .delete(scopeCorrespondence)
    .where(eq(scopeCorrespondence.resourcePairRef, scaffold.resourcePairRef));

  const mappingRows = await db
    .select({ id: approvedMapping.id })
    .from(approvedMapping)
    .where(
      or(
        inArray(approvedMapping.sourceAppId, appIds),
        inArray(approvedMapping.targetAppId, appIds),
      ),
    );
  const mappingIds = mappingRows.map((row) => row.id);
  if (mappingIds.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.relatedMappingId, mappingIds));
    // Break the counterpart self-reference before deleting the mappings.
    const mappings = new ApprovedMappingRepository(db);
    for (const id of mappingIds) {
      await mappings.setCounterpart(id, null);
    }
    // approvedMapping delete cascades sync_rule (→ poll_snapshot / poll_scope_state)
    // + field/operation mappings.
    await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
  }

  await db.delete(auditLog).where(eq(auditLog.relatedProposalId, scaffold.proposalId));
  await db.delete(mappingProposal).where(eq(mappingProposal.id, scaffold.proposalId));

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
