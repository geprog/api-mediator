import type { APIRequestContext } from "@playwright/test";

import { BACKEND_ORIGIN, basicAuthHeader, expect, OPERATOR, test } from "../support/fixtures.js";
import { closeTestDb } from "../support/db.js";
import {
  scopedLandscapeClients,
  type GiteaRepo,
  type ScopedGiteaClient,
  type ScopedVikunjaClient,
  type VikunjaProject,
} from "../support/landscape/scoped-apps-api.js";
import {
  ensureScenario1Landscape,
  readLandscapeTokens,
  teardownScenario1Landscape,
  type LandscapeBringUp,
} from "../support/landscape/env.js";
import {
  cleanupScopedSyncScaffold,
  getActiveDirectionalMapping,
  getScopeCorrespondence,
  getScopedRule,
  listPollScopeStates,
  listScopeLinks,
  listMappingArtifacts,
  listScopedRuleSyncEvents,
  listSyncRulesForMapping,
  seedScopedSyncScaffold,
  type ScopedSyncScaffold,
} from "../support/landscape/scoped-seed.js";
import { GITEA_SCOPED_ISSUES_LIST_OP } from "../support/landscape/scoped-ir.js";
import { ScopeBindingPage } from "../support/pages/scope-binding.page.js";
import { ScopeIdentityKeyPage } from "../support/pages/scope-identity-key.page.js";
import { SyncRulePage } from "../support/pages/sync-rule.page.js";

/**
 * **Slice D — the scoped-resource-sync (Layer-3) capstone: a real Gitea↔Vikunja
 * MULTI-CONTAINER sync round against the RUNNING scenario-1 landscape.**
 *
 * SU-6 (`scenario-1-sync.landscape.spec.ts`) proved one repo → one project with Layer-1
 * `constant` scope bindings. This proves the whole Layer-3 chain: *many* repos → *many*
 * projects, with the container correspondence authored, configured, gated, enumerated and
 * polled by the mediator itself. Only the LLM is replayed (a seeded `MappingProposal`); the
 * apps, their containers, every read and every write are live.
 *
 * The seven capstone assertions and where each is proven:
 *
 *  1. **Author + configure the scoped pair** (SS-18 → SS-15.4 → SS-9/SS-18.4 → RB-3) —
 *     `step 1`: the real approve API fires `MappingApproved`, and SS-18 **proposes** an
 *     unconfirmed `ScopeCorrespondence` with derived container refs and a candidate scope
 *     identity key; the operator then confirms the key, selects+confirms the `scope-link`
 *     bindings, and confirms both container list ops — through the real Slice-C UI.
 *  2. **The gate blocks with distinct reasons, then enables** (Slice A / SS-15.1-3) —
 *     `step 2`: three separate 422 `blocked` checkpoints show `scope-identity-key`,
 *     `container-list-op:target` and `container-list-op:source` clearing **independently**,
 *     in `per-scope-enumerated` mode.
 *  3. **Per-scope backfill fan-out** (SS-17.4/17.5) — `step 3`: after enable, the rule has
 *     one `poll_scope_state` row **per container**, keyed by that container's `ScopeLink`
 *     id — not one un-scoped read.
 *  4. **Poll each container + correct-container propagation** (SS-13.2 / SS-12 / SS-14.1) —
 *     `step 4`: an issue in repo A becomes a task in project A and **not** in project B, and
 *     then the same for repo B → project B.
 *  5. **No echo** (the Phase-4 promise, now scoped) — `step 5`: the counterpart poll
 *     recognizes the mediator's own writes as `skipped-loop`, writes nothing back to Gitea,
 *     and a re-poll creates no duplicate.
 *  6. **Live container enumeration** (SS-17.1 — "query for all available scopes and poll
 *     each") — `step 6`: a repo created **after** the rule is running is re-listed, linked by
 *     identity match and polled on the very next cycle, with no manual step and no
 *     re-enablement.
 *  7. **Scoped record identity** (SS-14.1) — `step 7`: two issues sharing a title in
 *     different repos do **not** cross-match; each links within its own container.
 *
 * ## CURRENT STATUS — this capstone is RED, for a real product reason
 *
 * Assertions 1, 2 and 3 pass: the pair is authored, proposed, configured through the real
 * Slice-C UI, gated with distinct reasons, enabled in `per-scope-enumerated` mode, both
 * containers are linked by identity match, and the backfill fans out per container. The run
 * then stops in **assertion 4a**: the poll DOES detect the new issue in repo A (the scoped
 * per-container read works), but the outbound write never lands.
 *
 * Root cause — an **approval/sync seam mismatch in `FieldMapping` path encoding**:
 * the Approval Service serializes a field mapping's paths **resourceRef-prefixed**
 * (`serializeRef`, `apps/backend/src/modules/approval/refs.ts:23` → `issues/title`,
 * `tasks/description`), while the Sync Engine reads them as **bare record paths**
 * (`applyRename` → `readPath`, `packages/transform/src/executor.ts:195`; `pathSegments`
 * splits on `.` only, `packages/transform/src/json.ts:35`). Nothing between the two strips
 * the prefix. One cause, three symptoms: the transform throws `missing-input` and every write
 * dead-letters; the identity comparison on `identityTargetPath` never matches, so every
 * record reads as new; and a target payload key would be the literal `tasks/description`.
 *
 * SU-6 never crossed this seam because it seeds its `FieldMapping`s directly with bare paths.
 * This capstone is the first test to drive **approval → sync** end to end.
 *
 * The assertions below are written against the **intended** behavior and are deliberately
 * left failing rather than relaxed: they are the regression test for that fix. Nothing here
 * is retried, slept on, or loosened to manufacture a pass.
 *
 * **Landscape-gated**: if Docker or the landscape is unavailable the whole describe skips
 * (never fails). Bring it up per `scenarios/README.md`:
 * `cd scenarios/scenario-1-small-overlap && docker compose up -d --wait && ./bootstrap.sh
 * && ./seed.sh`, then run
 * `pnpm --filter @mediator/e2e exec playwright test --project=scenario-1-sync`.
 *
 * **Determinism**: every poll cycle is the config-gated `POST /api/sync-rules/:id/poll`
 * trigger (SP-5) — never a wall-clock sleep. Eventually-consistent outcomes (async ordering-
 * queue dispatch, the `MappingApproved` reaction) are awaited with `expect.poll` on the
 * observable effect. The containers this journey polls are created under the **token
 * owner's** account, so `GET /user/repos` enumerates exactly this run's containers and
 * nothing another suite left behind.
 */

/** A per-run suffix so containers/records never collide with another run of this spec. */
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const REPO_A = `slice-d-alpha-${RUN}`;
const REPO_B = `slice-d-beta-${RUN}`;
/** The container created AFTER the rule is running — the SS-17.1 live-enumeration probe. */
const REPO_C = `slice-d-gamma-${RUN}`;

const ISSUE_IN_A = `Slice D alpha issue ${RUN}`;
const ISSUE_IN_B = `Slice D beta issue ${RUN}`;
const ISSUE_IN_C = `Slice D gamma issue ${RUN}`;
/** The SAME title in two different repos — must NOT cross-match (assertion 7). */
const SHARED_TITLE = `Slice D shared title ${RUN}`;
/** Records that exist BEFORE the rule is enabled — what the initial backfill fans out over. */
const PRE_EXISTING_A = `Slice D pre-existing alpha ${RUN}`;
const PRE_EXISTING_B = `Slice D pre-existing beta ${RUN}`;

let bringUp: LandscapeBringUp = "unavailable";
let landscapeAvailable = false;
let scaffold: ScopedSyncScaffold | undefined;
let gitea: ScopedGiteaClient | undefined;
let vikunja: ScopedVikunjaClient | undefined;
let owner = "";
let repoA: GiteaRepo | undefined;
let repoB: GiteaRepo | undefined;
let projectA: VikunjaProject | undefined;
let projectB: VikunjaProject | undefined;
let projectC: VikunjaProject | undefined;

test.describe("Slice D — multi-scope capstone (live scenario-1 landscape)", () => {
  // Live containers, a real approval reaction, a per-scope backfill and ~8 poll cycles.
  test.describe.configure({ timeout: 420_000 });

  test.beforeAll(async () => {
    try {
      bringUp = await ensureScenario1Landscape();
    } catch (error) {
      console.warn(`Slice D: scenario-1 landscape bring-up failed — skipping. ${String(error)}`);
      bringUp = "unavailable";
    }
    if (bringUp === "unavailable") {
      return;
    }
    landscapeAvailable = true;

    const clients = scopedLandscapeClients(readLandscapeTokens());
    gitea = clients.gitea;
    vikunja = clients.vikunja;
    owner = await clients.gitea.currentUserLogin();

    // The two corresponding containers the multi-scope round runs over. The repo NAME and
    // the project TITLE are equal — that pairing is the scope identity key SS-18 proposes
    // and discovery matches on, so it is the fixture's whole premise.
    repoA = await clients.gitea.createRepo(REPO_A);
    repoB = await clients.gitea.createRepo(REPO_B);
    projectA = await clients.vikunja.createProject(REPO_A);
    projectB = await clients.vikunja.createProject(REPO_B);

    scaffold = await seedScopedSyncScaffold(readLandscapeTokens());
  });

  test.beforeEach(() => {
    test.skip(!landscapeAvailable, "scenario-1 landscape or Docker is not available");
  });

  test.afterAll(async () => {
    if (scaffold !== undefined) {
      await cleanupScopedSyncScaffold(scaffold);
    }
    if (gitea !== undefined) {
      for (const repo of [REPO_A, REPO_B, REPO_C]) {
        await gitea.deleteRepoQuietly(owner, repo);
      }
    }
    if (vikunja !== undefined) {
      for (const project of [projectA, projectB, projectC]) {
        if (project !== undefined) {
          await vikunja.deleteProjectQuietly(project.id);
        }
      }
    }
    await closeTestDb();
    if (bringUp === "started") {
      teardownScenario1Landscape();
    }
  });

  test("the whole Layer-3 chain: author → gate → fan-out → poll each container → no echo → live enumeration", async ({
    page,
    login,
    request,
  }) => {
    const active = required(scaffold, "scaffold");
    const git = required(gitea, "gitea client");
    const vik = required(vikunja, "vikunja client");
    const projA = required(projectA, "project A");
    const projB = required(projectB, "project B");
    void required(repoA, "repo A");
    void required(repoB, "repo B");

    const scopeKeyPage = new ScopeIdentityKeyPage(page);
    const scopeBindings = new ScopeBindingPage(page);
    const syncRule = new SyncRulePage(page);

    // ══ STEP 1 — SS-18: approve the pair, and the mediator PROPOSES the correspondence ══

    // Decide every replayed proposal item (the review flow itself is RU-5's journey; here it
    // is the shortest honest path to a real `MappingApproved`).
    const proposalItemIds: readonly string[] = [
      active.proposalItems.listOp,
      active.proposalItems.createOp,
      active.proposalItems.updateOp,
      active.proposalItems.titleField,
      active.proposalItems.bodyField,
    ];
    for (const itemId of proposalItemIds) {
      const decision = await request.post(
        `${BACKEND_ORIGIN}/api/mapping-proposals/${active.proposalId}/items/${itemId}/decision`,
        {
          headers: { authorization: basicAuthHeader(OPERATOR) },
          data: { decision: "accept" },
        },
      );
      expect(decision.status(), `accept item ${itemId} → ${await decision.text()}`).toBe(200);
    }

    // Approve. The two `operationOverrides` are not incidental: Vikunja CREATES with PUT and
    // UPDATES with POST, so the mechanical AS-4 method heuristic classifies both backwards —
    // this is scenario-1's documented verb-semantics probe, corrected by the reviewer exactly
    // as AS-4 intends.
    const approve = await request.post(
      `${BACKEND_ORIGIN}/api/mapping-proposals/${active.proposalId}/approve`,
      {
        headers: { authorization: basicAuthHeader(OPERATOR) },
        data: {
          operationOverrides: [
            { itemId: active.proposalItems.createOp, action: "create" },
            {
              itemId: active.proposalItems.updateOp,
              action: "update",
              targetIdParamName: "id",
            },
          ],
          identityKeys: [{ itemId: active.proposalItems.titleField }],
        },
      },
    );
    expect(approve.status(), `approve → ${await approve.text()}`).toBe(200);

    const mappingG2V = required(
      await getActiveDirectionalMapping(active.giteaSpecId, active.vikunjaSpecId),
      "approved Gitea→Vikunja mapping",
    );

    // The `MappingApproved` reaction is asynchronous (transactional outbox → dispatcher):
    // await its two observable effects rather than assuming a settle time.
    await expect
      .poll(async () => (await listSyncRulesForMapping(mappingG2V.id)).length, {
        timeout: 60_000,
        message: "the approval should instantiate a Gitea→Vikunja SyncRule",
      })
      .toBe(1);
    const ruleG2VId = required(
      (await listSyncRulesForMapping(mappingG2V.id))[0]?.id,
      "instantiated Gitea→Vikunja SyncRule",
    );

    // AS-4: the reviewer's `operationOverrides` beat the method heuristic — Vikunja's
    // PUT-creates / POST-updates inversion is corrected, which is what lets the pair create
    // records in a container at all.
    const artifacts = await listMappingArtifacts(mappingG2V.id);
    const actionByTarget = new Map(
      artifacts.operationMappings.map((operation) => [
        operation.targetOperationRef,
        operation.action,
      ]),
    );
    expect(
      actionByTarget.get("tasks/vikunjaCreateTask"),
      "PUT /projects/{id}/tasks is a CREATE",
    ).toBe("create");
    expect(actionByTarget.get("tasks/vikunjaUpdateTask"), "POST /tasks/{id} is an UPDATE").toBe(
      "update",
    );

    // ── ASSERTION 1a: SS-18 proposed an UNCONFIRMED ScopeCorrespondence ──────────
    await expect
      .poll(async () => (await getScopeCorrespondence(active.resourcePairRef)) !== undefined, {
        timeout: 60_000,
        message: "MappingApproved should propose a ScopeCorrespondence for the scoped pair",
      })
      .toBe(true);
    const proposed = required(
      await getScopeCorrespondence(active.resourcePairRef),
      "proposed ScopeCorrespondence",
    );

    // Proposed, never auto-confirmed (SS-18.3/18.8).
    expect(proposed.confirmedBy, "SS-18 must propose, never confirm").toBeNull();
    expect(proposed.confirmedAt).toBeNull();
    // The derived container refs (SS-18.2): the target container is the resource whose native
    // id addresses `PUT /projects/{id}/tasks`; the source container is the enumerable `repos`.
    expect(proposed.targetContainerRef).toEqual({
      appId: active.vikunjaAppId,
      resourceRef: "projects",
    });
    expect(
      proposed.sourceContainerRef,
      "an ENUMERABLE source container is what makes the rule per-scope-enumerated",
    ).toEqual({ appId: active.giteaAppId, resourceRef: "repos" });
    // The candidate scope identity key (SS-18.3): source `name` ↔ target `title`, a rename.
    expect(proposed.scopeIdentityKey).toHaveLength(1);
    expect(proposed.scopeIdentityKey[0]?.sourceScopeKey).toBe("name");
    expect(proposed.scopeIdentityKey[0]?.targetFieldPath).toBe("title");

    // ── ASSERTION 1b: select + confirm the `scope-link` bindings (SS-18.4, real UI) ──
    // Gitea `issues`: `{owner}`/`{repo}` are the source-side container parameters.
    await scopeBindings.open(active.giteaSpecId);
    await login.loginAs(OPERATOR);
    await expect(scopeBindings.scopeSection("issues")).toBeVisible();
    // They start as the SS-2 derived-unconfirmed `constant`s ingestion emits.
    await expect(scopeBindings.kindTag("owner")).toHaveText("constant");
    await expect(scopeBindings.stateTag("owner")).toHaveText("unconfirmed");
    // `scope-link` is selectable ONLY because SS-18 proposed a correspondence for this pair.
    await expect(scopeBindings.scopeLinkOption("owner")).toBeEnabled();

    // The `scopeKeyRef` input renders only once `scope-link` is the selected kind, and it
    // arrives pre-filled with the mediator's DERIVED candidate (SS-18.4) — a proposal, not an
    // imposition.
    await scopeBindings.chooseKind("owner", "scope-link");
    await expect(
      scopeBindings.scopeKeyRefInput("owner"),
      "`{owner}` has an unambiguous derived scopeKeyRef",
    ).toHaveValue("owner");
    // `{repo}` deliberately has NONE: two source scope components and two parameters, with no
    // single component matching `repo` by name — the mediator withholds an ambiguous candidate
    // rather than spreading `owner` into both rows (which would address a real-but-wrong
    // container). The operator supplies `name` below.
    await scopeBindings.chooseKind("repo", "scope-link");
    await expect(scopeBindings.scopeKeyRefInput("repo")).toHaveValue("");

    // SS-18.4 splits the choice in two. *Selecting* records the kind but leaves it
    // unconfirmed — so it is used nowhere and the gate still blocks.
    await scopeBindings.selectScopeLink("owner", "owner");
    await expect(scopeBindings.kindTag("owner")).toHaveText("scope-link");
    await expect(scopeBindings.stateTag("owner"), "selecting must not confirm").toHaveText(
      "unconfirmed",
    );
    // Now ratify it, and do both actions for `{repo}`. `{repo}`'s `scopeKeyRef` has NO derived
    // candidate (the mediator withholds an ambiguous one rather than spreading `owner` into
    // both parameters), so the operator supplies `name` — derive-then-correct, for real.
    await scopeBindings.confirmScopeLink("owner", "owner");
    await expect(scopeBindings.stateTag("owner")).toHaveText("confirmed");
    await scopeBindings.confirmScopeLink("repo", "name");
    await expect(scopeBindings.kindTag("repo")).toHaveText("scope-link");
    await expect(scopeBindings.stateTag("repo")).toHaveText("confirmed");

    // Vikunja `tasks`: `{id}` of `PUT /projects/{id}/tasks` — the target-side container
    // parameter, whose `scopeKeyRef` candidate IS derived (the projects binding's native id).
    await scopeBindings.open(active.vikunjaSpecId);
    await login.loginAs(OPERATOR);
    await expect(scopeBindings.scopeSection("tasks")).toBeVisible();
    await scopeBindings.chooseKind("id", "scope-link");
    await expect(
      scopeBindings.scopeKeyRefInput("id"),
      "the target-side candidate is the projects binding's native id",
    ).toHaveValue("id");
    await scopeBindings.confirmScopeLink("id");
    await expect(scopeBindings.kindTag("id")).toHaveText("scope-link");
    await expect(scopeBindings.stateTag("id")).toHaveText("confirmed");

    // ══ STEP 2 — the mode-aware gate blocks with DISTINCT reasons, then enables ══════
    //
    // The rule now carries `scope-link` scope bindings, so it IS a Layer-3 rule and the
    // SS-15 gate applies. Its three preconditions are cleared one at a time, and each
    // checkpoint asserts precisely which reasons remain — that is what makes the SS-15.3
    // "distinct reasons" claim testable rather than a lumped "not configured".

    // A rule instantiated by the real approve path carries NO `pollOperationRef` — nothing in
    // the instantiation path produces one (see the report accompanying this spec), so the
    // BE-1.2 gate blocks every freshly-approved rule until an operator supplies it through the
    // SA-1 rule-config API. Pin the scoped Gitea collection read as this rule's poll operation.
    const blockedOnPollOp = await enableAttempt(request, ruleG2VId);
    expect(blockedOnPollOp.stillNeeds.some((need) => need.kind === "poll-operation-ref")).toBe(
      true,
    );
    const configured = await request.patch(`${BACKEND_ORIGIN}/api/sync-rules/${ruleG2VId}/config`, {
      headers: { authorization: basicAuthHeader(OPERATOR) },
      data: { pollOperationRef: GITEA_SCOPED_ISSUES_LIST_OP },
    });
    expect(configured.status(), `configure poll op → ${await configured.text()}`).toBe(200);

    // ── ASSERTION 2a: all three SS-15 preconditions outstanding ─────────────────
    const blockedAll = await enableAttempt(request, ruleG2VId);
    expect(blockedAll.status).toBe(422);
    expect(blockedAll.outcome).toBe("blocked");
    expect(
      blockedAll.stillNeeds
        .filter((need) => need.kind !== "scope-binding")
        .map((need) => (need.side === undefined ? need.kind : `${need.kind}:${need.side}`))
        .sort(),
      "per-scope-enumerated demands the scope identity key AND BOTH container list ops",
    ).toEqual(["container-list-op:source", "container-list-op:target", "scope-identity-key"]);

    // ── ASSERTION 2b: the operator confirms the scope identity key (SS-15.4, real UI) ──
    await scopeKeyPage.open(active.resourcePairRef);
    await login.loginAs(OPERATOR);
    await expect(scopeKeyPage.panel).toBeVisible();
    await expect(scopeKeyPage.unconfirmedTag).toBeVisible();
    await expect(scopeKeyPage.targetContainer).toContainText("projects");
    // The proposed pairing is shown for correction, pre-filled with the derived target field.
    await expect(scopeKeyPage.pairing("name")).toBeVisible();
    await expect(scopeKeyPage.targetFieldInput("name")).toHaveValue("title");
    await scopeKeyPage.confirmButton.click();
    await expect(scopeKeyPage.confirmedOutcome).toBeVisible();
    await expect
      .poll(async () => (await getScopeCorrespondence(active.resourcePairRef))?.confirmedBy)
      .not.toBeNull();

    // That reason — and ONLY that reason — is now gone.
    const blockedContainers = await enableAttempt(request, ruleG2VId);
    expect(blockedContainers.status).toBe(422);
    expect(
      blockedContainers.stillNeeds.some((need) => need.kind === "scope-identity-key"),
      "confirming the scope identity key must clear exactly its own blocker",
    ).toBe(false);
    expect(
      blockedContainers.stillNeeds
        .filter((need) => need.kind === "container-list-op")
        .map((need) => need.side)
        .sort(),
    ).toEqual(["source", "target"]);

    // ── ASSERTION 2c: the two container list ops clear INDEPENDENTLY (SS-18.5 / RB-3) ──
    await confirmRef(request, active.giteaReposBindingId, "collectionReadRef");
    const blockedTargetOnly = await enableAttempt(request, ruleG2VId);
    expect(blockedTargetOnly.status).toBe(422);
    expect(
      blockedTargetOnly.stillNeeds.filter((need) => need.kind === "container-list-op"),
      "only the TARGET container list op should still be missing",
    ).toEqual([{ kind: "container-list-op", side: "target" }]);

    await confirmRef(request, active.vikunjaProjectsBindingId, "collectionReadRef");

    // The rule is in `per-scope-enumerated` mode — the mode SS-17's live enumeration needs.
    const ruleConfig = await readRuleConfig(request, ruleG2VId);
    expect(ruleConfig.pollScopeMode?.derived, "an enumerable source container ⇒ enumerated").toBe(
      "per-scope-enumerated",
    );
    expect(ruleConfig.pollScopeMode?.effective).toBe("per-scope-enumerated");

    // ── ASSERTION 2 (positive half): the SU-1 gate UI now offers enable ──────────
    await syncRule.open(ruleG2VId);
    await login.loginAs(OPERATOR);
    await expect(syncRule.panel).toBeVisible();
    await expect(syncRule.status).toHaveText("disabled");
    await expect(
      syncRule.checklistReady,
      "with the scope identity key, both scope-link bindings and both container list ops confirmed, nothing is outstanding",
    ).toBeVisible();

    // ══ STEP 3 — enable: per-scope backfill fan-out (SS-17.4/17.5) ═══════════════════
    //
    // Give the backfill real work IN EACH CONTAINER before enabling, so the fan-out is
    // observable rather than vacuous: repo A's record already has its counterpart in project A
    // (a `link-only` backfill must correlate them), repo B's has none (it stays unlinked).
    await git.createIssue(owner, REPO_A, PRE_EXISTING_A, "pre-existing in alpha");
    await vik.createTaskInProject(projA.id, PRE_EXISTING_A, "pre-existing in alpha");
    await git.createIssue(owner, REPO_B, PRE_EXISTING_B, "pre-existing in beta");

    await syncRule.enableLinkOnly();
    await expect(syncRule.enableOutcome).toContainText("Enabled");

    await expect
      .poll(async () => (await getScopedRule(ruleG2VId))?.backfillStatus, { timeout: 120_000 })
      .toBe("completed");
    await expect.poll(async () => (await getScopedRule(ruleG2VId))?.status).toBe("enabled");

    // ── ASSERTION 3a: enablement discovery linked BOTH containers by identity match ──
    const correspondence = required(
      await getScopeCorrespondence(active.resourcePairRef),
      "confirmed ScopeCorrespondence",
    );
    const linksAfterEnable = await listScopeLinks(correspondence.id);
    const activeLinks = linksAfterEnable.filter((link) => link.status === "active");
    expect(activeLinks, "one ScopeLink per corresponding container").toHaveLength(2);
    expect(activeLinks.every((link) => link.establishedBy === "identity-match")).toBe(true);
    // Each link addresses the repo by its Gitea scope key and the project by its native id.
    const linkedRepoNames = activeLinks
      .map((link) => scopeKeySideFor(link, active.giteaAppId)["name"])
      .sort();
    expect(linkedRepoNames).toEqual([REPO_A, REPO_B].sort());

    // ── ASSERTION 3b: the backfill FANNED OUT — one poll-scope state PER container ──
    const scopeStates = await listPollScopeStates(ruleG2VId);
    expect(
      scopeStates,
      "SS-17.4/17.5: a per-scope rule's backfill fans out and seeds EACH scope's own snapshot/cursor in poll_scope_state, keyed by its ScopeLink id — not one un-scoped read",
    ).toHaveLength(2);
    expect(new Set(scopeStates.map((state) => state.scopeKey))).toEqual(
      new Set(activeLinks.map((link) => link.id)),
    );

    // ══ STEP 4 — poll each container, propagate into the CORRECT one ════════════════

    // A poll with nothing new enqueues nothing (and pins `lastRunAt`, so the 24h-interval
    // wall-clock Scheduler can never race the deterministic triggers below).
    expect(
      await triggerPoll(request, ruleG2VId),
      "the backfill seeded each scope's baseline, so a poll with no new record enqueues nothing",
    ).toBe(0);

    // ── ASSERTION 4a: repo A → project A, and NOT project B ─────────────────────
    await git.createIssue(owner, REPO_A, ISSUE_IN_A, "created in alpha");
    expect(
      await triggerPoll(request, ruleG2VId),
      "the per-scope poll should see exactly the new issue in repo A",
    ).toBe(1);

    await expect
      .poll(async () => (await vik.findProjectTaskByTitle(projA.id, ISSUE_IN_A)) !== undefined, {
        timeout: 60_000,
        message: "the issue created in repo A must become a task in project A",
      })
      .toBe(true);
    expect(
      await vik.findProjectTaskByTitle(projB.id, ISSUE_IN_A),
      "it must NOT land in the other container",
    ).toBeUndefined();

    // ── ASSERTION 4b: repo B → project B (the true multi-repo → multi-project round) ──
    await git.createIssue(owner, REPO_B, ISSUE_IN_B, "created in beta");
    expect(await triggerPoll(request, ruleG2VId)).toBe(1);

    await expect
      .poll(async () => (await vik.findProjectTaskByTitle(projB.id, ISSUE_IN_B)) !== undefined, {
        timeout: 60_000,
        message: "the issue created in repo B must become a task in project B",
      })
      .toBe(true);
    expect(await vik.findProjectTaskByTitle(projA.id, ISSUE_IN_B)).toBeUndefined();

    // ══ STEP 5 — no echo (the core Phase-4 promise, now scoped) ══════════════════════

    // The counterpart direction enables through the SAME confirmed scope config — the two
    // shared `ResourceBinding`s serve both roles, which is what makes the pair bidirectional.
    await syncRule.open(active.ruleV2GId);
    await login.loginAs(OPERATOR);
    await expect(syncRule.panel).toBeVisible();
    await expect(syncRule.checklistReady).toBeVisible();
    await syncRule.enableLinkOnly();
    await expect(syncRule.enableOutcome).toContainText("Enabled");
    await expect
      .poll(async () => (await getScopedRule(active.ruleV2GId))?.backfillStatus, {
        timeout: 120_000,
      })
      .toBe("completed");

    // Snapshot Gitea before the counterpart poll — a write back would move `updated_at`.
    const issueABefore = required(
      await git.findIssueByTitle(owner, REPO_A, ISSUE_IN_A),
      "issue A in Gitea",
    );

    // ── ASSERTION 5a: the mediator's own writes come back as `skipped-loop`, never a write ──
    await triggerPoll(request, active.ruleV2GId);
    await expect
      .poll(async () => (await listScopedRuleSyncEvents(active.ruleV2GId, "skipped-loop")).length, {
        timeout: 60_000,
        message: "the counterpart poll must recognize the mediator's own writes as echoes",
      })
      .toBeGreaterThan(0);

    const writeBacks = (await listScopedRuleSyncEvents(active.ruleV2GId, "success")).filter(
      (event) => event.type === "sync-execution",
    );
    expect(writeBacks, "an echo must make NO write back to Gitea").toHaveLength(0);
    const issueAAfter = await git.getIssue(owner, REPO_A, issueABefore.number);
    expect(issueAAfter.updated_at, "the Gitea issue is untouched by the echo").toBe(
      issueABefore.updated_at,
    );

    // ── ASSERTION 5b: a re-poll with no new change creates no duplicate ──────────
    const projATasksBefore = await vik.listProjectTasks(projA.id);
    expect(await triggerPoll(request, ruleG2VId)).toBe(0);
    expect((await vik.listProjectTasks(projA.id)).length, "no duplicate task").toBe(
      projATasksBefore.length,
    );

    // ══ STEP 6 — THE money assertion: SS-17.1 LIVE container enumeration ════════════
    //
    // A brand-new container appears in the landscape AFTER the rule is enabled and running.
    // Nothing is re-enabled, no discovery is triggered by hand, no operator step is taken:
    // the next ordinary poll must re-list the source containers, identity-match the new one,
    // establish its `ScopeLink`, and poll it — the read-side realization of "query for all
    // available scopes and poll each".
    await git.createRepo(REPO_C);
    projectC = await vik.createProject(REPO_C);
    const projC = projectC;
    await git.createIssue(owner, REPO_C, ISSUE_IN_C, "created in a container the rule never saw");

    const ruleBeforeEnumeration = required(await getScopedRule(ruleG2VId), "rule before poll");
    expect(ruleBeforeEnumeration.status).toBe("enabled");

    expect(
      await triggerPoll(request, ruleG2VId),
      "the very next poll re-lists containers, links the new one, and polls it",
    ).toBe(1);

    // ── ASSERTION 6a: the new container was discovered and linked automatically ──
    const linksAfterEnumeration = (await listScopeLinks(correspondence.id)).filter(
      (link) => link.status === "active",
    );
    expect(
      linksAfterEnumeration,
      "SS-17.1: the live re-list must establish a ScopeLink for the newly-appeared container",
    ).toHaveLength(3);
    expect(
      linksAfterEnumeration.map((link) => scopeKeySideFor(link, active.giteaAppId)["name"]).sort(),
      "the newly-created repo joins the linked set with no operator action",
    ).toEqual([REPO_A, REPO_B, REPO_C].sort());

    // ── ASSERTION 6b: its record propagated into ITS project, with no manual step ──
    await expect
      .poll(async () => (await vik.findProjectTaskByTitle(projC.id, ISSUE_IN_C)) !== undefined, {
        timeout: 60_000,
        message: "a record in a container discovered mid-flight must propagate to its project",
      })
      .toBe(true);
    // The rule was never re-enabled: same status, same backfill status, no operator action.
    const ruleAfterEnumeration = required(await getScopedRule(ruleG2VId), "rule after poll");
    expect(ruleAfterEnumeration.status).toBe("enabled");
    expect(ruleAfterEnumeration.backfillStatus).toBe("completed");
    // And the new scope got its OWN poll state (SS-13.3 per-scope isolation).
    expect(await listPollScopeStates(ruleG2VId)).toHaveLength(3);

    // ══ STEP 7 — scoped record identity: same title, different containers ═══════════
    //
    // SS-14.1 scopes the identity lookup to the record's own container. Without it the
    // second issue would match the first repo's task and the two records would MERGE.
    await git.createIssue(owner, REPO_A, SHARED_TITLE, "the alpha one");
    expect(await triggerPoll(request, ruleG2VId)).toBe(1);
    await expect
      .poll(async () => (await vik.findProjectTaskByTitle(projA.id, SHARED_TITLE)) !== undefined, {
        timeout: 60_000,
      })
      .toBe(true);

    await git.createIssue(owner, REPO_B, SHARED_TITLE, "the beta one");
    expect(await triggerPoll(request, ruleG2VId)).toBe(1);
    await expect
      .poll(async () => (await vik.findProjectTaskByTitle(projB.id, SHARED_TITLE)) !== undefined, {
        timeout: 60_000,
        message: "the same-titled issue in repo B must get its OWN task in project B",
      })
      .toBe(true);

    // ── ASSERTION 7: two distinct records, one per container — never merged ──────
    const sharedInA = required(
      await vik.findProjectTaskByTitle(projA.id, SHARED_TITLE),
      "shared-title task in project A",
    );
    const sharedInB = required(
      await vik.findProjectTaskByTitle(projB.id, SHARED_TITLE),
      "shared-title task in project B",
    );
    expect(
      sharedInA.id,
      "the two containers' same-titled records must NOT be the same task",
    ).not.toBe(sharedInB.id);
    expect(sharedInA.project_id).toBe(projA.id);
    expect(sharedInB.project_id).toBe(projB.id);
    expect(
      (await vik.listProjectTasks(projA.id)).filter((task) => task.title === SHARED_TITLE),
      "exactly one such task per container",
    ).toHaveLength(1);
    expect(
      (await vik.listProjectTasks(projB.id)).filter((task) => task.title === SHARED_TITLE),
    ).toHaveLength(1);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────

/** Narrow an optional set up in `beforeAll` to a value, failing loudly rather than `!`. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not initialized`);
  }
  return value;
}

/**
 * One deterministic poll cycle (SP-5); asserts it completed; returns the enqueued count.
 *
 * A **per-scope** rule (SS-13.3) reports `completed-per-scope` with one result per scope
 * rather than a single `completed`, so this normalizes both shapes and — importantly — fails
 * loudly when any individual scope `aborted`/`parked`. Per-scope isolation means one bad
 * scope does NOT fail the run, which is correct engine behavior but would silently hide a
 * broken container from a test that only looked at the top-level outcome.
 */
/** One scope's slice of an SS-13.3 `completed-per-scope` poll outcome. */
interface PerScopePollResult {
  readonly scopeLinkId: string;
  readonly result: {
    readonly kind: string;
    readonly enqueuedCount?: number;
    readonly reason?: string;
  };
}

/** The poll-trigger response, flattened across the `completed` / `completed-per-scope` shapes. */
interface PollResponseBody {
  readonly outcome: {
    readonly kind: string;
    readonly enqueuedCount?: number;
    readonly reason?: string;
    readonly scopes?: readonly PerScopePollResult[];
  };
}

async function triggerPoll(request: APIRequestContext, ruleId: string): Promise<number> {
  const response = await request.post(`${BACKEND_ORIGIN}/api/sync-rules/${ruleId}/poll`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
  });
  const bodyText = await response.text();
  expect(response.status(), `poll ${ruleId} → ${bodyText}`).toBe(200);
  const { outcome } = JSON.parse(bodyText) as PollResponseBody;

  if (outcome.kind === "completed-per-scope") {
    const scopes = outcome.scopes ?? [];
    expect(
      scopes.length,
      `poll ${ruleId}: a per-scope run must resolve at least one scope`,
    ).toBeGreaterThan(0);
    expect(
      scopes.filter((scope) => scope.result.kind !== "completed"),
      `poll ${ruleId}: every scope must complete — ${bodyText}`,
    ).toHaveLength(0);
    return scopes.reduce((total, scope) => total + (scope.result.enqueuedCount ?? 0), 0);
  }

  expect(outcome.kind, `poll ${ruleId} outcome: ${bodyText}`).toBe("completed");
  return outcome.enqueuedCount ?? 0;
}

interface EnableAttempt {
  readonly status: number;
  readonly outcome: string;
  readonly stillNeeds: { kind: string; side?: string; parameterName?: string }[];
}

/** Attempt enablement and return the gate's verdict (the server is the authority, BE-1/BE-2). */
async function enableAttempt(request: APIRequestContext, ruleId: string): Promise<EnableAttempt> {
  const response = await request.post(`${BACKEND_ORIGIN}/api/sync-rules/${ruleId}/enable`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
    data: { action: "backfill", backfillMode: "link-only" },
  });
  const body = (await response.json()) as {
    outcome?: string;
    stillNeeds?: { kind: string; side?: string; parameterName?: string }[];
  };
  return {
    status: response.status(),
    outcome: body.outcome ?? "",
    stillNeeds: body.stillNeeds ?? [],
  };
}

/** Confirm one operational ref of a `ResourceBinding` as-is (RB-2 / SS-18.5). */
async function confirmRef(
  request: APIRequestContext,
  bindingId: string,
  refKind: string,
): Promise<void> {
  const response = await request.patch(`${BACKEND_ORIGIN}/api/resource-bindings/${bindingId}`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
    data: { refKind },
  });
  expect(response.status(), `confirm ${refKind} → ${await response.text()}`).toBe(200);
}

/** A rule's operator-visible config, including the SS-13.5 poll-scope-mode view. */
async function readRuleConfig(
  request: APIRequestContext,
  ruleId: string,
): Promise<{
  pollScopeMode?: { derived: string; effective: string; override: string | null };
}> {
  const response = await request.get(`${BACKEND_ORIGIN}/api/sync-rules`, {
    headers: { authorization: basicAuthHeader(OPERATOR) },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    rules: {
      id: string;
      pollScopeMode?: { derived: string; effective: string; override: string | null };
    }[];
  };
  const rule = body.rules.find((entry) => entry.id === ruleId);
  return rule ?? {};
}

/** The side of a `ScopeLink`'s scope key that addresses `appId`. */
function scopeKeySideFor(
  link: {
    appAId: string;
    appAScopeKey: Record<string, string>;
    appBScopeKey: Record<string, string>;
  },
  appId: string,
): Record<string, string> {
  return link.appAId === appId ? link.appAScopeKey : link.appBScopeKey;
}
