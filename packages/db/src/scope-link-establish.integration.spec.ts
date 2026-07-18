import { randomUUID } from "node:crypto";

import type { ScopeCorrespondence, ScopeKey, ScopeLink } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { ScopeCorrespondenceRepository, ScopeLinkRepository } from "./repositories/index.js";
import { scopeCorrespondence, scopeLink } from "./schema.js";

/**
 * Live-database integration test for the SS-11 `ScopeLink` **persistence mutations** —
 * the idempotent, direction-agnostic `establish` and the `sever` (manual unlink). Every
 * establish/sever path is exercised on real Postgres (per the [[fakes-must-mirror-real-repos]]
 * rule: a persistence mutation needs a real-DB test, not just the fake), covering the
 * `created` / `exists` / `conflict` outcomes, the jsonb scope-key match, and the
 * one-canonical-link-per-container-pair invariant when a link is discovered from either
 * direction.
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

const T0 = new Date("2026-07-18T00:00:00.000Z");
// A source app id that sorts BEFORE the target so the canonical A/B assignment is
// deterministic (side A is the lexicographically-smaller appId).
const SOURCE_APP = "00000000-0000-4000-8000-00000000a001";
const TARGET_APP = "00000000-0000-4000-8000-00000000b002";
const PAIR = `${SOURCE_APP}:issues|${TARGET_APP}:tasks`;

function makeCorrespondence(): ScopeCorrespondence {
  return {
    id: randomUUID(),
    resourcePairRef: PAIR,
    scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "title" }],
    targetContainerRef: { appId: TARGET_APP, resourceRef: "projects" },
    sourceContainerRef: { appId: SOURCE_APP, resourceRef: "repos" },
    confirmedBy: "operator@example.test",
    confirmedAt: T0,
  };
}

function canonicalLink(
  correspondenceId: string,
  sourceScopeKey: ScopeKey,
  targetScopeKey: ScopeKey,
): ScopeLink {
  // SOURCE_APP < TARGET_APP, so source is canonical side A.
  return {
    id: randomUUID(),
    scopeCorrespondenceId: correspondenceId,
    appAId: SOURCE_APP,
    appAScopeKey: sourceScopeKey,
    appBId: TARGET_APP,
    appBScopeKey: targetScopeKey,
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    createdAt: T0,
  };
}

suite("Scope-link establish/sever (SS-11) integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(scopeLink);
    await db.delete(scopeCorrespondence);
  });

  afterAll(async () => {
    await db.delete(scopeLink);
    await db.delete(scopeCorrespondence);
    await closeDb(db);
  });

  it("SS-11: establish is created-then-idempotent (a re-establish is `exists`, never a duplicate)", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);

    const link = canonicalLink(
      correspondence.id,
      { owner: "alice", name: "phoenix" },
      { id: "42" },
    );
    const created = await linkRepo.establish(link);
    expect(created.kind).toBe("created");

    // Re-establishing the SAME two containers is a no-op (`exists`), even with a fresh id.
    const again = await linkRepo.establish({ ...link, id: randomUUID() });
    expect(again.kind).toBe("exists");
    if (again.kind === "exists") {
      expect(again.link.id).toBe(link.id); // the original row, not the new id
    }
    const rows = await db.select().from(scopeLink);
    expect(rows).toHaveLength(1);
  });

  it("SS-11: establish is direction-agnostic — a link built from either direction resolves the same row", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);

    // First establish from the source side (canonical A = source).
    const forward = canonicalLink(
      correspondence.id,
      { owner: "alice", name: "phoenix" },
      { id: "42" },
    );
    expect((await linkRepo.establish(forward)).kind).toBe("created");

    // A "reverse-direction" establish carries the SAME canonical A/B assignment (the
    // caller's canonicalScopeSides ordered by appId), so it maps to the same row → `exists`.
    const reverse = canonicalLink(
      correspondence.id,
      { owner: "alice", name: "phoenix" },
      { id: "42" },
    );
    expect((await linkRepo.establish({ ...reverse, id: randomUUID() })).kind).toBe("exists");
    expect(await db.select().from(scopeLink)).toHaveLength(1);

    // Both sides resolve the single canonical link by their captured scope key.
    expect(
      (
        await linkRepo.lookupByScopeKey(PAIR, {
          appId: SOURCE_APP,
          scopeKey: { name: "phoenix", owner: "alice" },
        })
      )?.id,
    ).toBe(forward.id);
    expect(
      (await linkRepo.lookupByScopeKey(PAIR, { appId: TARGET_APP, scopeKey: { id: "42" } }))?.id,
    ).toBe(forward.id);
  });

  it("SS-11: establish refuses to re-point a container already linked to a different counterpart (conflict)", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);

    const link = canonicalLink(
      correspondence.id,
      { owner: "alice", name: "phoenix" },
      { id: "42" },
    );
    await linkRepo.establish(link);

    // Same source container, DIFFERENT target → conflict (existing returned, untouched).
    const conflict = await linkRepo.establish(
      canonicalLink(correspondence.id, { owner: "alice", name: "phoenix" }, { id: "99" }),
    );
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.existing.id).toBe(link.id);
      expect(conflict.existing.appBScopeKey).toStrictEqual({ id: "42" });
    }
    // Same target container, DIFFERENT source → also a conflict.
    const conflictB = await linkRepo.establish(
      canonicalLink(correspondence.id, { owner: "bob", name: "atlas" }, { id: "42" }),
    );
    expect(conflictB.kind).toBe("conflict");
    expect(await db.select().from(scopeLink)).toHaveLength(1);
  });

  it("SS-11.6: sever hard-deletes a link (distinct from archive)", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);

    const link = canonicalLink(
      correspondence.id,
      { owner: "alice", name: "phoenix" },
      { id: "42" },
    );
    await linkRepo.establish(link);

    expect(await linkRepo.sever(link.id)).toBe(true);
    expect(await linkRepo.getById(link.id)).toBeUndefined();
    expect(await db.select().from(scopeLink)).toHaveLength(0);
    // Severing an unknown id is a false no-op.
    expect(await linkRepo.sever(randomUUID())).toBe(false);
  });
});
