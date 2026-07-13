import { randomUUID } from "node:crypto";

import type { ParkedConflict } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { ParkedConflictRepository } from "./repositories/index.js";
import { parkedConflict } from "./schema.js";

/**
 * Live-database integration test for the SA-4 `parked_conflict` table + repository
 * (migration `0015`). What a fake cannot prove and this must: the **idempotent-open**
 * partial UNIQUE indexes (`parked_conflict_open_field_uq` /
 * `parked_conflict_open_delete_uq`) — the CF-review "re-processing the same still-
 * conflicting field updates/keeps the open row rather than duplicating it" requirement —
 * and the resolve-only-when-open fence. It also asserts the data-boundary invariant at
 * the schema level: there is no value column, so no raw contested value can be stored.
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

const T0 = new Date("2026-07-13T00:00:00.000Z");
const T1 = new Date("2026-07-13T01:00:00.000Z");

function fieldConflict(overrides: Partial<ParkedConflict> = {}): ParkedConflict {
  return {
    id: randomUUID(),
    recordLinkId: randomUUID(),
    syncRuleId: randomUUID(),
    mappingId: randomUUID(),
    kind: "manual-resolve",
    side: "B",
    fieldPath: "name",
    sourceObservedHash: "src-hash-1",
    targetObservedHash: "tgt-hash-1",
    status: "open",
    sourceNativeId: "a-1",
    details: "parked manual-resolve conflict on target field 'name'",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function driftedDelete(overrides: Partial<ParkedConflict> = {}): ParkedConflict {
  return {
    id: randomUUID(),
    recordLinkId: randomUUID(),
    syncRuleId: randomUUID(),
    mappingId: randomUUID(),
    kind: "drifted-delete",
    side: "B",
    status: "open",
    sourceNativeId: "a-1",
    details: "propagated delete parked — target drifted on 1 field(s) [name]",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

suite("Phase-4 parked_conflict integration (requires Postgres)", () => {
  let db: Database;
  let repo: ParkedConflictRepository;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    repo = new ParkedConflictRepository(db);
  });

  beforeEach(async () => {
    await db.delete(parkedConflict);
  });

  afterAll(async () => {
    await db.delete(parkedConflict);
    await closeDb(db);
  });

  it("opens a field conflict and reads it back on the open queue (hashes only)", async () => {
    const conflict = fieldConflict();
    await repo.upsertOpenFieldConflict(conflict);

    const open = await repo.listOpen(50);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(conflict.id);
    expect(open[0]?.kind).toBe("manual-resolve");
    expect(open[0]?.fieldPath).toBe("name");
    expect(open[0]?.sourceObservedHash).toBe("src-hash-1");
    expect(open[0]?.targetObservedHash).toBe("tgt-hash-1");
    // No resolution triple on an open row.
    expect(open[0]?.resolutionChoice).toBeUndefined();
    expect(open[0]?.resolvedBy).toBeUndefined();
  });

  it("re-parks the same (link, side, field) idempotently — ONE open row, refreshed hashes", async () => {
    const recordLinkId = randomUUID();
    const first = fieldConflict({ recordLinkId, targetObservedHash: "tgt-1" });
    await repo.upsertOpenFieldConflict(first);
    // A later poll re-parks the same still-conflicting field with a new contested hash
    // (a different row id) — must UPDATE the open row, not insert a duplicate.
    const second = fieldConflict({
      id: randomUUID(),
      recordLinkId,
      targetObservedHash: "tgt-2",
      updatedAt: T1,
    });
    await repo.upsertOpenFieldConflict(second);

    const open = await repo.listOpen(50);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(first.id); // the ORIGINAL row is kept
    expect(open[0]?.targetObservedHash).toBe("tgt-2"); // hashes refreshed
  });

  it("re-parks a drifted delete idempotently — ONE open row per link", async () => {
    const recordLinkId = randomUUID();
    const first = driftedDelete({ recordLinkId });
    await repo.upsertOpenDriftedDelete(first);
    await repo.upsertOpenDriftedDelete(driftedDelete({ id: randomUUID(), recordLinkId }));

    const open = await repo.listOpen(50);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(first.id);
    expect(open[0]?.kind).toBe("drifted-delete");
    expect(open[0]?.fieldPath).toBeUndefined();
  });

  it("resolve marks an open row resolved (OA-3) and drops it off the open queue", async () => {
    const conflict = fieldConflict();
    await repo.upsertOpenFieldConflict(conflict);

    const resolved = await repo.resolve(conflict.id, {
      choice: "source-wins",
      resolvedBy: "operator@x",
      resolvedAt: T1,
    });
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolutionChoice).toBe("source-wins");
    expect(resolved?.resolvedBy).toBe("operator@x");
    expect(resolved?.resolvedAt).toEqual(T1);

    expect(await repo.listOpen(50)).toHaveLength(0);
  });

  it("resolve of an already-resolved (or unknown) row is a safe no-op (returns undefined)", async () => {
    const conflict = fieldConflict();
    await repo.upsertOpenFieldConflict(conflict);
    await repo.resolve(conflict.id, { choice: "target-wins", resolvedBy: "op", resolvedAt: T1 });

    const second = await repo.resolve(conflict.id, {
      choice: "source-wins",
      resolvedBy: "op2",
      resolvedAt: T1,
    });
    expect(second).toBeUndefined();
    expect(
      await repo.resolve(randomUUID(), { choice: "sever", resolvedBy: "op", resolvedAt: T1 }),
    ).toBeUndefined();
  });

  it("a resolved row frees the open key — a later re-park opens a FRESH row", async () => {
    const recordLinkId = randomUUID();
    const first = fieldConflict({ recordLinkId });
    await repo.upsertOpenFieldConflict(first);
    await repo.resolve(first.id, { choice: "source-wins", resolvedBy: "op", resolvedAt: T1 });

    const second = fieldConflict({ id: randomUUID(), recordLinkId });
    await repo.upsertOpenFieldConflict(second);

    const open = await repo.listOpen(50);
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe(second.id); // a new open row, not the resolved one
  });
});
