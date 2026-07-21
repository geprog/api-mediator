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
import {
  CONTRIBUTING_BACKENDS_HEADER,
  DEGRADED_BACKENDS_HEADER,
  DEGRADED_HEADER,
  callAdapter,
} from "../support/adapter/adapter-call.js";
import {
  cleanupAdapterApps,
  composeAdapterEndpoint,
  issueAdapterToken,
  setAppStatus,
} from "../support/adapter/adapter-seed.js";
import {
  CONSUMER_UNION_OP,
  CONSUMER_UNION_PATH,
  UNIQUE_FORGEJO_TITLE,
  UNIQUE_GITEA_TITLE,
  UNIQUE_VIKUNJA_TITLE,
  ensureScenario4Landscape,
  readScenario4Tokens,
  seedScenario4Adapter,
  teardownScenario4Landscape,
  type Scenario4Fixture,
} from "../support/adapter/scenario-4.js";
import { CompositionPage } from "../support/pages/composition.page.js";
import type { LandscapeBringUp } from "../support/adapter/landscape-lib.js";

/**
 * **CU-5 capstone (scenario 4): a real 3-backend `collection-union` served from the running
 * Gitea + Forgejo + Vikunja landscape through the `task-dashboard` CONSUMER surface.** Only
 * the mappings are fixtured (seeded directly); the union *serving* is real. Covers:
 *
 *  - **CU-5.4** the union composed as `collection-union` over the three backends (all
 *    `supplement`, dedup by `headline`, post-merge pagination confirmed) returns one merged,
 *    sorted, paged list of `WorkItem`s spanning all three (AG-3, AG-4). The composition is
 *    submitted through the real compose API (the route the composition UI POSTs to); the
 *    operator UI is separately verified to render the union composition affordances.
 *  - **CU-5.5** a `page`/`pageSize` request WITHOUT confirmed `postMergePagination` is
 *    rejected at request validation — "never mispaged" (RP-2.3).
 *  - **CU-5.6** with one backend disabled, the non-strict union returns without it, a
 *    response header names the disabled backend, the body still validates, and the degraded
 *    response is NOT cached (a later call with the backend restored reflects it) (AG-3.2, CH-2.5).
 *  - **CU-5.9** a viewer is blocked from composing the union — UI read-only + API 403 (OA-2).
 *
 * **Landscape-gated:** skips (never fails) when Docker/the landscape is unavailable. Run with
 * the landscape up:
 * `cd scenarios/scenario-4-mixed && docker compose up -d --wait && ./bootstrap.sh && ./seed.sh`,
 * then `pnpm --filter @mediator/e2e exec playwright test --project=scenario-4-adapter`.
 */

const DEDUP_HEADLINE = "work-items/headline";
const PAGINATION = {
  convention: "page-number" as const,
  pageParamRef: "work-items/listWorkItems#page",
  sizeParamRef: "work-items/listWorkItems#pageSize",
  firstPageNumber: 1,
};

interface UnionComposeOptions {
  readonly withPagination: boolean;
  readonly cacheTtl?: number;
}

let bringUp: LandscapeBringUp = "unavailable";
let landscapeAvailable = false;
let setupApi: APIRequestContext | undefined;
let fixture: Scenario4Fixture | undefined;
let servingToken: string | undefined;

const uniqueSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

test.describe("CU-5 — adapter capstone, scenario-4 (live Gitea+Forgejo+Vikunja union)", () => {
  test.describe.configure({ timeout: 240_000 });

  /** The compose request body for the union (all supplement; dedup by headline). */
  function unionComposeBody(options: UnionComposeOptions): Record<string, unknown> {
    const active = activeFixture();
    return {
      aggregationStrategy: "collection-union",
      strictness: "degraded",
      bindings: active.bindingIds.map((bindingId) => ({ bindingId, role: "supplement" })),
      postMergeDedup: { mode: "dedup-key", dedupKeyFieldPath: DEDUP_HEADLINE },
      ...(options.withPagination
        ? { postMergePagination: PAGINATION, confirmPostMergePagination: true }
        : {}),
      ...(options.cacheTtl !== undefined ? { cacheTtl: options.cacheTtl } : {}),
    };
  }

  /** Compose the union to a given state through the real operator API; assert it activated. */
  async function composeUnion(options: UnionComposeOptions): Promise<void> {
    const api = requiredApi();
    const active = activeFixture();
    const result = await composeAdapterEndpoint(api, active.endpointId, unionComposeBody(options));
    expect(result.status, `compose union → ${result.text}`).toBe(200);
  }

  test.beforeAll(async () => {
    try {
      bringUp = await ensureScenario4Landscape();
    } catch (error) {
      console.warn(`CU-5/s4: scenario-4 landscape bring-up failed — skipping. ${String(error)}`);
      bringUp = "unavailable";
    }
    if (bringUp === "unavailable") {
      return;
    }
    landscapeAvailable = true;
    const db = await getTestDb();
    setupApi = await apiRequestContext.newContext();

    fixture = await seedScenario4Adapter(setupApi, db, readScenario4Tokens(), uniqueSuffix);
    const issued = await issueAdapterToken(setupApi, fixture.consumer.appId);
    servingToken = issued.token;

    // A base composition so the endpoint is active; each test recomposes to its own state.
    await composeUnion({ withPagination: false });

    // Wait for the mount + serve path to be live (SpecIngested → dispatcher → mount reconcile).
    let last = await callAdapter("GET", CONSUMER_UNION_PATH, { token: issued.token });
    for (let i = 0; i < 40 && last.status !== 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      last = await callAdapter("GET", CONSUMER_UNION_PATH, { token: issued.token });
    }
    if (last.status !== 200) {
      console.warn(
        `CU-5/s4 mount-wait: GET /work-items → ${String(last.status)} cause=${String(last.cause)} body=${last.text.slice(0, 500)}`,
      );
    }
    expect(last.status, "the task-dashboard union should mount and serve GET /work-items").toBe(
      200,
    );
  });

  test.beforeEach(() => {
    test.skip(!landscapeAvailable, "scenario-4 landscape or Docker is not available");
  });

  test.afterAll(async () => {
    const db = await getTestDb();
    if (fixture !== undefined) {
      // Ensure every provider app is active again before cleanup (CU-5.6 may have left one
      // disabled if it failed mid-test).
      for (const appId of [fixture.giteaAppId, fixture.forgejoAppId, fixture.vikunjaAppId]) {
        await setAppStatus(db, appId, "active").catch(() => undefined);
      }
      await cleanupAdapterApps(db, fixture.appIds);
    }
    await setupApi?.dispose();
    await closeTestDb();
    if (bringUp === "started") {
      teardownScenario4Landscape();
    }
  });

  function activeFixture(): Scenario4Fixture {
    if (fixture === undefined) {
      throw new Error("scenario-4 fixture was not initialized");
    }
    return fixture;
  }
  function requiredApi(): APIRequestContext {
    if (setupApi === undefined) {
      throw new Error("setup API context was not initialized");
    }
    return setupApi;
  }
  function serving(): string {
    if (servingToken === undefined) {
      throw new Error("serving token was not initialized");
    }
    return servingToken;
  }

  /** The `headline`s of a union response body. */
  function headlines(response: { json: unknown }): string[] {
    const rows = response.json as { headline?: string }[];
    return Array.isArray(rows) ? rows.map((row) => row.headline ?? "") : [];
  }

  test("CU-5.4: the collection-union over three backends returns one merged, sorted, paged list of WorkItems", async () => {
    const active = activeFixture();
    await composeUnion({ withPagination: true });

    // A large page → the whole merged, deduplicated union.
    const full = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "1", pageSize: "50" },
    });
    expect(full.status, full.text).toBe(200);
    const merged = full.json as { itemId: string; headline: string; finished: boolean }[];
    expect(Array.isArray(merged)).toBe(true);
    // Every row is a valid WorkItem shape (required fields present, correctly typed).
    for (const row of merged) {
      expect(typeof row.itemId).toBe("string");
      expect(typeof row.headline).toBe("string");
      expect(typeof row.finished).toBe("boolean");
    }

    // Each backend's UNIQUE item is present — proof all three contributed to the merge.
    const titles = merged.map((row) => row.headline);
    expect(titles).toContain(UNIQUE_GITEA_TITLE);
    expect(titles).toContain(UNIQUE_FORGEJO_TITLE);
    expect(titles).toContain(UNIQUE_VIKUNJA_TITLE);
    // A title shared across all three backends is collapsed to ONE row (dedup by headline).
    expect(titles.filter((title) => title === "Fix login button alignment")).toHaveLength(1);

    // The out-of-band provenance header names all three contributing backends.
    const contributing = full.headers.get(CONTRIBUTING_BACKENDS_HEADER) ?? "";
    for (const appId of [active.giteaAppId, active.forgejoAppId, active.vikunjaAppId]) {
      expect(contributing).toContain(appId);
    }

    // Pagination is applied post-merge over the sorted union: distinct, stable pages.
    const page1 = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "1", pageSize: "2" },
    });
    const page2 = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "2", pageSize: "2" },
    });
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    const ids1 = (page1.json as { itemId: string }[]).map((row) => row.itemId);
    const ids2 = (page2.json as { itemId: string }[]).map((row) => row.itemId);
    expect(ids1.length).toBeLessThanOrEqual(2);
    expect(ids2.length).toBeLessThanOrEqual(2);
    // The two pages are disjoint (paged, not repeated) and stable across identical requests.
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    const page1Again = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "1", pageSize: "2" },
    });
    expect((page1Again.json as { itemId: string }[]).map((row) => row.itemId)).toEqual(ids1);
  });

  test("CU-5.5: page/pageSize WITHOUT confirmed postMergePagination is rejected at request validation", async () => {
    // Recompose the union with NO pagination convention configured.
    await composeUnion({ withPagination: false });

    // A request using page/pageSize is rejected — never mispaged, never answered unpaged.
    const rejected = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "1", pageSize: "2" },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.cause).toBe("union-parameter-unconfigured");

    // The same endpoint still serves a request that does NOT use the pagination parameters.
    const unpaged = await callAdapter("GET", CONSUMER_UNION_PATH, { token: serving() });
    expect(unpaged.status, unpaged.text).toBe(200);
    expect(headlines(unpaged).length).toBeGreaterThan(0);
  });

  test("CU-5.6: a disabled backend degrades the union (named out of band, body valid, NOT cached)", async () => {
    const active = activeFixture();
    const db = await getTestDb();

    // Compose WITH a cacheTtl so "not cached" is a meaningful assertion; recompose drops any
    // prior cached entry (CH-5), so the first (degraded) call below fetches fresh.
    await composeUnion({ withPagination: true, cacheTtl: 60 });

    // Disable the Vikunja backend BEFORE any cache-populating call.
    await setAppStatus(db, active.vikunjaAppId, "disabled");
    try {
      const degraded = await callAdapter("GET", CONSUMER_UNION_PATH, {
        token: serving(),
        query: { page: "1", pageSize: "50" },
      });
      expect(degraded.status, degraded.text).toBe(200);
      // The merged result is returned WITHOUT the disabled contributor, named out of band.
      expect(degraded.headers.get(DEGRADED_HEADER)).toBe("true");
      expect(degraded.headers.get(DEGRADED_BACKENDS_HEADER) ?? "").toContain(active.vikunjaAppId);
      // The body still validates against the consumer schema (a served 200) and no longer
      // carries the Vikunja-only item (its backend was dropped).
      const degradedTitles = headlines(degraded);
      expect(degradedTitles).not.toContain(UNIQUE_VIKUNJA_TITLE);
      // Gitea/Forgejo still contribute their unique items.
      expect(degradedTitles).toContain(UNIQUE_GITEA_TITLE);
      expect(degradedTitles).toContain(UNIQUE_FORGEJO_TITLE);
    } finally {
      await setAppStatus(db, active.vikunjaAppId, "active");
    }

    // The degraded response was NOT cached (CH-2.5): with Vikunja restored, the next call
    // reflects it — the frozen-degraded answer would still be missing the Vikunja item.
    const restored = await callAdapter("GET", CONSUMER_UNION_PATH, {
      token: serving(),
      query: { page: "1", pageSize: "50" },
    });
    expect(restored.status, restored.text).toBe(200);
    expect(restored.headers.get(DEGRADED_HEADER)).toBeNull();
    expect(headlines(restored)).toContain(UNIQUE_VIKUNJA_TITLE);
  });

  test("CU-5.9: a viewer is blocked from composing the union — UI read-only + API 403 (OA-2)", async ({
    page,
    login,
  }) => {
    const active = activeFixture();
    const composition = new CompositionPage(page);

    await composition.open(active.endpointId);
    await login.loginAs(VIEWER);

    // The composition screen renders read-only for a viewer: no submit control.
    await expect(composition.form).toBeVisible();
    await expect(composition.readonlyNote).toBeVisible();
    await expect(composition.submitButton).toHaveCount(0);

    // The API enforces the read/mutate split: a viewer's compose is 403 (nothing changes).
    const response = await page.request.post(
      `${BACKEND_ORIGIN}/api/adapter-endpoints/${active.endpointId}/compose`,
      {
        headers: { authorization: basicAuthHeader(VIEWER) },
        data: unionComposeBody({ withPagination: true }),
      },
    );
    expect(response.status()).toBe(403);
  });

  test("CU-5.9 (operator): the operator can reach the union composition and see its three contributor bindings", async ({
    page,
    login,
  }) => {
    const active = activeFixture();
    const composition = new CompositionPage(page);

    await composition.open(active.endpointId);
    await login.loginAs(OPERATOR);

    await expect(composition.form).toBeVisible();
    // The operator can select the collection-union strategy → the union post-merge panel appears.
    await composition.selectStrategy("collection-union");
    await expect(composition.unionPanel).toBeVisible();
    // All three contributor bindings render on the composition form.
    for (const bindingId of active.bindingIds) {
      await expect(composition.binding(bindingId)).toBeVisible();
    }
    // The consumer operation the union serves is identified.
    await expect(composition.form).toContainText(CONSUMER_UNION_OP);
  });
});
