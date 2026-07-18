import { randomUUID } from "node:crypto";

import type { RecordLink, ScopeCorrespondence, ScopeLink } from "@mediator/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import {
  RecordLinkRepository,
  ScopeCorrespondenceRepository,
  ScopeLinkRepository,
} from "./repositories/index.js";
import { recordLink, scopeCorrespondence, scopeLink } from "./schema.js";

/**
 * Live-database integration test for the scoped-resource-sync L3 (SS-10) tables:
 * `scope_correspondence`, `scope_link`, and the `record_link.scope_ref` column
 * (migration `0018`). The requirement calls out for a REAL database: the migration
 * applying clean on the chain, the `jsonb` round-trip of the open-ended shapes
 * (scope-identity-key, container refs, scope-key maps, the `scopeRef` union), the
 * "one per scoped resource pair" UNIQUE-index upsert, the jsonb scope-key lookup, and
 * the **archive-not-delete** rule with a `RecordLink.scopeRef` that still resolves.
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

const T0 = new Date("2026-07-17T00:00:00.000Z");
const PAIR = "lineage-gitea:issues|lineage-vikunja:tasks";

function makeCorrespondence(overrides: Partial<ScopeCorrespondence> = {}): ScopeCorrespondence {
  return {
    id: randomUUID(),
    resourcePairRef: PAIR,
    scopeIdentityKey: [
      { sourceScopeKey: "owner", targetFieldPath: "owner_username" },
      { sourceScopeKey: "name", targetFieldPath: "title" },
    ],
    targetContainerRef: { appId: randomUUID(), resourceRef: "projects" },
    sourceContainerRef: { appId: randomUUID(), resourceRef: "repos" },
    confirmedBy: "operator@example.test",
    confirmedAt: T0,
    ...overrides,
  };
}

function makeScopeLink(
  scopeCorrespondenceId: string,
  overrides: Partial<ScopeLink> = {},
): ScopeLink {
  return {
    id: randomUUID(),
    scopeCorrespondenceId,
    appAId: randomUUID(),
    appAScopeKey: { owner: "alice", name: "phoenix" },
    appBId: randomUUID(),
    appBScopeKey: { id: "42" },
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    createdAt: T0,
    ...overrides,
  };
}

function makeRecordLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: randomUUID(),
    appAId: randomUUID(),
    appANativeId: "a-1",
    appBId: randomUUID(),
    appBNativeId: "b-1",
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "issue-1" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

suite("Scoped-resource-sync L3 (SS-10) integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    // Migration 0018 applies clean on the whole chain, or this throws.
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(recordLink);
    await db.delete(scopeLink);
    await db.delete(scopeCorrespondence);
  });

  afterAll(async () => {
    await db.delete(recordLink);
    await db.delete(scopeLink);
    await db.delete(scopeCorrespondence);
    await closeDb(db);
  });

  it("SS-10.1/3: a ScopeCorrespondence + two ScopeLinks under it round-trip", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);

    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);

    const linkA = makeScopeLink(correspondence.id, {
      appAScopeKey: { owner: "alice", name: "phoenix" },
      appBScopeKey: { id: "42" },
    });
    const linkB = makeScopeLink(correspondence.id, {
      establishedBy: "manual",
      appAScopeKey: { owner: "bob", name: "atlas" },
      appBScopeKey: { id: "99" },
    });
    await linkRepo.create(linkA);
    await linkRepo.create(linkB);

    const storedCorrespondence = await correspondenceRepo.getById(correspondence.id);
    expect(storedCorrespondence).toStrictEqual(correspondence);
    // Direction-agnostic resourcePairRef resolves the single config for the pair.
    expect((await correspondenceRepo.getByResourcePair(PAIR))?.id).toBe(correspondence.id);

    const underCorrespondence = await linkRepo.listByCorrespondence(correspondence.id);
    expect(underCorrespondence).toHaveLength(2);
    expect(await linkRepo.getById(linkA.id)).toStrictEqual(linkA);
    // The jsonb scope-key maps round-trip verbatim (multi-component + single-component).
    expect((await linkRepo.getById(linkB.id))?.appAScopeKey).toStrictEqual({
      owner: "bob",
      name: "atlas",
    });
  });

  it("SS-10.2: confirmOrUpdate is one-per-pair — a second confirm updates in place, not a duplicate", async () => {
    const repo = new ScopeCorrespondenceRepository(db);

    const first = makeCorrespondence({ confirmedBy: null, confirmedAt: null });
    const inserted = await repo.confirmOrUpdate(first);
    expect(inserted.id).toBe(first.id);
    expect(inserted.confirmedBy).toBeNull();

    // A later confirmation for the SAME pair (different candidate id) updates the
    // existing row — the UNIQUE(resource_pair_ref) upsert keeps the original id.
    const second = makeCorrespondence({
      id: randomUUID(),
      confirmedBy: "operator@example.test",
      confirmedAt: T0,
      scopeIdentityKey: [{ sourceScopeKey: "name", targetFieldPath: "identifier" }],
    });
    const updated = await repo.confirmOrUpdate(second);
    expect(updated.id).toBe(first.id); // original id preserved
    expect(updated.confirmedBy).toBe("operator@example.test");
    expect(updated.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "name", targetFieldPath: "identifier" },
    ]);
    // Still exactly one correspondence for the pair.
    const rows = await db.select().from(scopeCorrespondence);
    expect(rows).toHaveLength(1);
  });

  it("SS-10: lookupByScopeKey resolves the active link by a side's captured scope-key map", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const linkRepo = new ScopeLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);
    const link = makeScopeLink(correspondence.id, {
      appAScopeKey: { owner: "alice", name: "phoenix" },
      appBScopeKey: { id: "42" },
    });
    await linkRepo.create(link);

    // Match the source side by its captured scope (key order deliberately swapped to
    // prove jsonb normalization, not textual equality).
    const resolved = await linkRepo.lookupByScopeKey(PAIR, {
      appId: link.appAId,
      scopeKey: { name: "phoenix", owner: "alice" },
    });
    expect(resolved?.id).toBe(link.id);

    // Match the target side by its single-component key.
    const resolvedTarget = await linkRepo.lookupByScopeKey(PAIR, {
      appId: link.appBId,
      scopeKey: { id: "42" },
    });
    expect(resolvedTarget?.id).toBe(link.id);

    // A non-matching scope key resolves nothing.
    expect(
      await linkRepo.lookupByScopeKey(PAIR, {
        appId: link.appAId,
        scopeKey: { owner: "alice", name: "atlas" },
      }),
    ).toBeUndefined();
  });

  it("SS-10.4: a RecordLink round-trips each scopeRef kind (scope-link / resolved)", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const scopeLinkRepo = new ScopeLinkRepository(db);
    const recordLinkRepo = new RecordLinkRepository(db);
    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);
    const link = makeScopeLink(correspondence.id);
    await scopeLinkRepo.create(link);

    // L3 scope-link kind — a reference to the ScopeLink.
    const scopeLinkRef = makeRecordLink({
      scopeRef: { kind: "scope-link", scopeLinkId: link.id },
    });
    await recordLinkRepo.insert(scopeLinkRef);
    expect((await recordLinkRepo.getById(scopeLinkRef.id))?.scopeRef).toStrictEqual({
      kind: "scope-link",
      scopeLinkId: link.id,
    });

    // L2 resolved kind — a frozen { parameterName → value } map.
    const resolvedRef = makeRecordLink({
      appANativeId: "a-2",
      appBNativeId: "b-2",
      scopeRef: { kind: "resolved", values: { owner: "alice", name: "phoenix" } },
    });
    await recordLinkRepo.insert(resolvedRef);
    expect((await recordLinkRepo.getById(resolvedRef.id))?.scopeRef).toStrictEqual({
      kind: "resolved",
      values: { owner: "alice", name: "phoenix" },
    });

    // setScopeRef persists a scopeRef captured after establishment.
    const late = makeRecordLink({ appANativeId: "a-3", appBNativeId: "b-3" });
    await recordLinkRepo.insert(late);
    await recordLinkRepo.setScopeRef(late.id, { kind: "scope-link", scopeLinkId: link.id });
    expect((await recordLinkRepo.getById(late.id))?.scopeRef).toStrictEqual({
      kind: "scope-link",
      scopeLinkId: link.id,
    });
  });

  it("SS-10.4: a non-scoped RecordLink has scope_ref NULL (absent domain key)", async () => {
    const repo = new RecordLinkRepository(db);
    const nonScoped = makeRecordLink();
    await repo.insert(nonScoped);

    const stored = await repo.getById(nonScoped.id);
    expect(stored?.scopeRef).toBeUndefined();
    expect(stored !== undefined && "scopeRef" in stored).toBe(false);

    // And the underlying column is really NULL, not an empty jsonb.
    const [row] = await db.select().from(recordLink).where(eq(recordLink.id, nonScoped.id));
    expect(row?.scopeRef).toBeNull();
  });

  it("SS-10.5: archiving a correspondence's ScopeLinks sets archived (not deleted); the pointing RecordLink.scopeRef still resolves its stored key", async () => {
    const correspondenceRepo = new ScopeCorrespondenceRepository(db);
    const scopeLinkRepo = new ScopeLinkRepository(db);
    const recordLinkRepo = new RecordLinkRepository(db);

    const correspondence = makeCorrespondence();
    await correspondenceRepo.create(correspondence);
    const linkA = makeScopeLink(correspondence.id);
    const linkB = makeScopeLink(correspondence.id, {
      appAScopeKey: { owner: "bob", name: "atlas" },
      appBScopeKey: { id: "99" },
    });
    await scopeLinkRepo.create(linkA);
    await scopeLinkRepo.create(linkB);

    // A record whose stored container points at linkA (a final delete would route here).
    const record = makeRecordLink({ scopeRef: { kind: "scope-link", scopeLinkId: linkA.id } });
    await recordLinkRepo.insert(record);

    const archivedCount = await scopeLinkRepo.archiveByCorrespondence(correspondence.id);
    expect(archivedCount).toBe(2);

    // Both links survive, archived — never deleted.
    const stillThere = await scopeLinkRepo.listByCorrespondence(correspondence.id);
    expect(stillThere).toHaveLength(2);
    expect(stillThere.every((l) => l.status === "archived")).toBe(true);

    // The RecordLink.scopeRef still reads its frozen key, and that scopeLinkId still
    // resolves to the (now archived) ScopeLink — the archived-still-resolves rule.
    const storedRecord = await recordLinkRepo.getById(record.id);
    expect(storedRecord?.scopeRef).toStrictEqual({ kind: "scope-link", scopeLinkId: linkA.id });
    const resolvedContainer =
      storedRecord?.scopeRef?.kind === "scope-link"
        ? await scopeLinkRepo.getById(storedRecord.scopeRef.scopeLinkId)
        : undefined;
    expect(resolvedContainer?.id).toBe(linkA.id);
    expect(resolvedContainer?.status).toBe("archived");
    // An archived link is no longer resolvable as an active container.
    expect(
      await scopeLinkRepo.lookupByScopeKey(PAIR, {
        appId: linkA.appAId,
        scopeKey: linkA.appAScopeKey,
      }),
    ).toBeUndefined();
  });
});
