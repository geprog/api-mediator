import { randomUUID } from "node:crypto";

import type { RecordLink, ResourceBinding } from "@mediator/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, createDb, type Database } from "./client.js";
import { resolveDatabaseUrl } from "./env.js";
import { runMigrations } from "./migrate.js";
import { RecordLinkRepository, ResourceBindingRepository } from "./repositories/index.js";
import {
  apiSpec,
  recordLink,
  registeredApp,
  resourceBinding,
  resourceBindingRef,
} from "./schema.js";

/**
 * Live-database integration test for the **SS-19 container-relative addressing**
 * persistence (migration `0020`): the new `record_link.app_{a,b}_record_address` columns
 * and the new `resource_binding_ref_kind` enum member `recordAddressRef`.
 *
 * A fake repository cannot prove any of what matters here — that the enum value actually
 * exists in Postgres, that the address columns are genuinely NULLABLE (the whole
 * backward-compatibility story rests on it), that an address round-trips as an **absent**
 * domain key rather than `null`, and above all that the addresses are *not* part of the
 * identity indexes: two links whose addresses collide across containers must both be
 * insertable, because a container-relative address is unique only inside its container.
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

const T0 = new Date("2026-07-21T00:00:00.000Z");

function makeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: randomUUID(),
    appAId: randomUUID(),
    appANativeId: "task-1",
    appBId: randomUUID(),
    appBNativeId: "4242",
    resourcePairRef: "pair::issues",
    establishedBy: "create-propagation",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "Ship it" },
    createdAt: T0,
    tombstonedAt: null,
    ...overrides,
  };
}

suite("SS-19 record-address persistence integration (requires Postgres)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  beforeEach(async () => {
    await db.delete(recordLink);
    await db.delete(resourceBindingRef);
    await db.delete(resourceBinding);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
  });

  afterAll(async () => {
    await db.delete(recordLink);
    await db.delete(resourceBindingRef);
    await db.delete(resourceBinding);
    await db.delete(apiSpec);
    await db.delete(registeredApp);
    await closeDb(db);
  });

  it("round-trips both sides' container-relative addresses alongside the global native ids", async () => {
    const repo = new RecordLinkRepository(db);
    const link = makeLink({ appARecordAddress: "12", appBRecordAddress: "7" });
    await repo.insert(link);

    const loaded = await repo.getById(link.id);
    expect(loaded?.appARecordAddress).toBe("12");
    expect(loaded?.appBRecordAddress).toBe("7");
    // Addressing never displaces identity: the native ids are untouched.
    expect(loaded?.appANativeId).toBe("task-1");
    expect(loaded?.appBNativeId).toBe("4242");
  });

  it("an absent address persists as NULL and reads back as an ABSENT key, not null", async () => {
    const repo = new RecordLinkRepository(db);
    // Exactly the shape of every link that predates migration 0020.
    const link = makeLink();
    await repo.insert(link);

    const loaded = await repo.getById(link.id);
    expect(loaded).toBeDefined();
    // `stripUndefined` semantics: the key is absent, so `in` is false — the write path's
    // `?? undefined` fallback and `exactOptionalPropertyTypes` both depend on this.
    expect("appARecordAddress" in (loaded as object)).toBe(false);
    expect("appBRecordAddress" in (loaded as object)).toBe(false);
    // And the link is still fully usable — the columns really are nullable.
    expect(
      (
        await repo.findActiveByRecord(link.resourcePairRef, {
          appId: link.appBId,
          nativeId: link.appBNativeId,
        })
      )?.id,
    ).toBe(link.id);
  });

  it("one side addressed, the other not — the two sides are independent", async () => {
    const repo = new RecordLinkRepository(db);
    // Gitea (container-addressed) ↔ Vikunja (native-id-addressed) is the capstone pair.
    const link = makeLink({ appBRecordAddress: "7" });
    await repo.insert(link);

    const loaded = await repo.getById(link.id);
    expect("appARecordAddress" in (loaded as object)).toBe(false);
    expect(loaded?.appBRecordAddress).toBe("7");
  });

  it("colliding addresses both persist — the address participates in NO unique/identity index", async () => {
    const repo = new RecordLinkRepository(db);
    // Repo A's #1 and repo B's #1: the same container-relative address, globally distinct
    // records. To make this falsifiable the ADDRESS dimension must be the only thing the two
    // links share-and-collide on, so everything the real indexes key by is held **constant**
    // (`resourcePairRef`, `appAId`, `appBId`) and only the native ids vary — the minimum that
    // keeps native-id uniqueness satisfiable for two genuinely distinct records.
    //
    // Under the real schema both insert. Under the hypothetical this test exists to exclude —
    // an index that keys a side by its address instead of its native id, i.e.
    // `(resource_pair_ref, app_b_id, app_b_record_address)` — the second insert would be
    // rejected, because the two differ *only* in native id. That rejection would be the
    // record-merge bug this system guards hardest against, relocated into the schema.
    const appAId = randomUUID();
    const appBId = randomUUID();
    const resourcePairRef = "pair::issues";
    const shared = { appAId, appBId, resourcePairRef, appARecordAddress: "1" } as const;
    const inPhoenix = makeLink({
      ...shared,
      appANativeId: "task-11",
      appBNativeId: "5001",
      appBRecordAddress: "1",
    });
    const inAtlas = makeLink({
      ...shared,
      appANativeId: "task-22",
      appBNativeId: "9002",
      appBRecordAddress: "1",
    });
    await repo.insert(inPhoenix);
    await expect(repo.insert(inAtlas)).resolves.toBeUndefined();

    // Both sides' addresses collide across the two links, on the same pair and the same apps.
    expect((await repo.getById(inPhoenix.id))?.appBRecordAddress).toBe("1");
    expect((await repo.getById(inAtlas.id))?.appBRecordAddress).toBe("1");
    expect((await repo.getById(inPhoenix.id))?.appARecordAddress).toBe("1");

    // ...and resolution still discriminates by NATIVE ID despite the identical addresses:
    // each lookup returns its own link, never the other. This is the positive half of the
    // claim — the address is not merely absent from the indexes, it is absent from the
    // resolve path the whole pipeline routes through.
    expect(
      (await repo.findActiveByRecord(resourcePairRef, { appId: appBId, nativeId: "5001" }))?.id,
    ).toBe(inPhoenix.id);
    expect(
      (await repo.findActiveByRecord(resourcePairRef, { appId: appBId, nativeId: "9002" }))?.id,
    ).toBe(inAtlas.id);
  });

  it("the `recordAddressRef` ref kind exists in the Postgres enum and persists unconfirmed → confirmed", async () => {
    const appId = randomUUID();
    await db.insert(registeredApp).values({
      id: appId,
      name: `gitea-${appId.slice(0, 8)}`,
      baseUrl: "https://gitea.test",
      status: "active",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: true,
        defaultPollInterval: 60_000,
      },
    });
    const specId = randomUUID();
    await db.insert(apiSpec).values({
      id: specId,
      appId,
      role: "PROVIDER",
      version: 1,
      status: "active",
      rawDocument: {},
      parsedIr: [],
      contentHash: `hash-${specId}`,
    });

    const repo = new ResourceBindingRepository(db);
    // Derived-unconfirmed, exactly as RB-1 leaves it — the derive-then-confirm contract.
    const binding: ResourceBinding = {
      id: randomUUID(),
      apiSpecId: specId,
      resourceRef: "issues",
      nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
      recordAddressRef: {
        value: { kind: "field", path: "number" },
        confirmedBy: null,
        confirmedAt: null,
      },
      scopePathBindings: [],
    };
    await repo.createMany([binding]);

    const stored = (await repo.listByApiSpecId(specId))[0];
    expect(stored?.recordAddressRef?.value).toEqual({ kind: "field", path: "number" });
    expect(stored?.recordAddressRef?.confirmedBy).toBeNull();
    expect(stored?.recordAddressRef?.confirmedAt).toBeNull();
    // The two identities are stored as two independent refs on the same binding.
    expect(stored?.nativeIdRef?.value).toEqual({ kind: "field", path: "id" });

    // RB-3 confirm — the same mechanism every other ref uses, and `confirmed_at` lands in a
    // real `timestamptz` column (not a stringified date in jsonb).
    const confirmedAt = new Date("2026-07-21T09:30:00.000Z");
    await repo.update(binding.id, {
      recordAddressRef: { confirmedBy: "operator@test", confirmedAt },
    });

    const confirmed = (await repo.listByApiSpecId(specId))[0];
    expect(confirmed?.recordAddressRef?.confirmedBy).toBe("operator@test");
    expect(confirmed?.recordAddressRef?.confirmedAt).toEqual(confirmedAt);
  });
});
