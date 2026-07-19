import { randomUUID } from "node:crypto";

import type { RecordLink, SyncFieldState } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { RecordLinkRepository, SyncFieldStateRepository } from "./repositories/index.js";
import { recordLink, syncFieldState } from "./schema.js";

/**
 * Live-database integration test for the Phase-4 `record_link` + `sync_field_state`
 * tables (RL-1..RL-5, migration `0013`). These are the mutations the requirement
 * calls out as needing a REAL database: the **unique-active-link** partial indexes
 * (the RL-4 silent-merge safety net), the **tombstone-not-delete** lifecycle, and the
 * **identity-match seed** — none of which a fake can prove is enforced by the schema.
 *
 * Requires the compose `postgres` service + a resolvable `DATABASE_URL`; excluded from
 * `pnpm verify`, run via `pnpm --filter @mediator/db test:integration`. Self-skips
 * when `DATABASE_URL` is unresolvable.
 */

let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const T0 = new Date("2026-07-13T00:00:00.000Z");

function makeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: randomUUID(),
    appAId: randomUUID(),
    appANativeId: "a-1",
    appBId: randomUUID(),
    appBNativeId: "b-1",
    resourcePairRef: "pair::customers",
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "a@x.com" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

function fieldRow(recordLinkId: string, overrides: Partial<SyncFieldState> = {}): SyncFieldState {
  return {
    id: randomUUID(),
    recordLinkId,
    side: "A",
    fieldPath: "email",
    observedHash: "obs-hash",
    observedAt: T0,
    observedChangeTimestamp: null,
    status: "active",
    ...overrides,
  };
}

suite("Phase-4 record_link + sync_field_state integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(syncFieldState);
    await db.delete(recordLink);
  });

  afterAll(async () => {
    await db.delete(syncFieldState);
    await db.delete(recordLink);
    await closeDb(db);
  });

  it("unique-active-link: a second active link for the same side-record is rejected", async () => {
    const repo = new RecordLinkRepository(db);
    const first = makeLink();
    await repo.insert(first);

    // Same resource pair + same side-A record (app + native id), different id → the
    // partial-unique-active index must reject it (the RL-4 no-silent-merge invariant).
    const conflict = makeLink({
      id: randomUUID(),
      appAId: first.appAId,
      appANativeId: first.appANativeId,
      appBId: randomUUID(),
      appBNativeId: "b-2",
    });
    await expect(repo.insert(conflict)).rejects.toThrow();

    // Only the first link exists, and it resolves by (app, native id) from either side.
    expect(
      (
        await repo.findActiveByRecord(first.resourcePairRef, {
          appId: first.appAId,
          nativeId: first.appANativeId,
        })
      )?.id,
    ).toBe(first.id);
    expect(
      (
        await repo.findActiveByRecord(first.resourcePairRef, {
          appId: first.appBId,
          nativeId: first.appBNativeId,
        })
      )?.id,
    ).toBe(first.id);
  });

  it("unique-active-link: a fresh active link is allowed once the prior one is tombstoned", async () => {
    const repo = new RecordLinkRepository(db);
    const first = makeLink();
    await repo.insert(first);
    await repo.tombstone(first.id, "observed-delete", T0);

    // The partial index only covers active rows, so a re-create legitimately links again.
    const fresh = makeLink({
      id: randomUUID(),
      appAId: first.appAId,
      appANativeId: first.appANativeId,
      appBId: first.appBId,
      appBNativeId: "b-2",
    });
    await expect(repo.insert(fresh)).resolves.toBeUndefined();

    const active = await repo.findActiveByRecord(first.resourcePairRef, {
      appId: first.appAId,
      nativeId: first.appANativeId,
    });
    expect(active?.id).toBe(fresh.id);
  });

  it("tombstone lifecycle: tombstoned (not deleted), reason + timestamp persisted, resolvable as tombstoned", async () => {
    const repo = new RecordLinkRepository(db);
    const link = makeLink();
    await repo.insert(link);

    const tombstonedAt = new Date("2026-07-13T01:00:00.000Z");
    await repo.tombstone(link.id, "propagated-delete", tombstonedAt);

    // The row survives, tombstoned — never deleted.
    const stored = await repo.getById(link.id);
    expect(stored?.status).toBe("tombstoned");
    expect(stored?.tombstoneReason).toBe("propagated-delete");
    expect(stored?.tombstonedAt?.toISOString()).toBe(tombstonedAt.toISOString());

    // No longer resolves as active; resolves as the most-recent tombstone.
    const record = { appId: link.appAId, nativeId: link.appANativeId };
    expect(await repo.findActiveByRecord(link.resourcePairRef, record)).toBeUndefined();
    expect((await repo.findTombstonedByRecord(link.resourcePairRef, record))?.id).toBe(link.id);
  });

  it("unlink removes the link and cascades its sync_field_state", async () => {
    const linkRepo = new RecordLinkRepository(db);
    const stateRepo = new SyncFieldStateRepository(db);
    const link = makeLink();
    await linkRepo.insert(link);
    await stateRepo.seed([fieldRow(link.id, { side: "A", fieldPath: "email" })]);

    await linkRepo.unlink(link.id);

    expect(await linkRepo.getById(link.id)).toBeUndefined();
    // FK ON DELETE CASCADE removed the child field-state rows too.
    expect(await stateRepo.findByLink(link.id)).toHaveLength(0);
  });

  it("identity-match seed: writes per-side rows (agree baseline / disagree no baseline), monotone", async () => {
    const linkRepo = new RecordLinkRepository(db);
    const stateRepo = new SyncFieldStateRepository(db);
    const link = makeLink();
    await linkRepo.insert(link);

    // email agrees (baseline on both sides); name disagrees (no baseline).
    const rows: SyncFieldState[] = [
      fieldRow(link.id, {
        side: "A",
        fieldPath: "email",
        observedHash: "h-email",
        lastSyncedHash: "h-email",
        lastSyncedAt: T0,
      }),
      fieldRow(link.id, {
        side: "B",
        fieldPath: "email",
        observedHash: "h-email",
        lastSyncedHash: "h-email",
        lastSyncedAt: T0,
      }),
      fieldRow(link.id, { side: "A", fieldPath: "name", observedHash: "h-name-a" }),
      fieldRow(link.id, { side: "B", fieldPath: "name", observedHash: "h-name-b" }),
    ];
    await stateRepo.seed(rows);

    const stored = await stateRepo.findByLink(link.id);
    expect(stored).toHaveLength(4);
    const emailRows = stored.filter((r) => r.fieldPath === "email");
    const nameRows = stored.filter((r) => r.fieldPath === "name");
    expect(emailRows.every((r) => r.lastSyncedHash === "h-email")).toBe(true);
    expect(nameRows.every((r) => r.lastSyncedHash === undefined)).toBe(true);
    expect(stored.every((r) => r.observedChangeTimestamp === null)).toBe(true);

    // Monotone: re-seeding the same (link, side, field) keys does NOT overwrite or
    // duplicate — a recorded baseline is never erased.
    await stateRepo.seed([
      fieldRow(link.id, {
        side: "A",
        fieldPath: "name",
        observedHash: "changed",
        lastSyncedHash: "forged",
        lastSyncedAt: T0,
      }),
    ]);
    const afterReseed = await stateRepo.findByLink(link.id);
    expect(afterReseed).toHaveLength(4);
    const nameA = afterReseed.find((r) => r.side === "A" && r.fieldPath === "name");
    expect(nameA?.observedHash).toBe("h-name-a"); // untouched
    expect(nameA?.lastSyncedHash).toBeUndefined(); // no forged baseline
  });

  it("reBaseline (EP-3): canonical-capture round-trip — overwrites the baseline, inserts absent rows", async () => {
    const linkRepo = new RecordLinkRepository(db);
    const stateRepo = new SyncFieldStateRepository(db);
    const link = makeLink();
    await linkRepo.insert(link);

    // Prior reconciled state: B/country baselined at an OLD value.
    await stateRepo.seed([
      fieldRow(link.id, {
        side: "B",
        fieldPath: "country",
        observedHash: "old",
        lastSyncedHash: "old",
        lastSyncedAt: T0,
      }),
    ]);

    // A successful A→B write re-baselines both sides in their OWN representation: the
    // written side (B) from the target's stored value "Germany", the source side (A)
    // from the observed source "DE". The B row EXISTS (overwrite); the A row is new
    // (insert). The written side carries `lastWrittenByMappingId`; the source does not.
    const T1 = new Date("2026-07-13T02:00:00.000Z");
    const mappingId = randomUUID();
    await stateRepo.reBaseline([
      {
        id: randomUUID(),
        recordLinkId: link.id,
        side: "B",
        fieldPath: "country",
        lastSyncedHash: "hash-Germany",
        lastSyncedAt: T1,
        observedHash: "hash-Germany",
        observedAt: T1,
        observedChangeTimestamp: null,
        lastWrittenByMappingId: mappingId,
        status: "active",
      },
      {
        id: randomUUID(),
        recordLinkId: link.id,
        side: "A",
        fieldPath: "country",
        lastSyncedHash: "hash-DE",
        lastSyncedAt: T1,
        observedHash: "hash-DE",
        observedAt: T1,
        observedChangeTimestamp: null,
        status: "active",
      },
    ]);

    const stored = await stateRepo.findByLink(link.id);
    expect(stored).toHaveLength(2);
    const bCountry = stored.find((r) => r.side === "B" && r.fieldPath === "country");
    const aCountry = stored.find((r) => r.side === "A" && r.fieldPath === "country");
    // Written side OVERWRITTEN (not monotone) — the whole point of re-baselining.
    expect(bCountry?.lastSyncedHash).toBe("hash-Germany");
    expect(bCountry?.lastWrittenByMappingId).toBe(mappingId);
    // Source side captured in its own representation, no writer id.
    expect(aCountry?.lastSyncedHash).toBe("hash-DE");
    expect(aCountry?.lastWrittenByMappingId).toBeUndefined();
  });

  it("reBaseline preserves lastWrittenByMappingId when the incoming row omits it (COALESCE)", async () => {
    const linkRepo = new RecordLinkRepository(db);
    const stateRepo = new SyncFieldStateRepository(db);
    const link = makeLink();
    await linkRepo.insert(link);
    const priorWriter = randomUUID();

    // A row previously written by `priorWriter` on side A.
    await stateRepo.reBaseline([
      {
        id: randomUUID(),
        recordLinkId: link.id,
        side: "A",
        fieldPath: "email",
        lastSyncedHash: "h1",
        lastSyncedAt: T0,
        observedHash: "h1",
        observedAt: T0,
        observedChangeTimestamp: null,
        lastWrittenByMappingId: priorWriter,
        status: "active",
      },
    ]);

    // A later re-baseline of that side (as the READ source of a counterpart write)
    // omits the writer id — COALESCE must keep the prior writer, not clobber to NULL.
    await stateRepo.reBaseline([
      {
        id: randomUUID(),
        recordLinkId: link.id,
        side: "A",
        fieldPath: "email",
        lastSyncedHash: "h2",
        lastSyncedAt: T0,
        observedHash: "h2",
        observedAt: T0,
        observedChangeTimestamp: null,
        status: "active",
      },
    ]);

    const stored = await stateRepo.findByLink(link.id);
    const row = stored.find((r) => r.side === "A" && r.fieldPath === "email");
    expect(row?.lastSyncedHash).toBe("h2"); // reconcile columns updated
    expect(row?.lastWrittenByMappingId).toBe(priorWriter); // preserved via COALESCE
  });

  it("scopeRef (SS-12): setScopeRef persists the scope-link union and round-trips via getById", async () => {
    const repo = new RecordLinkRepository(db);
    const link = makeLink();
    await repo.insert(link);
    // Absent on a link established before its container was resolved.
    expect((await repo.getById(link.id))?.scopeRef).toBeUndefined();

    // The SS-12 port method — a targeted `scope_ref` jsonb UPDATE (the real mutation a fake
    // must mirror). The union round-trips verbatim (no Date inside the jsonb).
    await repo.setScopeRef(link.id, { kind: "scope-link", scopeLinkId: "scope-link-42" });
    expect((await repo.getById(link.id))?.scopeRef).toEqual({
      kind: "scope-link",
      scopeLinkId: "scope-link-42",
    });
  });

  it("scopeRef (SS-12.7): insert-with-scopeRef freezes the resolved-values union (establishment path)", async () => {
    const repo = new RecordLinkRepository(db);
    // The identity-resolution stage establishes a scoped link carrying its frozen container.
    const link = makeLink({
      id: randomUUID(),
      appANativeId: "a-scoped",
      appBNativeId: "b-scoped",
      scopeRef: { kind: "resolved", values: { owner: "alice", name: "phoenix" } },
    });
    await repo.insert(link);

    expect((await repo.getById(link.id))?.scopeRef).toEqual({
      kind: "resolved",
      values: { owner: "alice", name: "phoenix" },
    });
  });
});
