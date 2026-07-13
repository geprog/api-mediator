import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { OrderingQueueRepository } from "./repositories/index.js";
import { orderingQueue } from "./schema.js";

/**
 * Live-database integration for the **SA-5 dead-letter operations** on
 * `OrderingQueueRepository` — `listParked`, `isSuperseded`, and the atomically-guarded
 * `reactivate`. Their semantics are real-Postgres properties (the safe payload
 * projection, the `enqueue_seq`-ordered supersession `EXISTS`, and — critically — the
 * single-active-per-key `NOT EXISTS` guard on the reactivating `UPDATE`) so they are
 * proven here against real Postgres + the full migration chain, matching the
 * `FakeOrderingQueue` unit tests ([[fakes-must-mirror-real-repos]]). No migration is
 * added — `ordering_queue.parked` already exists (OQ-1).
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`. Self-skips when
 * `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const T0 = new Date("2026-07-14T00:00:00.000Z");
const LEASE_MS = 30_000;

/** A `DetectedChange`-shaped payload whose `observedRecord` MUST never surface (data boundary). */
function changePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: "rule-1",
    mappingId: "map-1",
    sourceAppId: "app-a",
    targetAppId: "app-b",
    resourcePairRef: "pair::widgets",
    sourceNativeId: "n1",
    changeKind: "update",
    observedRecord: { name: "Alpha", secret: "SENSITIVE-VALUE-123" },
    ...overrides,
  };
}

suite("SA-5 ordering_queue dead-letter operations — live Postgres", () => {
  let db: Database;

  /** Enqueue → claim → park (the OC-4 dead-letter at the retry ceiling), returning the id. */
  async function parkEntry(
    repo: OrderingQueueRepository,
    key: string,
    payload: Record<string, unknown>,
    finishedAt: Date,
    owner = "w1",
  ): Promise<string> {
    const id = await repo.enqueue(key, payload);
    const claimed = await repo.claimNext({ now: T0, leaseExpiresAt: at(LEASE_MS), owner });
    expect(claimed?.id).toBe(id);
    expect(await repo.park(id, "target write failed: 503", owner, finishedAt)).toBe(true);
    return id;
  }

  /** Enqueue → claim → done (a later same-key change completing), returning the id. */
  async function doneEntry(
    repo: OrderingQueueRepository,
    key: string,
    payload: Record<string, unknown>,
    owner = "w2",
  ): Promise<string> {
    const id = await repo.enqueue(key, payload);
    const claimed = await repo.claimNext({ now: at(5), leaseExpiresAt: at(LEASE_MS + 5), owner });
    expect(claimed?.id).toBe(id);
    expect(await repo.markDone(id, owner, at(6))).toBe(true);
    return id;
  }

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(orderingQueue);
  });

  afterAll(async () => {
    await db.delete(orderingQueue);
    await closeDb(db);
  });

  it("listParked returns only parked rows as a safe projection — ids/refs, no observedRecord (SA-5.1)", async () => {
    const repo = new OrderingQueueRepository(db);
    const parkedId = await parkEntry(repo, "link-1", changePayload(), at(1));
    // A done and a pending entry on other keys must NOT appear. The done entry is
    // created first so the single-owner claim targets its own entry; the stray pending
    // entry is enqueued last so it never becomes the lowest claimable during setup.
    await doneEntry(repo, "link-3", changePayload());
    await repo.enqueue("link-2", changePayload());

    const parked = await repo.listParked(50);
    expect(parked).toHaveLength(1);
    const entry = parked[0];
    expect(entry?.id).toBe(parkedId);
    expect(entry?.queueKey).toBe("link-1");
    expect(entry?.lastError).toBe("target write failed: 503");
    expect(entry?.attempts).toBe(1);
    expect(entry?.superseded).toBe(false);
    expect(entry?.parkedAt?.toISOString()).toBe(at(1).toISOString());
    expect(entry?.context).toStrictEqual({
      ruleId: "rule-1",
      mappingId: "map-1",
      sourceAppId: "app-a",
      targetAppId: "app-b",
      resourcePairRef: "pair::widgets",
      sourceNativeId: "n1",
      changeKind: "update",
    });
    // Data boundary: the observedRecord value never reaches the projection.
    expect(JSON.stringify(entry)).not.toContain("SENSITIVE-VALUE-123");
    expect(entry).not.toHaveProperty("payload");
  });

  it("listParked is newest-parked first and bounded by limit", async () => {
    const repo = new OrderingQueueRepository(db);
    const older = await parkEntry(repo, "k-old", changePayload(), at(1_000));
    const newer = await parkEntry(repo, "k-new", changePayload(), at(2_000));

    expect((await repo.listParked(50)).map((entry) => entry.id)).toStrictEqual([newer, older]);
    expect((await repo.listParked(1)).map((entry) => entry.id)).toStrictEqual([newer]);
  });

  it("isSuperseded: true when a later same-key done entry exists, false otherwise (SA-5.3)", async () => {
    const repo = new OrderingQueueRepository(db);
    const parkedId = await parkEntry(repo, "link-1", changePayload(), at(1));

    expect(await repo.isSuperseded(parkedId)).toBe(false);

    // A later change on the SAME key runs to completion → supersedes the parked write.
    await doneEntry(repo, "link-1", changePayload());
    expect(await repo.isSuperseded(parkedId)).toBe(true);
    expect((await repo.listParked(50)).find((e) => e.id === parkedId)?.superseded).toBe(true);
  });

  it("isSuperseded: false for a non-parked or absent id", async () => {
    const repo = new OrderingQueueRepository(db);
    const doneId = await doneEntry(repo, "link-1", changePayload(), "w1");
    expect(await repo.isSuperseded(doneId)).toBe(false);
    expect(await repo.isSuperseded("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("reactivate flips parked → pending, clears the lease, sets available_at = now (SA-5.2)", async () => {
    const repo = new OrderingQueueRepository(db);
    const parkedId = await parkEntry(repo, "link-1", changePayload(), at(1));

    const result = await repo.reactivate(parkedId, at(100));
    expect(result.kind).toBe("reactivated");
    if (result.kind === "reactivated") {
      expect(result.entry.status).toBe("pending");
      expect(result.entry.availableAt?.toISOString()).toBe(at(100).toISOString());
      expect(result.entry.leaseOwner).toBeNull();
      expect(result.entry.leaseExpiresAt).toBeNull();
    }
    const persisted = await repo.getById(parkedId);
    expect(persisted?.status).toBe("pending");

    // Claimable again once available_at is due → the dispatcher re-runs the pipeline.
    const reclaimed = await repo.claimNext({
      now: at(200),
      leaseExpiresAt: at(LEASE_MS + 200),
      owner: "w3",
    });
    expect(reclaimed?.id).toBe(parkedId);
  });

  it("reactivate is BLOCKED when another non-terminal entry shares the queue key (single-active-per-key guard)", async () => {
    const repo = new OrderingQueueRepository(db);
    const parkedId = await parkEntry(repo, "link-1", changePayload(), at(1));
    // A later change for the same record is still queued (pending) under the same key.
    await repo.enqueue("link-1", changePayload());

    const result = await repo.reactivate(parkedId, at(100));
    expect(result.kind).toBe("blocked-key-busy");
    // Untouched — still parked, so the key never gets two active entries.
    expect((await repo.getById(parkedId))?.status).toBe("parked");
  });

  it("reactivate is blocked when a same-key entry is actively processing", async () => {
    const repo = new OrderingQueueRepository(db);
    const parkedId = await parkEntry(repo, "link-1", changePayload(), at(1));
    // A later same-key entry is claimed (processing) — a live worker holds the key.
    await repo.enqueue("link-1", changePayload());
    const claimed = await repo.claimNext({
      now: at(50),
      leaseExpiresAt: at(LEASE_MS + 50),
      owner: "w9",
    });
    expect(claimed).toBeDefined();

    expect((await repo.reactivate(parkedId, at(100))).kind).toBe("blocked-key-busy");
  });

  it("reactivate on a non-parked entry → not-parked; on an absent id → not-found", async () => {
    const repo = new OrderingQueueRepository(db);
    const pendingId = await repo.enqueue("link-1", changePayload());
    expect((await repo.reactivate(pendingId, at(100))).kind).toBe("not-parked");
    expect((await repo.reactivate("00000000-0000-0000-0000-000000000000", at(100))).kind).toBe(
      "not-found",
    );
  });
});

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}
