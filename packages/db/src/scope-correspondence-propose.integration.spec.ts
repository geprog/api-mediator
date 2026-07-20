import { randomUUID } from "node:crypto";

import type { ScopeCorrespondence } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { ScopeCorrespondenceRepository } from "./repositories/index.js";
import { scopeCorrespondence } from "./schema.js";

/**
 * **SS-18.6 live-database integration** for `ScopeCorrespondenceRepository.propose` — the
 * production writer of `ScopeCorrespondence` this slice adds. The three semantics SS-18.6
 * demands are all *database* semantics (a UNIQUE index plus a conditional
 * `ON CONFLICT DO UPDATE ... WHERE confirmed_by IS NULL`), so a fake cannot prove them;
 * only real Postgres can:
 *
 *  - **never a duplicate** — one row per `resourcePairRef`, however many times a
 *    re-ingested spec / re-run instantiation / second approval re-derives it;
 *  - **never clobbers a confirmed artifact** — an operator-confirmed `scopeIdentityKey`
 *    and its `confirmedBy`/`confirmedAt` survive every later re-derivation byte-identical;
 *  - **an unconfirmed candidate may be refreshed** — a newer derivation overwrites it.
 *
 * It also covers `listByResourceSide`, the reverse lookup the SS-18.4 kind selector uses.
 *
 * **No migration is added by SS-18**: `scope_correspondence` already exists (migration
 * 0016). This suite runs the existing chain unchanged.
 *
 * Excluded from `pnpm verify`; run with `pnpm --filter @mediator/db test:integration`.
 * Self-skips when `DATABASE_URL` is unresolvable.
 */
let databaseUrl: string | undefined;
try {
  databaseUrl = resolveDatabaseUrl(process.env);
} catch {
  databaseUrl = undefined;
}
const suite = databaseUrl === undefined ? describe.skip : describe;

const APP_A = randomUUID();
const APP_B = randomUUID();
const PAIR_REF = `${APP_A}:issues|${APP_B}:tasks`;
const OTHER_PAIR_REF = `${APP_A}:users|${APP_B}:members`;

function candidateOf(overrides: Partial<ScopeCorrespondence> = {}): ScopeCorrespondence {
  return {
    id: randomUUID(),
    resourcePairRef: PAIR_REF,
    scopeIdentityKey: [
      { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "rename" } },
    ],
    targetContainerRef: { appId: APP_B, resourceRef: "projects" },
    sourceContainerRef: { appId: APP_A, resourceRef: "repos" },
    confirmedBy: null,
    confirmedAt: null,
    ...overrides,
  };
}

suite("ScopeCorrespondenceRepository.propose — SS-18.6 (requires Postgres)", () => {
  let db: Database;
  let repo: ScopeCorrespondenceRepository;

  beforeAll(async () => {
    db = createDb(databaseUrl ?? "");
    await runMigrations(db);
    repo = new ScopeCorrespondenceRepository(db);
  });

  beforeEach(async () => {
    await db.delete(scopeCorrespondence);
  });

  afterAll(async () => {
    await db.delete(scopeCorrespondence);
    await db.$client.end();
  });

  it("inserts a proposal UNCONFIRMED — nothing is auto-confirmed (SS-18.1 / 18.8)", async () => {
    const stored = await repo.propose(candidateOf());

    expect(stored.resourcePairRef).toBe(PAIR_REF);
    expect(stored.confirmedBy).toBeNull();
    expect(stored.confirmedAt).toBeNull();
    expect(stored.sourceContainerRef).toStrictEqual({ appId: APP_A, resourceRef: "repos" });
    expect(stored.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "rename" } },
    ]);
  });

  it("never creates a duplicate — one correspondence per resource pair (SS-10.1 / SS-18.6)", async () => {
    const first = await repo.propose(candidateOf());
    // A re-ingested spec / re-run instantiation re-derives with a FRESH candidate id.
    await repo.propose(candidateOf());
    await repo.propose(candidateOf());

    const rows = await db.select().from(scopeCorrespondence);
    expect(rows).toHaveLength(1);
    // The stored row keeps its original identity; the candidate ids are discarded.
    expect(rows[0]?.id).toBe(first.id);
  });

  it("refreshes an UNCONFIRMED candidate with the newer derivation (SS-18.6)", async () => {
    await repo.propose(candidateOf());

    const refreshed = await repo.propose(
      candidateOf({
        scopeIdentityKey: [{ sourceScopeKey: "slug", targetFieldPath: "identifier" }],
        targetContainerRef: { appId: APP_B, resourceRef: "boards" },
      }),
    );

    expect(refreshed.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "slug", targetFieldPath: "identifier" },
    ]);
    expect(refreshed.targetContainerRef).toStrictEqual({ appId: APP_B, resourceRef: "boards" });
    expect(refreshed.confirmedBy).toBeNull();
  });

  it("NEVER clobbers a CONFIRMED scopeIdentityKey or its confirmation (SS-18.6)", async () => {
    // The operator confirms (or corrects) the candidate through the SS-15.4 panel.
    const confirmedAt = new Date("2026-07-19T12:00:00.000Z");
    const confirmed = await repo.confirmOrUpdate(
      candidateOf({
        scopeIdentityKey: [{ sourceScopeKey: "owner", targetFieldPath: "ownerLogin" }],
        confirmedBy: "operator",
        confirmedAt,
      }),
    );

    // A later re-derivation proposes something entirely different …
    const afterReDerive = await repo.propose(
      candidateOf({
        scopeIdentityKey: [{ sourceScopeKey: "stale", targetFieldPath: "stale" }],
        targetContainerRef: { appId: APP_B, resourceRef: "stale" },
      }),
    );

    // … and changes nothing: the confirmed row comes back untouched.
    expect(afterReDerive.id).toBe(confirmed.id);
    expect(afterReDerive.confirmedBy).toBe("operator");
    expect(afterReDerive.confirmedAt).toStrictEqual(confirmedAt);
    expect(afterReDerive.scopeIdentityKey).toStrictEqual([
      { sourceScopeKey: "owner", targetFieldPath: "ownerLogin" },
    ]);
    expect(afterReDerive.targetContainerRef).toStrictEqual({
      appId: APP_B,
      resourceRef: "projects",
    });

    const rows = await db.select().from(scopeCorrespondence);
    expect(rows).toHaveLength(1);
  });

  it("round-trips an ABSENT sourceContainerRef — the SS-13.4 pinned case", async () => {
    const candidate = candidateOf();
    delete candidate.sourceContainerRef;
    const stored = await repo.propose(candidate);

    expect(stored.sourceContainerRef).toBeUndefined();
    expect(await repo.getByResourcePair(PAIR_REF)).toStrictEqual(stored);
  });

  it("listByResourceSide finds the pair from either side, and only that pair (SS-18.4)", async () => {
    await repo.propose(candidateOf());
    await repo.propose(candidateOf({ resourcePairRef: OTHER_PAIR_REF }));

    const fromTarget = await repo.listByResourceSide(APP_B, "tasks");
    expect(fromTarget.map((entry) => entry.resourcePairRef)).toStrictEqual([PAIR_REF]);

    const fromSource = await repo.listByResourceSide(APP_A, "issues");
    expect(fromSource.map((entry) => entry.resourcePairRef)).toStrictEqual([PAIR_REF]);

    // A resource in no scoped pair gets nothing -> `scope-link` stays unavailable for it.
    expect(await repo.listByResourceSide(APP_B, "labels")).toStrictEqual([]);
    // And a token that is only a PREFIX of a stored one must not match.
    expect(await repo.listByResourceSide(APP_B, "task")).toStrictEqual([]);
  });
});
