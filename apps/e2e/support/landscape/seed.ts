import { randomUUID } from "node:crypto";

import { expect, type APIRequestContext } from "@playwright/test";
import { CredentialStore, DbCredentialPersistence, EnvKeyProvider } from "@mediator/credentials";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
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
  MappingProposal,
  MappingProposalItem,
  OperationMapping,
  ProposalElementRef,
  RegisteredApp,
  ResourceBinding,
  ScopePathBinding,
  SyncRule,
} from "@mediator/domain";
import { inArray, like, or } from "drizzle-orm";

import { getTestDb } from "../db.js";
import { BACKEND_ORIGIN, basicAuthHeader, CREDENTIAL_MASTER_KEY, OPERATOR } from "../env.js";
import { GITEA_BASE_URL, VIKUNJA_BASE_URL, type LandscapeTokens } from "./env.js";
import {
  GITEA_COMMENTS_GROUP,
  GITEA_COMMENTS_LIST_OP,
  GITEA_ISSUES_GROUP,
  GITEA_ISSUES_LIST_OP,
  VIKUNJA_COMMENTS_GROUP,
  VIKUNJA_TASKS_GROUP,
  VIKUNJA_TASKS_LIST_OP,
} from "./ir.js";

/**
 * The **replayed-proposal scaffold** for the SU-6 capstone: everything the *detection*
 * stage would have produced, seeded directly into Postgres over the **real** running
 * Gitea/Vikunja apps — and nothing downstream of it.
 *
 * ## Where the replay boundary sits, and why it moved
 *
 * The boundary is drawn at the **LLM**, not at the approval. Seeded: the two apps (real
 * base URLs + real `.tokens.env` credentials, encrypted under the backend's own master
 * key), their specs (the faithful minimal IR in `ir.ts`, at the apps' real paths), the
 * confirmed `ResourceBinding`s, and three **`MappingProposal`s** — the exact artifact a
 * detection run emits, built without contacting any model.
 *
 * Everything downstream is produced by the **real** approval path
 * (`POST /api/mapping-proposals/:id/approve`, {@link approveSyncScaffold}): the
 * `ApprovedMapping`s, their `FieldMapping`/`OperationMapping` children, the counterpart
 * linking, and the `SyncRule`s the `MappingApproved` reaction instantiates.
 *
 * This used to hand-seed those artifacts, and that is precisely why a P0 hid for a whole
 * phase. `FieldMapping.sourcePath`/`targetPath` are **resource-qualified**
 * (`issues/title`, `docs/architecture/data-model.md` *FieldMapping*) — one
 * `ApprovedMapping` covers N resource pairs and the leading `resourceRef` is the only
 * thing saying which pair a field belongs to. The old scaffold seeded **bare** paths
 * (`title`), so the approval→sync seam was never crossed by any test: every real
 * approval's propagation dead-lettered, fetch-and-match compared an absent identity path
 * (so every record read as new — silent duplicate creation), `SyncFieldState` baselines
 * were poisoned, and the drift-check/PUT read-carry broke. A green test that encodes a
 * contract production never produces is worse than no test, because it reads as proof.
 *
 * A third proposal covers the **identity-less** issue-comments↔task-comments pair
 * (`ground-truth.yaml`: comments have no natural business key). It is approved with **no**
 * `identityKeys`, so the real approval produces a mapping with no identity `FieldMapping`
 * and the enablement gate blocks its rule on "still needs identity key" (SU-6.5).
 */

/** A 24h poll interval so the wall-clock Scheduler never auto-polls mid-journey — every poll is the deterministic trigger. */
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The identity value both apps share for the exercised work item ("title"). */
export const SYNCED_ITEM_TITLE = "Fix login button alignment";

/** The item ids of an issues↔tasks proposal, so the journey can decide each precisely. */
export interface IssuesProposalItemIds {
  readonly updateOp: string;
  /** The identity-candidate field pairing (title ↔ title) — confirmed at approve. */
  readonly titleField: string;
  readonly bodyField: string;
}

/** The item ids of the identity-less comments proposal. */
export interface CommentsProposalItemIds {
  readonly updateOp: string;
  readonly bodyField: string;
}

/** One replayed proposal: its id plus its item ids. */
export interface SeededProposal<TItems> {
  readonly id: string;
  readonly items: TItems;
}

/** The three replayed proposals the journey approves for real. */
export interface ScaffoldProposals {
  /** Gitea issues → Vikunja tasks (the writing direction). */
  readonly issuesG2V: SeededProposal<IssuesProposalItemIds>;
  /** Vikunja tasks → Gitea issues (the echo direction; approved second, so it links the counterpart). */
  readonly issuesV2G: SeededProposal<IssuesProposalItemIds>;
  /** Gitea comments → Vikunja comments (identity-less — approved with no identity key). */
  readonly comments: SeededProposal<CommentsProposalItemIds>;
}

/** Handles to everything seeded ahead of approval — and what cleanup deletes. */
export interface SyncScaffold {
  readonly giteaAppId: string;
  readonly vikunjaAppId: string;
  readonly giteaIssuesSpecId: string;
  readonly giteaCommentsSpecId: string;
  readonly vikunjaTasksSpecId: string;
  readonly vikunjaCommentsSpecId: string;
  /**
   * The Gitea `issues` `ResourceBinding` — carries the unconfirmed `owner`/`repo` scope
   * `constant` bindings the journey confirms via the SS-3 scope-patch API. Shared by both
   * issues rules (G2V polls it as source; V2G looks up + would-write it as target).
   */
  readonly giteaIssuesBindingId: string;
  readonly proposals: ScaffoldProposals;
  readonly issuesPairRef: string;
  readonly commentsPairRef: string;
}

/** What the **real** approval path produced — discovered, never assumed. */
export interface ApprovedSyncArtifacts {
  readonly mappingG2VId: string;
  readonly mappingV2GId: string;
  readonly mappingCommentsId: string;
  /** Gitea→Vikunja issues rule (the writing direction). */
  readonly ruleG2VId: string;
  /** Vikunja→Gitea issues rule (the echo direction). */
  readonly ruleV2GId: string;
  /** Gitea→Vikunja comments rule (identity-less — enablement stays blocked). */
  readonly ruleCommentsId: string;
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

/**
 * An **unconfirmed** `constant` scope path-parameter binding — the derived-but-not-yet-
 * supplied shape ingestion emits (SS-2 criterion 2): empty value, both confirmation stamps
 * null. The journey confirms it through the real `PATCH /api/resource-bindings/:id`
 * scope-patch (SS-3), proving the gate blocks until it is confirmed.
 */
function unconfirmedScopeConstant(parameterName: string): ScopePathBinding {
  return { kind: "constant", parameterName, value: "", confirmedBy: null, confirmedAt: null };
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

/** The canonical, direction-agnostic `resourcePairRef` (`appId:resourceRef` sorted). */
function canonicalPairRef(
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

function proposalOf(
  id: string,
  sourceSpecId: string,
  targetSpecId: string,
  sourceResource: string,
  targetResource: string,
): MappingProposal {
  return {
    id,
    sourceSpecId,
    targetSpecId,
    generatedBy: { providerId: "fixture", model: "fixture", promptVersion: "v1" },
    shortlistResult: {
      candidatePairs: [
        {
          sourceResource,
          targetResource,
          confidence: 0.9,
          rationale: "both track work items",
          analysisFailed: false,
        },
      ],
      noCounterpartResources: [],
    },
    status: "pending",
    createdAt: now(),
  };
}

/**
 * One direction's replayed issues↔tasks proposal: the update operation plus the two field
 * correspondences (title = the identity candidate, body↔description a plain rename). The
 * `resourceRef`s live on the item refs — the approval path is what serializes them into
 * the resource-qualified `FieldMapping` paths production stores.
 */
function issuesProposalItems(
  proposalId: string,
  source: { resource: string; updateOp: string; title: string; body: string },
  target: { resource: string; updateOp: string; title: string; body: string },
): { items: MappingProposalItem[]; ids: IssuesProposalItemIds } {
  const base = { proposalId, ambiguousAlternatives: [], reviewState: "pending" as const };
  const updateOp: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "operation",
    sourceRef: operationRef(source.resource, source.updateOp),
    targetRef: operationRef(target.resource, target.updateOp),
    transformSuggestion: null,
    confidenceScore: 0.85,
    unmapped: false,
    rationale: "update ↔ update",
  };
  const titleField: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "field",
    sourceRef: fieldRef(source.resource, source.title),
    targetRef: fieldRef(target.resource, target.title),
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
    sourceRef: fieldRef(source.resource, source.body),
    targetRef: fieldRef(target.resource, target.body),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.9,
    unmapped: false,
    rationale: "body ↔ description",
  };
  return {
    items: [updateOp, titleField, bodyField],
    ids: { updateOp: updateOp.id, titleField: titleField.id, bodyField: bodyField.id },
  };
}

/** The identity-less comments proposal: a body↔comment rename and its update op — no identity candidate. */
function commentsProposalItems(proposalId: string): {
  items: MappingProposalItem[];
  ids: CommentsProposalItemIds;
} {
  const base = { proposalId, ambiguousAlternatives: [], reviewState: "pending" as const };
  const updateOp: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "operation",
    sourceRef: operationRef("comments", "giteaUpdateComment"),
    targetRef: operationRef("comments", "vikunjaUpdateComment"),
    transformSuggestion: null,
    confidenceScore: 0.8,
    unmapped: false,
    rationale: "update ↔ update",
  };
  const bodyField: MappingProposalItem = {
    ...base,
    id: randomUUID(),
    kind: "field",
    sourceRef: fieldRef("comments", "body"),
    targetRef: fieldRef("comments", "comment"),
    transformSuggestion: { transform: "rename" },
    confidenceScore: 0.85,
    unmapped: false,
    // No `identityCandidate`: a comment carries no natural business key, which is the
    // whole point of SU-6.5.
    rationale: "body ↔ comment",
  };
  return { items: [updateOp, bodyField], ids: { updateOp: updateOp.id, bodyField: bodyField.id } };
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
  const giteaIssuesBindingId = randomUUID();

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
      id: giteaIssuesBindingId,
      apiSpecId: giteaIssuesSpecId,
      resourceRef: "issues",
      nativeIdRef: confirmedField("id"),
      collectionReadRef: confirmedOp("giteaListIssues"),
      // The scoped issue ops carry `{owner}`/`{repo}` scope path params, derived unconfirmed
      // (SS-2). The journey confirms them (alice/phoenix) via the SS-3 scope-patch API, and
      // the SS-5 gate blocks enablement until then.
      scopePathBindings: [unconfirmedScopeConstant("owner"), unconfirmedScopeConstant("repo")],
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

  const g2vProposalId = randomUUID();
  const v2gProposalId = randomUUID();
  const commentsProposalId = randomUUID();

  const g2v = issuesProposalItems(
    g2vProposalId,
    { resource: "issues", updateOp: "giteaEditIssue", title: "title", body: "body" },
    { resource: "tasks", updateOp: "vikunjaUpdateTask", title: "title", body: "description" },
  );
  const v2g = issuesProposalItems(
    v2gProposalId,
    { resource: "tasks", updateOp: "vikunjaUpdateTask", title: "title", body: "description" },
    { resource: "issues", updateOp: "giteaEditIssue", title: "title", body: "body" },
  );
  const comments = commentsProposalItems(commentsProposalId);

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

    const proposals = new MappingProposalRepository(txn);
    await proposals.create(
      proposalOf(g2vProposalId, giteaIssuesSpecId, vikunjaTasksSpecId, "issues", "tasks"),
      g2v.items,
    );
    await proposals.create(
      proposalOf(v2gProposalId, vikunjaTasksSpecId, giteaIssuesSpecId, "tasks", "issues"),
      v2g.items,
    );
    await proposals.create(
      proposalOf(
        commentsProposalId,
        giteaCommentsSpecId,
        vikunjaCommentsSpecId,
        "comments",
        "comments",
      ),
      comments.items,
    );
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
    giteaIssuesSpecId,
    giteaCommentsSpecId,
    vikunjaTasksSpecId,
    vikunjaCommentsSpecId,
    giteaIssuesBindingId,
    proposals: {
      issuesG2V: { id: g2vProposalId, items: g2v.ids },
      issuesV2G: { id: v2gProposalId, items: v2g.ids },
      comments: { id: commentsProposalId, items: comments.ids },
    },
    issuesPairRef,
    commentsPairRef,
  };
}

// ── The real approval path ───────────────────────────────────────────────────────────

/** Accept every item of a replayed proposal through the real per-item decision API (RA-2). */
async function acceptAllItems(
  request: APIRequestContext,
  proposalId: string,
  itemIds: readonly string[],
): Promise<void> {
  for (const itemId of itemIds) {
    const response = await request.post(
      `${BACKEND_ORIGIN}/api/mapping-proposals/${proposalId}/items/${itemId}/decision`,
      {
        headers: { authorization: basicAuthHeader(OPERATOR) },
        data: { decision: "accept" },
      },
    );
    expect(response.status(), `accept item ${itemId} → ${await response.text()}`).toBe(200);
  }
}

/** One AS-4 operation correction: the reviewer's action + target-id parameter. */
interface OperationOverrideInput {
  readonly itemId: string;
  readonly action: "create" | "update" | "delete";
  readonly targetIdParamName?: string;
}

/**
 * Approve a replayed proposal through the **real** `POST /api/mapping-proposals/:id/approve`
 * (RA-4), and return the `ApprovedMapping` id it created. This is the seam the old scaffold
 * bypassed: it is what serializes the proposal's `resourceRef` + field path into the
 * resource-qualified `FieldMapping.sourcePath`/`targetPath` production stores.
 */
async function approveProposal(
  request: APIRequestContext,
  proposalId: string,
  body: {
    operationOverrides: readonly OperationOverrideInput[];
    identityKeys: readonly { itemId: string }[];
  },
): Promise<string> {
  const response = await request.post(
    `${BACKEND_ORIGIN}/api/mapping-proposals/${proposalId}/approve`,
    { headers: { authorization: basicAuthHeader(OPERATOR) }, data: body },
  );
  const text = await response.text();
  expect(response.status(), `approve ${proposalId} → ${text}`).toBe(200);
  const parsed = JSON.parse(text) as { outcome: string; mapping?: { id: string } };
  expect(parsed.outcome, `approve ${proposalId} outcome: ${text}`).toBe("approved");
  const mappingId = parsed.mapping?.id;
  if (mappingId === undefined) {
    throw new Error(`approve ${proposalId} returned no mapping: ${text}`);
  }
  return mappingId;
}

/**
 * Await the `SyncRule` the `MappingApproved` reaction instantiates (AI-1). The reaction is
 * asynchronous (transactional outbox → dispatcher), so this polls the observable effect
 * rather than assuming a settle time. Each of this scaffold's mappings covers exactly one
 * resource pair, so exactly one rule is expected.
 */
async function awaitInstantiatedRule(mappingId: string): Promise<string> {
  await expect
    .poll(async () => (await listSyncRulesForMapping(mappingId)).length, {
      timeout: 60_000,
      message: `the approval of ${mappingId} should instantiate exactly one SyncRule`,
    })
    .toBe(1);
  const rule = (await listSyncRulesForMapping(mappingId))[0];
  if (rule === undefined) {
    throw new Error(`no SyncRule was instantiated for mapping ${mappingId}`);
  }
  return rule.id;
}

/**
 * Pin a rule's `pollOperationRef` through the real SA-1 rule-config API.
 *
 * A rule instantiated by the approve path carries **no** `pollOperationRef` — nothing in
 * the instantiation path produces one (the same product gap the Slice-D capstone reports),
 * so the BE-1.2 gate blocks every freshly-approved rule until an operator supplies it. The
 * scaffold supplies it through the real endpoint rather than writing the column, so this
 * step too crosses a production seam.
 */
async function configurePollOperation(
  request: APIRequestContext,
  ruleId: string,
  pollOperationRef: string,
): Promise<void> {
  const response = await request.patch(`${BACKEND_ORIGIN}/api/sync-rules/${ruleId}/config`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
    data: { pollOperationRef },
  });
  expect(response.status(), `configure poll op on ${ruleId} → ${await response.text()}`).toBe(200);
}

/**
 * Drive the **real** approval path over all three replayed proposals and return the
 * artifacts it produced.
 *
 * The two issues directions are approved in order — G2V first, then V2G — so the second
 * approval exercises the AS-5 **shared-pairing lock** (the counterpart direction must
 * confirm the *same* identity field pairing) and the service's automatic counterpart
 * linking, both of which the old scaffold faked with a direct `setCounterpart` write.
 *
 * The `operationOverrides` are not incidental: Vikunja **updates with POST**, which the
 * mechanical AS-4 method heuristic classifies as a create — scenario-1's documented
 * verb-semantics probe, corrected by the reviewer exactly as AS-4 intends.
 */
export async function approveSyncScaffold(
  request: APIRequestContext,
  scaffold: SyncScaffold,
): Promise<ApprovedSyncArtifacts> {
  const { issuesG2V, issuesV2G, comments } = scaffold.proposals;

  // ── Gitea issues → Vikunja tasks: `POST /tasks/{id}` is an UPDATE, title is identity ──
  await acceptAllItems(request, issuesG2V.id, [
    issuesG2V.items.updateOp,
    issuesG2V.items.titleField,
    issuesG2V.items.bodyField,
  ]);
  const mappingG2VId = await approveProposal(request, issuesG2V.id, {
    operationOverrides: [
      { itemId: issuesG2V.items.updateOp, action: "update", targetIdParamName: "id" },
    ],
    identityKeys: [{ itemId: issuesG2V.items.titleField }],
  });

  // ── Vikunja tasks → Gitea issues: the counterpart. `PATCH /repos/{owner}/{repo}/issues/{index}`
  //    addresses the record by `index`. Approved second, so the shared-pairing lock applies. ──
  await acceptAllItems(request, issuesV2G.id, [
    issuesV2G.items.updateOp,
    issuesV2G.items.titleField,
    issuesV2G.items.bodyField,
  ]);
  const mappingV2GId = await approveProposal(request, issuesV2G.id, {
    operationOverrides: [
      { itemId: issuesV2G.items.updateOp, action: "update", targetIdParamName: "index" },
    ],
    identityKeys: [{ itemId: issuesV2G.items.titleField }],
  });

  // ── Gitea comments → Vikunja comments: approved with NO identity key (SU-6.5) ──
  await acceptAllItems(request, comments.id, [comments.items.updateOp, comments.items.bodyField]);
  const mappingCommentsId = await approveProposal(request, comments.id, {
    operationOverrides: [
      { itemId: comments.items.updateOp, action: "update", targetIdParamName: "commentID" },
    ],
    identityKeys: [],
  });

  const ruleG2VId = await awaitInstantiatedRule(mappingG2VId);
  const ruleV2GId = await awaitInstantiatedRule(mappingV2GId);
  const ruleCommentsId = await awaitInstantiatedRule(mappingCommentsId);

  await configurePollOperation(request, ruleG2VId, GITEA_ISSUES_LIST_OP);
  await configurePollOperation(request, ruleV2GId, VIKUNJA_TASKS_LIST_OP);
  await configurePollOperation(request, ruleCommentsId, GITEA_COMMENTS_LIST_OP);

  return { mappingG2VId, mappingV2GId, mappingCommentsId, ruleG2VId, ruleV2GId, ruleCommentsId };
}

// ── Read helpers the capstone asserts through ────────────────────────────────────────

/** A rule's current row (status + backfillStatus), for awaiting backfill completion / go-live. */
export async function getRule(ruleId: string): Promise<SyncRule | undefined> {
  const db = await getTestDb();
  return new SyncRuleRepository(db).getById(ruleId);
}

/** The `SyncRule`s instantiated for an approved mapping. */
export async function listSyncRulesForMapping(mappingId: string): Promise<SyncRule[]> {
  const db = await getTestDb();
  return new DownstreamArtifactRepository(db).listSyncRulesByMapping(mappingId);
}

/** An approved mapping's row — for the counterpart-linking assertion. */
export async function getMapping(mappingId: string): Promise<ApprovedMapping | undefined> {
  const db = await getTestDb();
  return new ApprovedMappingRepository(db).getById(mappingId);
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

// ── Cleanup ─────────────────────────────────────────────────────────────────────────

/**
 * Wait until the ordering queue has drained before deleting anything.
 *
 * The dispatcher processes enqueued changes **asynchronously**, so a journey's last poll
 * can still be mid-flight when `afterAll` starts. Deleting the scaffold underneath a live
 * pipeline makes it fail against half-removed state and write *new* audit rows after the
 * audit sweep has already run — which is exactly how a `failure` `SyncEvent` from one run
 * leaked into the next one's parked-container queue. Quiescing first removes the race at
 * its source rather than mopping up after it.
 */
async function quiesceOrderingQueue(): Promise<void> {
  const db = await getTestDb();
  await expect
    .poll(
      async () =>
        (
          await db
            .select({ id: orderingQueue.id })
            .from(orderingQueue)
            // `done`/`parked` are terminal — a completed entry is retained as a tombstone and
            // a parked one waits on an operator, so neither is work still in flight. Only
            // `pending`/`processing` mean the dispatcher may still write.
            .where(inArray(orderingQueue.status, ["pending", "processing"]))
        ).length,
      {
        timeout: 60_000,
        message: "in-flight ordering-queue work should finish before the scaffold is deleted",
      },
    )
    .toBe(0);
}

/**
 * Delete every audit row this run produced and return how many were removed.
 *
 * Matches on all four ties a run's rows can carry: the rule/mapping/proposal refs, the
 * `originAppId` of a `sync-execution` row, and — for the SS-11.5 parked-container rows,
 * whose only run-specific content is inside the text blob — the run's `resourcePairRef`s.
 * The parked queue is read **globally** (`querySyncEvents({ status: "failure" })`), so a
 * single surviving row of this shape is visible to every later run.
 */
async function purgeRunAuditRows(
  scaffold: SyncScaffold,
  ruleIds: readonly string[],
  mappingIds: readonly string[],
): Promise<number> {
  const db = await getTestDb();
  const appIds = [scaffold.giteaAppId, scaffold.vikunjaAppId];
  const proposalIds = [
    scaffold.proposals.issuesG2V.id,
    scaffold.proposals.issuesV2G.id,
    scaffold.proposals.comments.id,
  ];
  const conditions = [
    inArray(auditLog.originAppId, appIds),
    inArray(auditLog.relatedProposalId, proposalIds),
    like(auditLog.details, `%${scaffold.issuesPairRef}%`),
    like(auditLog.details, `%${scaffold.commentsPairRef}%`),
    ...(ruleIds.length > 0 ? [inArray(auditLog.relatedRuleId, ruleIds)] : []),
    ...(mappingIds.length > 0 ? [inArray(auditLog.relatedMappingId, mappingIds)] : []),
  ];
  const deleted = await db
    .delete(auditLog)
    .where(or(...conditions))
    .returning({ id: auditLog.id });
  return deleted.length;
}

/** Run the quiesce, returning its failure instead of throwing it (see {@link cleanupSyncScaffold}). */
async function captureQuiesceFailure(): Promise<Error | undefined> {
  try {
    await quiesceOrderingQueue();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Remove everything the scaffold (and any sync run it drove) created, in FK-safe order. */
export async function cleanupSyncScaffold(scaffold: SyncScaffold): Promise<void> {
  const db = await getTestDb();
  const appIds = [scaffold.giteaAppId, scaffold.vikunjaAppId];
  const pairRefs = [scaffold.issuesPairRef, scaffold.commentsPairRef];

  // Let in-flight dispatch finish against intact state before anything is removed.
  // A quiesce that never settles must NOT abort the deletion — that would leak the whole
  // scaffold (apps, specs, mappings) into the shared database instead of one audit row. It
  // is captured and re-thrown after cleanup has run, so the run still fails loudly.
  const quiesceError = await captureQuiesceFailure();

  // The mappings/rules the REAL approval created — discovered, since the scaffold no
  // longer chooses their ids.
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
  const ruleIds =
    mappingIds.length === 0
      ? []
      : (await Promise.all(mappingIds.map(async (id) => listSyncRulesForMapping(id)))).flatMap(
          (rules) => rules.map((rule) => rule.id),
        );

  // Runtime tables with no FK cascade to lean on (recordLink has no inbound FK by design):
  // ordering queue + parked conflicts are only ever populated by this sync journey.
  await db.delete(orderingQueue);
  await db.delete(parkedConflict);
  // recordLink → syncFieldState cascades on delete.
  await db.delete(recordLink).where(inArray(recordLink.resourcePairRef, pairRefs));

  await purgeRunAuditRows(scaffold, ruleIds, mappingIds);

  if (mappingIds.length > 0) {
    // Break the counterpart self-reference before deleting the mappings.
    const mappings = new ApprovedMappingRepository(db);
    for (const id of mappingIds) {
      await mappings.setCounterpart(id, null);
    }
    // approvedMapping delete cascades sync_rule (→ poll_snapshot) + field/operation mappings.
    await db.delete(approvedMapping).where(inArray(approvedMapping.id, mappingIds));
  }
  await db
    .delete(mappingProposal)
    .where(
      inArray(mappingProposal.id, [
        scaffold.proposals.issuesG2V.id,
        scaffold.proposals.issuesV2G.id,
        scaffold.proposals.comments.id,
      ]),
    );

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

  // Converge: keep purging until a purge removes nothing. A non-zero count means a writer
  // was still active during the deletes, so the sweep repeats rather than leaving a row
  // behind for the next run to trip over.
  await expect
    .poll(async () => purgeRunAuditRows(scaffold, ruleIds, mappingIds), {
      timeout: 30_000,
      message: "no audit row from this run may survive cleanup (SS-11.5 parked queue is global)",
    })
    .toBe(0);

  // Everything is removed; now surface a quiesce that never settled.
  if (quiesceError !== undefined) {
    throw quiesceError;
  }
}
