import { request as apiRequestContext, type APIRequestContext } from "@playwright/test";

import {
  BACKEND_ORIGIN,
  OPERATOR,
  VIEWER,
  basicAuthHeader,
  expect,
  test,
} from "../support/fixtures.js";
import { closeTestDb, getTestDb } from "../support/db.js";
import { callAdapter } from "../support/adapter/adapter-call.js";
import {
  cleanupAdapterApps,
  issueAdapterToken,
  registerConsumerApp,
} from "../support/adapter/adapter-seed.js";
import {
  CONSUMER_LIST_PATH,
  VIKUNJA_PROJECT_TITLE,
  consumerCompletePath,
  consumerCreatePath,
  ensureScenario3Landscape,
  readScenario3Token,
  scenario3Vikunja,
  seedScenario3Adapter,
  teardownScenario3Landscape,
  type Scenario3Fixture,
} from "../support/adapter/scenario-3.js";
import { AdapterTokenPage } from "../support/pages/adapter-token.page.js";
import type { LandscapeBringUp } from "../support/adapter/landscape-lib.js";

/**
 * **CU-5 capstone (scenario 3): real adapter round trips against the running Vikunja +
 * `todo-widget` CONSUMER surface.** Only the mapping is fixtured (seeded directly, the
 * established adapter-integration pattern); the *serving* is real — the e2e backend's
 * Adapter Server Runtime resolves each inbound call against the **live** Vikunja
 * container. Covers:
 *
 *  - **CU-5.1** the operator issues the adapter token through the **UI**; it is shown
 *    exactly once and a reopen never shows it again (AT-1, CU-3).
 *  - **CU-5.2** the auto-activated `single`/`primary` `GET /todos` returns real Vikunja
 *    tasks mapped into `TodoItem` shape — a real single-binding round trip (CO-1, AG-1).
 *  - **CU-5.3** `POST /lists/{listId}/todos` creates a **real** Vikunja task via
 *    `PUT /projects/{id}/tasks` (listId→id applied); an identical repeat returns the
 *    recorded outcome and creates **no second task** (WR-2, WR-3).
 *  - **CU-5.7** an unmapped consumer operation returns `not-yet-mapped`, distinct from a
 *    404 for an undeclared path (RT-3, RP-5).
 *  - **CU-5.8** a no-token / another-consumer's-token call is rejected with no backend
 *    call (AT-2, AT-3).
 *  - **CU-5.9** a viewer is blocked from issuing a token in the UI and by the API (OA-2).
 *
 * **Landscape-gated:** if Docker/the landscape is unavailable the whole describe skips
 * (never fails). Run it with the landscape up:
 * `cd scenarios/scenario-3-consumer-provider && docker compose up -d --wait &&
 * ./bootstrap.sh && ./seed.sh`, then
 * `pnpm --filter @mediator/e2e exec playwright test --project=scenario-3-adapter`.
 */

let bringUp: LandscapeBringUp = "unavailable";
let landscapeAvailable = false;
let setupApi: APIRequestContext | undefined;
let fixture: Scenario3Fixture | undefined;
let servingToken: string | undefined;
let vikunjaToken: string | undefined;
/** A second consumer app (its own token) for the AT-3 foreign-token proof. */
let otherConsumerAppId: string | undefined;
let otherConsumerToken: string | undefined;

const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test.describe("CU-5 — adapter capstone, scenario-3 (live Vikunja + todo-widget)", () => {
  // Live container + a real registration/mount + several real round trips.
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    try {
      bringUp = await ensureScenario3Landscape();
    } catch (error) {
      console.warn(`CU-5/s3: scenario-3 landscape bring-up failed — skipping. ${String(error)}`);
      bringUp = "unavailable";
    }
    if (bringUp === "unavailable") {
      return;
    }
    landscapeAvailable = true;
    vikunjaToken = readScenario3Token();
    const db = await getTestDb();
    setupApi = await apiRequestContext.newContext();

    fixture = await seedScenario3Adapter(setupApi, db, vikunjaToken, uniqueSuffix);

    // A token for the serving tests (CU-5.2/5.3/5.7/5.8); CU-5.1 issues its own via the UI.
    const issued = await issueAdapterToken(setupApi, fixture.consumer.appId);
    servingToken = issued.token;

    // A second consumer app (a minimal surface WITHOUT /todos) + its own token — the AT-3
    // foreign-token proof: its token can never reach the todo-widget's data.
    const other = await registerConsumerApp(setupApi, {
      name: `cu5-other-consumer-${uniqueSuffix}`,
      document: {
        openapi: "3.1.0",
        info: { title: "Other Consumer", version: "1.0.0" },
        paths: {
          "/ping": {
            get: { operationId: "ping", responses: { "200": { description: "ok" } } },
          },
        },
      },
    });
    otherConsumerAppId = other.appId;
    otherConsumerToken = (await issueAdapterToken(setupApi, other.appId)).token;

    // Wait for the mount + serve path to be live (SpecIngested → dispatcher → mount
    // reconcile is async). Poll the real GET /todos until it serves 200.
    let last = await callAdapter("GET", CONSUMER_LIST_PATH, { token: issued.token });
    for (let i = 0; i < 40 && last.status !== 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      last = await callAdapter("GET", CONSUMER_LIST_PATH, { token: issued.token });
    }
    if (last.status !== 200) {
      console.warn(
        `CU-5/s3 mount-wait: GET /todos → ${String(last.status)} cause=${String(last.cause)} body=${last.text.slice(0, 500)}`,
      );
    }
    expect(last.status, "the todo-widget surface should mount and serve GET /todos").toBe(200);
  });

  test.beforeEach(() => {
    test.skip(!landscapeAvailable, "scenario-3 landscape or Docker is not available");
  });

  test.afterAll(async () => {
    const db = await getTestDb();
    if (fixture !== undefined) {
      const appIds = [
        ...fixture.appIds,
        ...(otherConsumerAppId !== undefined ? [otherConsumerAppId] : []),
      ];
      await cleanupAdapterApps(db, appIds);
    }
    await setupApi?.dispose();
    await closeTestDb();
    if (bringUp === "started") {
      teardownScenario3Landscape();
    }
  });

  function activeFixture(): Scenario3Fixture {
    if (fixture === undefined) {
      throw new Error("scenario-3 fixture was not initialized");
    }
    return fixture;
  }

  /** The serving token, narrowed to a definite string (set in `beforeAll`). */
  function serving(): string {
    if (servingToken === undefined) {
      throw new Error("serving token was not initialized");
    }
    return servingToken;
  }

  /** The second consumer's token (the AT-3 foreign-token proof). */
  function foreign(): string {
    if (otherConsumerToken === undefined) {
      throw new Error("other-consumer token was not initialized");
    }
    return otherConsumerToken;
  }

  test("CU-5.1: the operator issues the adapter token through the UI — shown exactly once", async ({
    page,
    login,
  }) => {
    const active = activeFixture();
    const tokenPage = new AdapterTokenPage(page);

    await tokenPage.open(active.consumer.appId);
    await login.loginAs(OPERATOR);
    await expect(tokenPage.panel).toBeVisible();

    // Before issuing, no raw token is shown (AT-1.2 / CU-3.2).
    await expect(tokenPage.reveal).toHaveCount(0);

    // Issue → the raw token is revealed exactly once, with the unmistakable warning.
    const shown = await tokenPage.issue();
    expect(shown.length).toBeGreaterThan(0);
    await expect(tokenPage.onceWarning).toBeVisible();

    // Reopening the panel never shows the value again — only metadata (the mediator
    // stores only a salted hash; there is no read that echoes it back, AT-1.2).
    await tokenPage.open(active.consumer.appId);
    await login.loginAs(OPERATOR);
    await expect(tokenPage.panel).toBeVisible();
    await expect(tokenPage.reveal).toHaveCount(0);
    await expect(tokenPage.value).toHaveCount(0);
  });

  test("CU-5.2: GET /todos auto-activates single/primary and returns real Vikunja tasks in TodoItem shape", async () => {
    const active = activeFixture();
    const db = await getTestDb();

    // The endpoint the approval derived is auto-activated `single`/`primary` — no
    // composition step (CO-1). Assert the state the instantiation produced.
    const { AdapterCompositionRepository } = await import("@mediator/db");
    const endpoints = new AdapterCompositionRepository(db);
    const endpoint = await endpoints.getEndpointById(active.listEndpointId);
    expect(endpoint?.status).toBe("active");
    expect(endpoint?.aggregationStrategy).toBe("single");
    const bindings = await endpoints.listBindings(active.listEndpointId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.role).toBe("primary");
    expect(bindings[0]?.status).toBe("active");

    // The real round trip: call the adapter port with the token; Vikunja tasks come back
    // mapped into TodoItem shape.
    const response = await callAdapter("GET", CONSUMER_LIST_PATH, { token: serving() });
    expect(response.status, response.text).toBe(200);
    const todos = response.json as { todoId: string; name: string; done: boolean }[];
    expect(Array.isArray(todos)).toBe(true);
    expect(todos.length).toBeGreaterThan(0);

    // A known seeded task is present, mapped: `id`(int)→`todoId`(string), `title`→`name`.
    const seeded = todos.find((todo) => todo.name === "Fix login button alignment");
    expect(seeded, `seeded task not found in ${response.text}`).toBeDefined();
    expect(typeof seeded?.todoId).toBe("string");
    expect(typeof seeded?.done).toBe("boolean");
    // The consumer shape never leaks the backend-native field names.
    expect(response.text).not.toContain('"title"');
    expect(response.text).not.toContain('"description"');
  });

  test("CU-5.3: POST /lists/{listId}/todos creates a real Vikunja task; an identical repeat is deduplicated", async () => {
    if (vikunjaToken === undefined) {
      throw new Error("no vikunja token");
    }
    const vikunja = scenario3Vikunja(vikunjaToken);
    const project = await vikunja.findProjectByTitle(VIKUNJA_PROJECT_TITLE);
    expect(project, `no "${VIKUNJA_PROJECT_TITLE}" project in Vikunja`).toBeDefined();
    const listId = String(project?.id);

    const title = `CU-5 adapter write ${uniqueSuffix}-${Date.now().toString(36)}`;
    // A COMPLETE NewTodo body (every mapped field present). See the reported product
    // limitation: omitting an optional consumer body field (`notes`/`due`) fails the write
    // with `mediator-transform-error: request body transform: missing-input`, because the
    // request-phase rename for the omitted field reads an absent source. Sending all fields
    // keeps this criterion (a real create + idempotent dedup) exercising the round trip.
    const body = {
      name: title,
      notes: "created through the adapter",
      due: "2026-09-01T12:00:00Z",
    };
    let createdTaskId: number | undefined;
    try {
      // First delivery — a real Vikunja task is created via PUT /projects/{id}/tasks.
      const first = await callAdapter("POST", consumerCreatePath(listId), {
        token: serving(),
        body,
      });
      expect(first.status, first.text).toBe(200);
      const firstBody = first.json as { todoId: string; name: string; done: boolean };
      expect(firstBody.name).toBe(title);
      expect(typeof firstBody.todoId).toBe("string");
      createdTaskId = Number(firstBody.todoId);

      // Exactly one such task exists in Vikunja.
      expect((await vikunja.findTasksByTitle(title)).length).toBe(1);

      // Identical repeat inside the dedup window — the recorded outcome is replayed,
      // the backend is NOT called again, and NO second task is created (WR-3).
      const second = await callAdapter("POST", consumerCreatePath(listId), {
        token: serving(),
        body,
      });
      expect(second.status, second.text).toBe(200);
      expect(second.json).toEqual(firstBody);
      expect(
        (await vikunja.findTasksByTitle(title)).length,
        "dedup must create no second task",
      ).toBe(1);
    } finally {
      if (createdTaskId !== undefined && Number.isFinite(createdTaskId)) {
        await vikunja.deleteTask(createdTaskId).catch(() => undefined);
      }
    }
  });

  test("CU-5.7: an unmapped consumer operation returns not-yet-mapped, distinct from a 404 for an undeclared path", async () => {
    // `completeTodo` is a mounted consumer op with NO approved mapping → not-yet-mapped (501).
    const notMapped = await callAdapter("POST", consumerCompletePath("42"), { token: serving() });
    expect(notMapped.status).toBe(501);
    expect(notMapped.cause).toBe("not-yet-mapped");

    // An undeclared path (in no mounted spec) → a plain 404, deliberately distinct.
    const undeclared = await callAdapter("GET", "/this-path-does-not-exist", {
      token: serving(),
    });
    expect(undeclared.status).toBe(404);
    expect(undeclared.cause).not.toBe("not-yet-mapped");
  });

  test("CU-5.8: a no-token / another-consumer's-token call is rejected with no backend call (AT-2/AT-3)", async () => {
    // (AT-2) No token → 401 before routing/planning, so no backend call is possible.
    const noToken = await callAdapter("GET", CONSUMER_LIST_PATH, {});
    expect(noToken.status).toBe(401);
    expect(noToken.text).not.toContain("todoId");

    // (AT-2) An unrecognized token → 401.
    const garbage = await callAdapter("GET", CONSUMER_LIST_PATH, { token: "not-a-real-token" });
    expect(garbage.status).toBe(401);

    // (AT-3) Another consumer's VALID token → resolved within *that* consumer's surface,
    // which has no `/todos`, so a plain 404: it never reaches the todo-widget's binding,
    // so no backend call is made and no todo data is served.
    const foreignCall = await callAdapter("GET", CONSUMER_LIST_PATH, { token: foreign() });
    expect(foreignCall.status).toBe(404);
    expect(foreignCall.text).not.toContain("todoId");
    expect(foreignCall.text).not.toContain("Fix login button alignment");
  });

  test("CU-5.9: a viewer is blocked from issuing a token — UI controls absent AND API 403 (OA-2)", async ({
    page,
    login,
  }) => {
    const active = activeFixture();
    const tokenPage = new AdapterTokenPage(page);

    await tokenPage.open(active.consumer.appId);
    await login.loginAs(VIEWER);

    // The panel renders read-only: no issue/rotate control, no token value ever.
    await expect(tokenPage.panel).toBeVisible();
    await expect(tokenPage.readonlyNote).toBeVisible();
    await expect(tokenPage.issueButton).toHaveCount(0);
    await expect(tokenPage.rotateButton).toHaveCount(0);
    await expect(tokenPage.value).toHaveCount(0);

    // The API enforces the read/mutate split: a viewer's issue is 403 (no token generated).
    const response = await page.request.post(
      `${BACKEND_ORIGIN}/api/apps/${active.consumer.appId}/adapter-token`,
      { headers: { authorization: basicAuthHeader(VIEWER) } },
    );
    expect(response.status()).toBe(403);
  });
});
