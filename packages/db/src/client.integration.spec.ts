import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb, createDb, tx, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { schemaProbe } from "./schema.js";

/**
 * Live-database integration test for the Phase-0 bootstrap. Requires the compose
 * `postgres` service to be running (`docker compose up -d postgres --wait`) and
 * `DATABASE_URL` to be resolvable (exported, or in the repo-root `.env` loaded by
 * `vitest.integration.config.ts`). It is excluded from the default `pnpm test`
 * run and only executes via `pnpm --filter @mediator/db test:integration`.
 *
 * It proves the whole pipeline: apply the generated migration, then round-trip a
 * `schema_probe` row through the {@link tx} transaction helper.
 */
describe("db integration (requires Postgres)", () => {
  let db: Database;
  const createdIds: string[] = [];

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await db.delete(schemaProbe).where(eq(schemaProbe.id, id));
    }
    await closeDb(db);
  });

  it("inserts and reads back a schema_probe row inside tx()", async () => {
    const note = `probe-${randomUUID()}`;

    const inserted = await tx(db, async (txn) => {
      const rows = await txn.insert(schemaProbe).values({ note }).returning();
      return rows[0];
    });

    expect(inserted).toBeDefined();
    if (inserted === undefined) {
      throw new Error("insert returned no row");
    }
    createdIds.push(inserted.id);

    expect(inserted.note).toBe(note);
    expect(inserted.createdAt).toBeInstanceOf(Date);

    const fetched = await db.select().from(schemaProbe).where(eq(schemaProbe.id, inserted.id));

    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.note).toBe(note);
  });

  it("rolls back the transaction when the callback throws", async () => {
    const note = `rollback-${randomUUID()}`;

    await expect(
      tx(db, async (txn) => {
        await txn.insert(schemaProbe).values({ note });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const rows = await db.select().from(schemaProbe).where(eq(schemaProbe.note, note));

    expect(rows).toHaveLength(0);
  });
});
