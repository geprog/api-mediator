import { expect, GITEA_PROVIDER_SPEC, OPERATOR, test, uniqueAppName } from "../support/fixtures.js";

/**
 * Phase-1 registration checkpoint journey (AR-1..3, SI-3, RB-3) driven through
 * the **real** Vue UI against the **real** Fastify operator API and the compose
 * Postgres. The one LLM-backed stage (mapping detection) is Phase 2 and plays no
 * part here, so the whole flow is deterministic.
 *
 * Since Phase-3 operator auth (OA-1), every operator-API route requires an
 * authenticated identity and the router guard sends an anonymous visitor to
 * `/login`, so each test signs in as `operator` first. The SPA session is
 * in-memory (a reload signs it out), so the persistence-checking reloads go
 * through `login.reloadAndReauth` rather than a bare `page.reload()`.
 *
 * Ground truth (scenario-1 Gitea trimmed OAS3 → `ground-truth.yaml`): the IR
 * groups operations by their path resource noun, so `/repos/.../issues[/{index}]`
 * form the `issues` resource (alongside separate `comments`/`labels`/`milestones`/
 * `users`/… groups) whose representation (`Issue` schema) has an `id` field; the
 * `nativeIdRef` heuristic therefore guesses `id`, and — with no `supportsDelta`/
 * `supportsChangeTimestamps` capability — the delta/change-timestamp refs are
 * not-applicable.
 */

const BASE_URL_VALUE = "https://gitea.example.com";

test.describe("Phase-1 registration vertical (real UI + backend + Postgres)", () => {
  test("registers a Gitea PROVIDER spec, ingests its IR, and confirms a ResourceBinding", async ({
    login,
    registerApp,
    appList,
    appDetail,
    specPage,
  }) => {
    const appName = uniqueAppName("e2e-gitea");

    // OA-1: authenticate as operator before mutating (the operator API is fully
    // authenticated; an anonymous visitor is redirected to /login).
    await login.openAndLogin(OPERATOR);

    // AR-3: open the form, fill basics, pick PROVIDER, upload the Gitea spec.
    await registerApp.open();
    await expect(registerApp.form).toBeVisible();
    await registerApp.fillName(appName);
    await registerApp.fillBaseUrl(BASE_URL_VALUE);
    await registerApp.selectRole(0, "PROVIDER");
    await registerApp.uploadSpec(0, GITEA_PROVIDER_SPEC);

    // AR-3 crit 2 / SI-4: the stateless preview-parse populates the resource-group
    // exclusion toggles; the noun-grouped `issues` and `milestones` groups appear.
    await expect(registerApp.groupToggle(0, "issues")).toBeVisible();
    await expect(registerApp.groupToggle(0, "milestones")).toBeVisible();
    // Exclude one group to prove `analysisExclusions` round-trips end to end.
    await registerApp.excludeGroup(0, "milestones");

    // AR-1: submit succeeds, navigates to the created app, surfaces no issues.
    await expect(registerApp.issues).toBeHidden();
    const appId = await registerApp.submitAndOpenApp();
    await expect(appDetail.card).toBeVisible();
    await expect(appDetail.card).toContainText(appName);

    // AR-2: the app list shows the new app; open it; its PROVIDER spec is listed
    // and carries the exclusion we set; open the spec's IR + bindings view.
    await appList.open();
    await expect(appList.table).toBeVisible();
    await expect(appList.appLink(appId)).toBeVisible();
    await appList.openApp(appId);
    await expect(appDetail.card).toBeVisible();
    await expect(appDetail.specsTable).toContainText("PROVIDER");
    await expect(appDetail.specsTable).toContainText("milestones");
    await appDetail.openOnlySpec();

    // SI-3: the `issues` resource group renders; drilling into its `Issue` schema
    // reveals the flattened `id` field, and its operations are present.
    await expect(specPage.irGroup("issues")).toBeVisible();
    await expect(specPage.irOperation("issueListIssues")).toBeVisible();
    const issueSchema = await specPage.expandSchema("issues", "Issue");
    await expect(issueSchema.getByTestId("ir-field-id")).toBeVisible();

    // RB-3: nativeIdRef is the heuristic guess `id`, unconfirmed; a delta ref is
    // not-applicable (the app declared no supportsDeltaQuery) and non-actionable.
    await expect(specPage.bindingPanel).toBeVisible();
    await expect(specPage.refState("issues", "nativeIdRef")).toHaveText("unconfirmed");
    await expect(specPage.refValue("issues", "nativeIdRef")).toHaveText("field: id");
    await expect(specPage.refState("issues", "deltaCursorRef")).toHaveText("not-applicable");
    await expect(specPage.refNotApplicable("issues", "deltaCursorRef")).toBeVisible();
    await expect(specPage.confirmButton("issues", "deltaCursorRef")).toHaveCount(0);

    // RB-2/RB-3: confirm nativeIdRef; it flips to confirmed, attributed to the
    // acting operator.
    await specPage.confirm("issues", "nativeIdRef");
    await expect(specPage.refState("issues", "nativeIdRef")).toHaveText("confirmed");
    await expect(specPage.refRow("issues", "nativeIdRef")).toContainText("Confirmed by operator");

    // RB-2: the confirmation persisted server-side — a full reload refetches it.
    // The reload clears the in-memory SPA session, so re-authenticate on the way back.
    await login.reloadAndReauth(OPERATOR);
    await expect(specPage.refState("issues", "nativeIdRef")).toHaveText("confirmed");
    await expect(specPage.refValue("issues", "nativeIdRef")).toHaveText("field: id");
  });

  test("corrects an applicable ResourceBinding ref via the picker and persists it", async ({
    login,
    registerApp,
    appDetail,
    specPage,
  }) => {
    const appName = uniqueAppName("e2e-gitea-correct");

    await login.openAndLogin(OPERATOR);
    await registerApp.open();
    await registerApp.fillName(appName);
    await registerApp.fillBaseUrl(BASE_URL_VALUE);
    await registerApp.selectRole(0, "PROVIDER");
    await registerApp.uploadSpec(0, GITEA_PROVIDER_SPEC);
    await expect(registerApp.groupToggle(0, "issues")).toBeVisible();
    await registerApp.submitAndOpenApp();

    await expect(appDetail.card).toBeVisible();
    await appDetail.openOnlySpec();

    // Noun grouping separates `/repos/issues/search` (its own `search` group) from
    // the `issues` collection, so the heuristic now guesses the true list op
    // `issueListIssues`. Re-point the ref via the picker and confirm in one action
    // (RB-2 crit 2 — value updated AND confirmed together; exercises the upsert +
    // reload-persist path) to prove an operator override persists.
    await expect(specPage.refState("issues", "collectionReadRef")).toHaveText("unconfirmed");
    await expect(specPage.refValue("issues", "collectionReadRef")).toHaveText(
      "operation: issueListIssues",
    );
    await specPage.correctToOperation("issues", "collectionReadRef", "issueGetIssue");
    await expect(specPage.refState("issues", "collectionReadRef")).toHaveText("confirmed");
    await expect(specPage.refValue("issues", "collectionReadRef")).toHaveText(
      "operation: issueGetIssue",
    );

    // The correction persisted server-side (reload clears the session; re-auth back).
    await login.reloadAndReauth(OPERATOR);
    await expect(specPage.refState("issues", "collectionReadRef")).toHaveText("confirmed");
    await expect(specPage.refValue("issues", "collectionReadRef")).toHaveText(
      "operation: issueGetIssue",
    );
  });
});
