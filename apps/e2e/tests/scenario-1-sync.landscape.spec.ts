import type { APIRequestContext } from "@playwright/test";

import {
  BACKEND_ORIGIN,
  basicAuthHeader,
  expect,
  OPERATOR,
  test,
  VIEWER,
} from "../support/fixtures.js";
import { closeTestDb } from "../support/db.js";
import {
  landscapeClients,
  type GiteaIssue,
  type VikunjaTask,
} from "../support/landscape/apps-api.js";
import {
  ensureScenario1Landscape,
  readLandscapeTokens,
  teardownScenario1Landscape,
  type LandscapeBringUp,
} from "../support/landscape/env.js";
import {
  cleanupSyncScaffold,
  getRule,
  listRuleSyncEvents,
  seedSyncScaffold,
  SYNCED_ITEM_TITLE,
  type SyncScaffold,
} from "../support/landscape/seed.js";
import { SyncRulePage } from "../support/pages/sync-rule.page.js";

/**
 * **SU-6 — the Phase-4 capstone e2e: a real sync round with no echo, against a RUNNING
 * scenario-1 landscape.** This is the one journey that runs against the **live** Gitea +
 * Vikunja containers, not a fake backend — only the LLM/mapping is replayed (seeded as
 * the `SyncScaffold`). It proves the Sync Engine's core promises end to end:
 *
 *  - **SU-6.1** both peer-peer rules (issues↔tasks, title = identity) enable through the
 *    SU-1 gate UI with `link-only` backfill, then poll.
 *  - **SU-6.2** a Gitea issue edit → the Gitea→Vikunja poll → the corresponding Vikunja
 *    **task is updated via the real Vikunja API**.
 *  - **SU-6.3** the Vikunja→Gitea poll recognizes the mediator's own write as an **echo**
 *    → `skipped-loop`, and **no write is made back to Gitea** (the no-echo guarantee).
 *  - **SU-6.4** re-polling with no new change enqueues nothing → **no duplicate** task.
 *  - **SU-6.5** the identity-less comments pair is **blocked** on "still needs identity key".
 *  - **SU-6.6** a **viewer** driving enablement is blocked (UI absent + API 403, OA-2).
 *
 * **Landscape-gated:** if Docker or the landscape is unavailable the whole describe skips
 * (never fails), so `pnpm --filter @mediator/e2e test:e2e` on a box with only the compose
 * Postgres still passes. Run it with the landscape up:
 * `cd scenarios/scenario-1-small-overlap && docker compose up -d --wait && ./bootstrap.sh
 * && ./seed.sh`, then `pnpm --filter @mediator/e2e exec playwright test --project=scenario-1-sync`.
 *
 * Every poll cycle is driven **deterministically** through the config-gated
 * `POST /api/sync-rules/:id/poll` trigger (SP-5) — never sleep-and-hope. Each app's state
 * is asserted through its **own** REST API using the `.tokens.env` tokens.
 */

/** A fixed, known baseline so `link-only` backfill seeds an agreeing body↔description baseline (re-run safe). */
const BASELINE_BODY = "SU-6 baseline body — normalized before enable.";

let bringUp: LandscapeBringUp = "unavailable";
let scaffold: SyncScaffold | undefined;
let landscapeAvailable = false;

test.describe("SU-6 — capstone sync round, no echo (live scenario-1 landscape)", () => {
  // Live containers + real backfill + several poll cycles + async dispatch need headroom.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    try {
      bringUp = await ensureScenario1Landscape();
    } catch (error) {
      // A bring-up fault must not break the rest of the e2e suite — skip, but say why.
      console.warn(`SU-6: scenario-1 landscape bring-up failed — skipping. ${String(error)}`);
      bringUp = "unavailable";
    }
    if (bringUp === "unavailable") {
      return;
    }
    landscapeAvailable = true;
    scaffold = await seedSyncScaffold(readLandscapeTokens());
  });

  test.beforeEach(() => {
    test.skip(!landscapeAvailable, "scenario-1 landscape or Docker is not available");
  });

  test.afterAll(async () => {
    if (scaffold !== undefined) {
      await cleanupSyncScaffold(scaffold);
    }
    await closeTestDb();
    if (bringUp === "started") {
      teardownScenario1Landscape();
    }
  });

  /** Drive one deterministic poll cycle for a rule (SP-5); assert it completed; return the enqueued count. */
  async function triggerPoll(request: APIRequestContext, ruleId: string): Promise<number> {
    const response = await request.post(`${BACKEND_ORIGIN}/api/sync-rules/${ruleId}/poll`, {
      headers: { authorization: basicAuthHeader(OPERATOR) },
    });
    const bodyText = await response.text();
    expect(response.status(), `poll ${ruleId} → ${bodyText}`).toBe(200);
    const body = JSON.parse(bodyText) as {
      outcome: { kind: string; enqueuedCount?: number; reason?: string };
    };
    expect(body.outcome.kind, `poll ${ruleId} outcome: ${bodyText}`).toBe("completed");
    return body.outcome.enqueuedCount ?? 0;
  }

  test("SU-6.1–6.4: a real Gitea→Vikunja round propagates once and does NOT echo back", async ({
    page,
    login,
    request,
  }) => {
    const active = scaffold;
    if (active === undefined) {
      throw new Error("scaffold was not seeded");
    }
    const { gitea, vikunja } = landscapeClients(readLandscapeTokens());
    const syncRule = new SyncRulePage(page);

    // ── Locate the shared work item in each live app (identity = title) ──────────
    const issue: GiteaIssue | undefined = await gitea.findIssueByTitle(SYNCED_ITEM_TITLE);
    const task: VikunjaTask | undefined = await vikunja.findTaskByTitle(SYNCED_ITEM_TITLE);
    if (issue === undefined || task === undefined) {
      throw new Error(`seed data missing: "${SYNCED_ITEM_TITLE}" not found in both apps`);
    }

    // Normalize both sides to the SAME value BEFORE enabling, so link-only backfill seeds
    // an agreeing baseline (robust across re-runs of the shared landscape).
    await gitea.setIssueBody(issue.number, BASELINE_BODY);
    await vikunja.setTaskDescription(task.id, BASELINE_BODY);
    const initialTaskCount = (await vikunja.listTasks()).length;

    // ── SU-6.1: enable BOTH rules through the SU-1 gate UI, link-only backfill ────
    for (const ruleId of [active.ruleG2VId, active.ruleV2GId]) {
      // Opening the protected panel bounces to /login; signing in returns to it. The
      // in-memory SPA session is dropped by the next full navigation, so each rule
      // re-authenticates (that also re-exercises the OA-1 guard).
      await syncRule.open(ruleId);
      await login.loginAs(OPERATOR);
      await expect(syncRule.panel).toBeVisible();
      await expect(syncRule.status).toHaveText("disabled");
      // The gate is satisfied for this pair — the checklist is empty and enable is offered.
      await expect(syncRule.checklistReady).toBeVisible();
      await syncRule.enableLinkOnly();
      await expect(syncRule.enableOutcome).toContainText("Enabled");

      // BE-3 — an enabled rule is not polling until its backfill completes.
      await expect
        .poll(async () => (await getRule(ruleId))?.backfillStatus, { timeout: 60_000 })
        .toBe("completed");
      await expect.poll(async () => (await getRule(ruleId))?.status).toBe("enabled");
    }

    // ── Baseline: a poll with no change enqueues nothing (and pins lastRunAt so the
    //    wall-clock Scheduler — 24h interval — never races the deterministic triggers). ──
    expect(await triggerPoll(request, active.ruleG2VId)).toBe(0);
    expect(await triggerPoll(request, active.ruleV2GId)).toBe(0);

    // ── SU-6.2: a Gitea issue edit → Gitea→Vikunja poll → the Vikunja task updates ──
    const updatedBody = `SU-6 synced update ${Date.now().toString(36)}`;
    await gitea.setIssueBody(issue.number, updatedBody);

    const g2vEnqueued = await triggerPoll(request, active.ruleG2VId);
    expect(g2vEnqueued, "Gitea→Vikunja poll should detect exactly the edited issue").toBe(1);

    // The ordering-queue dispatcher processes the enqueued change asynchronously; assert
    // the real outbound write landed by reading the task back from Vikunja's own API.
    await expect
      .poll(async () => (await vikunja.getTask(task.id)).description, { timeout: 30_000 })
      .toBe(updatedBody);

    // ── SU-6.3: Vikunja→Gitea poll → the mediator's own write is an ECHO (skipped-loop),
    //    NO write is made back to Gitea. This is the core no-echo guarantee. ─────────
    const giteaBeforeEcho = await gitea.getIssue(issue.number);

    const v2gEnqueued = await triggerPoll(request, active.ruleV2GId);
    expect(v2gEnqueued, "Vikunja→Gitea poll should detect the mediator's own write").toBe(1);

    // The enqueued change is recognized as an echo and recorded skipped-loop...
    await expect
      .poll(async () => (await listRuleSyncEvents(active.ruleV2GId, "skipped-loop")).length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    // ...and NO outbound write landed on the Vikunja→Gitea rule: a write-back would be a
    // `sync-execution` success (the `backfill-run` successes from link-only backfill are
    // expected and excluded by type)...
    const v2gWriteBacks = (await listRuleSyncEvents(active.ruleV2GId, "success")).filter(
      (event) => event.type === "sync-execution",
    );
    expect(v2gWriteBacks, "the echo must make NO write back to Gitea").toHaveLength(0);
    // ...so the Gitea issue is untouched by the echo (its updated_at did not move).
    const giteaAfterEcho = await gitea.getIssue(issue.number);
    expect(giteaAfterEcho.updated_at).toBe(giteaBeforeEcho.updated_at);
    expect(giteaAfterEcho.body).toBe(updatedBody);

    // ── SU-6.4: re-poll Gitea→Vikunja with no new change → nothing enqueued, no dup ──
    expect(await triggerPoll(request, active.ruleG2VId)).toBe(0);
    expect((await vikunja.listTasks()).length, "no duplicate task created").toBe(initialTaskCount);
    expect((await vikunja.getTask(task.id)).description).toBe(updatedBody);
  });

  test("SU-6.5: the identity-less comments pair is blocked on 'still needs identity key'", async ({
    page,
    login,
    request,
  }) => {
    const active = scaffold;
    if (active === undefined) {
      throw new Error("scaffold was not seeded");
    }
    const syncRule = new SyncRulePage(page);

    // The SU-1 gate surfaces the missing identity key as a checklist blocker, and never
    // offers enable while it stands.
    await syncRule.open(active.ruleCommentsId);
    await login.loginAs(OPERATOR);
    await expect(syncRule.panel).toBeVisible();
    await expect(syncRule.checklistItem("identity-key")).toBeVisible();
    await expect(syncRule.checklistItem("identity-key")).toContainText("identity key");
    await expect(syncRule.enableButton).toBeDisabled();

    // The server enforces it too: enabling returns 422 blocked with the identity-key reason.
    const response = await request.post(
      `${BACKEND_ORIGIN}/api/sync-rules/${active.ruleCommentsId}/enable`,
      {
        headers: { authorization: basicAuthHeader(OPERATOR) },
        data: { action: "backfill", backfillMode: "link-only" },
      },
    );
    expect(response.status()).toBe(422);
    const body = (await response.json()) as {
      outcome: string;
      stillNeeds: { kind: string }[];
    };
    expect(body.outcome).toBe("blocked");
    expect(body.stillNeeds.some((need) => need.kind === "identity-key")).toBe(true);

    // And it stayed disabled — nothing was enabled.
    expect((await getRule(active.ruleCommentsId))?.status).toBe("disabled");
  });

  test("SU-6.6: a viewer driving enablement is blocked — UI affordance absent AND API 403 (OA-2)", async ({
    page,
    login,
    request,
  }) => {
    const active = scaffold;
    if (active === undefined) {
      throw new Error("scaffold was not seeded");
    }
    const syncRule = new SyncRulePage(page);

    await syncRule.open(active.ruleCommentsId);
    await login.loginAs(VIEWER);

    // The panel renders read-only: the backfill choice + enable action are absent.
    await expect(syncRule.panel).toBeVisible();
    await expect(syncRule.readonlyBanner).toBeVisible();
    await expect(syncRule.enableButton).toHaveCount(0);
    await expect(syncRule.backfillChoice).toHaveCount(0);

    // The API enforces the read/mutate split for sync too: a viewer's enable is 403.
    const response = await request.post(
      `${BACKEND_ORIGIN}/api/sync-rules/${active.ruleCommentsId}/enable`,
      {
        headers: { authorization: basicAuthHeader(VIEWER) },
        data: { action: "backfill", backfillMode: "link-only" },
      },
    );
    expect(response.status()).toBe(403);
    expect((await getRule(active.ruleCommentsId))?.status).toBe("disabled");
  });
});
