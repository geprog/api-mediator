import { randomUUID } from "node:crypto";

import type { AppConfig } from "@mediator/config";
import {
  AuditLogRepository,
  RegisteredAppRepository,
  ScopeCorrespondenceRepository,
  auditLog,
  closeDb,
  createDb,
  registeredApp,
  resolveDatabaseUrl,
  runMigrations,
  scopeCorrespondence,
  type Database,
} from "@mediator/db";
import type { AuditLogEntry, RegisteredApp, ScopeCorrespondence, ScopeKey } from "@mediator/domain";
import { formatAmbiguousContainerDetails } from "@mediator/sync-engine";
import { eq } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildSyncBackground, type SyncBackground } from "./modules/sync/background.js";
import { SyncOperatorService } from "./modules/sync/operator.js";

/**
 * SS-16 — live-Postgres backend integration for the **parked container-link queue
 * lifecycle** fix (`SyncOperatorService.listParkedContainerLinks`). Proves the two defects
 * the capstone found, against a real database + the real repos:
 *
 *  1. **Crowding-out** — the read is bounded, and before SS-16 the bound was spent on the
 *     newest `failure` rows of *every* family / on unclearable park rows, so genuine parked
 *     containers could be pushed out of the response entirely. The paged, family-filtered,
 *     liveness-aware scan must surface a genuine park even behind a full page of
 *     unclearable ones.
 *  2. **Unclearable rows drop** — a park whose `ScopeCorrespondence` or source
 *     `RegisteredApp` is gone (the deregistration cascade) can never be linked, so it is
 *     dropped from the queue rather than occupying it forever.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/backend test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

function testConfig(url: string): AppConfig {
  return {
    http: { port: 0 },
    adapterHttp: { port: 0 },
    adapterAuth: { rotationOverlapMs: 86_400_000 },
    database: { url },
    telemetry: { enabled: false },
    mappingLlm: {
      provider: "ollama",
      ollamaBaseUrl: "http://localhost:11434",
      model: "test",
      temperature: 0,
      thinking: false,
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      reviewThreshold: 0.7,
    },
    credentials: { masterKey: Buffer.alloc(32, 7) },
    registration: { defaultPollInterval: 60_000 },
    auth: { accounts: [] },
    sync: { testPollTrigger: false },
  };
}

suite("SS-16 parked container-link queue lifecycle (requires Postgres)", () => {
  let db: Database;
  let sync: SyncBackground;
  let operator: SyncOperatorService;

  const REAL_APP = randomUUID();
  const REAL_PAIR = `ss16-park-${REAL_APP}:issues|ss16-park-${REAL_APP}:tasks`;
  const GHOST_APP = randomUUID();
  const GHOST_PAIR = `ss16-ghost-${GHOST_APP}:issues|ss16-ghost-${GHOST_APP}:tasks`;

  function app(): RegisteredApp {
    return {
      id: REAL_APP,
      name: "Gitea",
      status: "active",
      baseUrl: "https://gitea.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60000,
      },
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
    };
  }
  function correspondence(): ScopeCorrespondence {
    return {
      id: randomUUID(),
      resourcePairRef: REAL_PAIR,
      scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "title" }],
      targetContainerRef: { appId: randomUUID(), resourceRef: "projects" },
      sourceContainerRef: { appId: REAL_APP, resourceRef: "repos" },
      confirmedBy: "op@example.test",
      confirmedAt: new Date("2026-07-20T00:00:00.000Z"),
    };
  }

  function parkRow(
    pair: string,
    sourceAppId: string,
    scopeKey: ScopeKey,
    at: string,
  ): AuditLogEntry {
    return {
      id: randomUUID(),
      type: "sync-execution",
      actor: "system",
      status: "failure",
      originAppId: sourceAppId,
      details: formatAmbiguousContainerDetails({
        resourcePairRef: pair,
        sourceAppId,
        sourceScopeKey: scopeKey,
        candidateNativeIds: [],
      }),
      timestamp: new Date(at),
    };
  }

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    const logger = pino({ level: "silent" });
    sync = buildSyncBackground({ db, config: testConfig(databaseUrl ?? ""), logger });
    operator = new SyncOperatorService({ db, sync });
  });

  afterEach(async () => {
    await db.delete(auditLog).where(eq(auditLog.originAppId, REAL_APP));
    await db.delete(auditLog).where(eq(auditLog.originAppId, GHOST_APP));
    await db.delete(scopeCorrespondence).where(eq(scopeCorrespondence.resourcePairRef, REAL_PAIR));
    await db.delete(registeredApp).where(eq(registeredApp.id, REAL_APP));
  });

  afterAll(async () => {
    await sync.stop();
    await closeDb(db);
  });

  it("surfaces a genuine parked container behind a full page of unclearable ones (crowding-out)", async () => {
    const audit = new AuditLogRepository(db);
    await new RegisteredAppRepository(db).create(app());
    await new ScopeCorrespondenceRepository(db).create(correspondence());

    // The genuine, actionable park — OLDEST, so a single-page newest-first read would miss it.
    await audit.insert(
      parkRow(REAL_PAIR, REAL_APP, { owner: "alice", name: "phoenix" }, "2026-07-20T09:00:00.000Z"),
    );
    // 150 NEWER unclearable parks (ghost pair + ghost app, neither exists) — one page worth
    // (100) alone would fill and empty a bounded read under the pre-SS-16 logic.
    for (let i = 0; i < 150; i++) {
      await audit.insert(
        parkRow(
          GHOST_PAIR,
          GHOST_APP,
          { owner: "ghost", name: `repo-${String(i)}` },
          `2026-07-20T10:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        ),
      );
    }

    const parked = await operator.listParkedContainerLinks(); // default limit 100

    // The genuine park is present; every unclearable ghost is dropped.
    expect(parked).toHaveLength(1);
    expect(parked[0]?.resourcePairRef).toBe(REAL_PAIR);
    expect(parked[0]?.sourceAppId).toBe(REAL_APP);
    expect(parked.every((p) => p.resourcePairRef !== GHOST_PAIR)).toBe(true);
  });

  it("drops a park whose ScopeCorrespondence is gone (deregistration cascade), keeps a live one", async () => {
    const audit = new AuditLogRepository(db);
    await new RegisteredAppRepository(db).create(app());
    await new ScopeCorrespondenceRepository(db).create(correspondence());

    // A live park (its pair + app exist) and an unclearable one (ghost pair, no correspondence).
    await audit.insert(
      parkRow(REAL_PAIR, REAL_APP, { owner: "alice", name: "phoenix" }, "2026-07-20T09:00:00.000Z"),
    );
    await audit.insert(
      parkRow(GHOST_PAIR, GHOST_APP, { owner: "ghost", name: "x" }, "2026-07-20T09:30:00.000Z"),
    );

    const parked = await operator.listParkedContainerLinks();
    expect(parked.map((p) => p.resourcePairRef)).toStrictEqual([REAL_PAIR]);
  });

  it("drops a park whose source app was deregistered even if a (dangling) correspondence remains", async () => {
    const audit = new AuditLogRepository(db);
    // Correspondence exists for REAL_PAIR, but the source app is NOT registered.
    await new ScopeCorrespondenceRepository(db).create(correspondence());
    await audit.insert(
      parkRow(REAL_PAIR, REAL_APP, { owner: "alice", name: "phoenix" }, "2026-07-20T09:00:00.000Z"),
    );

    const parked = await operator.listParkedContainerLinks();
    expect(parked).toHaveLength(0);
  });
});
