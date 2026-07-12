import {
  BACKEND_ORIGIN,
  basicAuthHeader,
  expect,
  OPERATOR,
  test,
  VIEWER,
} from "../support/fixtures.js";
import {
  cleanupPeerPeerProposal,
  closeTestDb,
  getActiveMapping,
  getProposalStatus,
  listAuditTypesForProposal,
  listSyncRules,
  seedPeerPeerProposal,
} from "../support/db.js";
import { MockBackend } from "../support/mock-backend.js";
import {
  buildPeerPeerProposalFixture,
  type PeerPeerProposalFixture,
} from "../support/proposal-fixture.js";

/**
 * RU-5 — the capstone Phase-3 review journey. Over a **replayed** peer-peer
 * proposal fixture (seeded directly into Postgres, no LLM), an operator drives the
 * real review UI + RA-* API to an `ApprovedMapping`, and the journey proves the
 * core safety promise: **nothing executes before approval** (AS-6 crit 4), approval
 * **instantiates but does not enable** its downstream artifacts (AI-1/AI-2), a
 * `viewer` is blocked at every mutation (OA-2), and an **invalid edited target**
 * never reaches production (AS-3).
 *
 * The observable for "nothing executed" is a recording mock backend registered as
 * both apps' `baseUrl`: the mediator makes outbound calls only from the Sync/Adapter
 * engines, which do not run in Phase 3, so a correct system contacts it **zero**
 * times. The disabled-artifact reaction settles asynchronously on the outbox
 * dispatcher, so its state is polled, never raced.
 */

test.describe("Phase-3 review journey (RU-5, real UI + API + Postgres)", () => {
  const mock = new MockBackend();
  const seeded: PeerPeerProposalFixture[] = [];

  test.beforeAll(async () => {
    await mock.start();
  });

  test.afterEach(async () => {
    for (const fixture of seeded) {
      await cleanupPeerPeerProposal(fixture);
    }
    seeded.length = 0;
  });

  test.afterAll(async () => {
    await mock.stop();
    await closeTestDb();
  });

  /** Build + seed a fresh isolated fixture (both apps' baseUrl → the mock backend). */
  async function seedFixture(): Promise<PeerPeerProposalFixture> {
    const fixture = buildPeerPeerProposalFixture({ baseUrl: mock.url() });
    seeded.push(fixture);
    await seedPeerPeerProposal(fixture);
    return fixture;
  }

  test("operator approves a subset; nothing executes before approval, artifacts land disabled", async ({
    login,
    proposalReview,
  }) => {
    const fixture = await seedFixture();
    const { proposal, items, sourceSpec, targetSpec } = fixture;

    // Pre-condition: no ApprovedMapping exists for this pair yet.
    expect(await getActiveMapping(sourceSpec.id, targetSpec.id)).toBeUndefined();

    // ── Open the proposal through the real screen (RA-1 detail) ────────────────
    // Navigating to the protected URL bounces to /login; signing in returns here.
    // (After this single full load, every action is client-side so the in-memory
    // SPA session survives.)
    await proposalReview.open(proposal.id);
    await login.loginAs(OPERATOR);
    await expect(proposalReview.items).toBeVisible();
    await expect(proposalReview.status).toHaveText("pending");

    // ── Review items via RA-2: accept a subset, reject one, leave some pending ──
    await proposalReview.acceptItem(items.titleField.id);
    await expect(proposalReview.itemState(items.titleField.id)).toHaveText("accepted");
    await proposalReview.acceptItem(items.emailField.id);
    await expect(proposalReview.itemState(items.emailField.id)).toHaveText("accepted");
    await proposalReview.acceptItem(items.listOp.id);
    await expect(proposalReview.itemState(items.listOp.id)).toHaveText("accepted");
    await proposalReview.acceptItem(items.createOp.id);
    await expect(proposalReview.itemState(items.createOp.id)).toHaveText("accepted");
    await proposalReview.rejectItem(items.stateField.id);
    await expect(proposalReview.itemState(items.stateField.id)).toHaveText("rejected");

    // ── AS-6 crit 4: up to (but excluding) approval, NOTHING executed ──────────
    expect(mock.requests()).toHaveLength(0);
    expect(await getActiveMapping(sourceSpec.id, targetSpec.id)).toBeUndefined();

    // ── RU-4: confirm the identity key (RA-3, which approves the decided subset) ─
    // updateOp/deleteOp/legacyField stay pending → a partial approval.
    await expect(proposalReview.identityPanel).toBeVisible();
    await proposalReview.confirmIdentityKey(items.emailField.id, "email");

    await expect(proposalReview.approveOutcome).toContainText("Partially approved");
    await expect(proposalReview.approveOutcome).toContainText("Identity key confirmed");
    await expect(proposalReview.approveOutcome).toContainText("Nothing is running yet");

    // ── RU-5 crit 1: the journey completed to an ApprovedMapping ───────────────
    await expect
      .poll(async () => (await getActiveMapping(sourceSpec.id, targetSpec.id)) !== undefined, {
        timeout: 15_000,
      })
      .toBe(true);
    const mapping = await getActiveMapping(sourceSpec.id, targetSpec.id);
    if (mapping === undefined) {
      throw new Error("expected an ApprovedMapping after approval");
    }
    expect(mapping.variant).toBe("peer-peer");
    expect(mapping.approvedBy).toBe(OPERATOR.username);
    expect(await getProposalStatus(proposal.id)).toBe("partially_approved");

    // ── AI-1/AI-2: the reaction instantiates the SyncRule(s) DISABLED ──────────
    await expect
      .poll(async () => (await listSyncRules(mapping.id)).length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    const rules = await listSyncRules(mapping.id);
    for (const rule of rules) {
      expect(rule.status).toBe("disabled");
    }

    // ── AS-6 crit 4 (after settle): still no outbound call; only decision audits ─
    expect(mock.requests()).toHaveLength(0);
    const auditTypes = await listAuditTypesForProposal(proposal.id);
    expect(auditTypes.length).toBeGreaterThan(0);
    for (const type of auditTypes) {
      expect(type).toBe("mapping-decision");
    }
  });

  test("a viewer is blocked at every mutation — UI controls absent AND API 403 (OA-2)", async ({
    page,
    login,
    proposalReview,
    request,
  }) => {
    const fixture = await seedFixture();
    const { proposal, items, sourceSpec, targetSpec } = fixture;

    await proposalReview.open(proposal.id);
    await login.loginAs(VIEWER);

    // Reads succeed (RA-1 is viewer-ok): the screen renders read-only.
    await expect(proposalReview.items).toBeVisible();
    await expect(proposalReview.readonlyBanner).toBeVisible();

    // No mutation affordance is rendered for a viewer.
    await expect(page.getByTestId("item-accept")).toHaveCount(0);
    await expect(page.getByTestId("item-reject")).toHaveCount(0);
    await expect(page.getByTestId("item-edit")).toHaveCount(0);
    await expect(proposalReview.identityConfirmButton).toHaveCount(0);
    await expect(proposalReview.approveButton).toHaveCount(0);
    await expect(proposalReview.approveSection).toHaveCount(0);

    // The API enforces the split too: a viewer may read the detail (200) but every
    // mutation is rejected 403 and nothing is changed (OA-2 crit 1/2).
    const viewerHeaders = { authorization: basicAuthHeader(VIEWER) };
    const detailRes = await request.get(`${BACKEND_ORIGIN}/api/mapping-proposals/${proposal.id}`, {
      headers: viewerHeaders,
    });
    expect(detailRes.status()).toBe(200);

    const decisionRes = await request.post(
      `${BACKEND_ORIGIN}/api/mapping-proposals/${proposal.id}/items/${items.titleField.id}/decision`,
      { headers: viewerHeaders, data: { decision: "accept" } },
    );
    expect(decisionRes.status()).toBe(403);

    const approveRes = await request.post(
      `${BACKEND_ORIGIN}/api/mapping-proposals/${proposal.id}/approve`,
      { headers: viewerHeaders, data: {} },
    );
    expect(approveRes.status()).toBe(403);

    // Nothing mutated: no ApprovedMapping, proposal still pending, mock untouched.
    expect(await getActiveMapping(sourceSpec.id, targetSpec.id)).toBeUndefined();
    expect(await getProposalStatus(proposal.id)).toBe("pending");
    expect(mock.requests()).toHaveLength(0);
  });

  test("an invalid edited target ref surfaces the AS-3 error and produces no ApprovedMapping", async ({
    login,
    proposalReview,
  }) => {
    const fixture = await seedFixture();
    const { proposal, items, sourceSpec, targetSpec } = fixture;

    await proposalReview.open(proposal.id);
    await login.loginAs(OPERATOR);

    // Re-point a field item's target at a field the target IR does not have. RA-2
    // persists the edit (kind matches); target-IR validation is deferred to approve.
    await proposalReview.editFieldTarget(items.titleField.id, "tasks", "doesNotExist");
    await expect(proposalReview.itemState(items.titleField.id)).toHaveText("edited");

    // Approve: AS-3 rejects the unresolvable target ref and rolls the whole approve
    // back — the error surfaces and NO ApprovedMapping is produced.
    await proposalReview.approve();
    await expect(proposalReview.approveError).toBeVisible();
    await expect(proposalReview.approveError).toContainText("does not resolve");

    expect(await getActiveMapping(sourceSpec.id, targetSpec.id)).toBeUndefined();
    expect(await getProposalStatus(proposal.id)).toBe("pending");
    expect(mock.requests()).toHaveLength(0);
  });
});
