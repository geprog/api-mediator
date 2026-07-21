import { describe, expect, it } from "vitest";

import {
  AdapterTokenStore,
  formatAdapterToken,
  generateAdapterTokenSecret,
  parseAdapterToken,
  type AdapterTokenPersistence,
  type AdapterTokenRecord,
  type ConsumerAppEligibility,
  type ConsumerAppEligibilityReader,
  type NewAdapterTokenRecord,
} from "./adapter-token.js";
import { verifySecret } from "./hashing.js";

/**
 * Unit coverage for the {@link AdapterTokenStore} over an in-memory persistence
 * fake and a controllable clock: issuance stores a hash and never the raw token,
 * validation is hash-equality, rotation keeps both tokens valid within the overlap
 * window and drops the previous one on cutover/elapse, and an ineligible (disabled /
 * provider-only) app is rejected. No database is involved.
 */

const OVERLAP_MS = 60_000;

/** A mutable in-memory row — the fake mirrors the real Postgres persistence semantics. */
interface FakeRow {
  credentialId: string;
  appId: string;
  hashedSecret: string;
  lastRotatedAt: Date;
  validUntil: Date | undefined;
}

class FakeAdapterTokenPersistence implements AdapterTokenPersistence {
  public readonly rows = new Map<string, FakeRow>();

  public create(record: NewAdapterTokenRecord): Promise<void> {
    this.rows.set(record.credentialId, {
      credentialId: record.credentialId,
      appId: record.appId,
      hashedSecret: record.hashedSecret,
      lastRotatedAt: record.lastRotatedAt,
      validUntil: record.validUntil,
    });
    return Promise.resolve();
  }

  public findById(credentialId: string): Promise<AdapterTokenRecord | null> {
    const row = this.rows.get(credentialId);
    return Promise.resolve(row === undefined ? null : toRecord(row));
  }

  public listByAppId(appId: string): Promise<readonly AdapterTokenRecord[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => row.appId === appId).map(toRecord),
    );
  }

  public setValidUntil(credentialId: string, validUntil: Date): Promise<void> {
    const row = this.rows.get(credentialId);
    if (row !== undefined) {
      row.validUntil = validUntil;
    }
    return Promise.resolve();
  }

  public deleteByAppId(appId: string): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows) {
      if (row.appId === appId) {
        this.rows.delete(id);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

function toRecord(row: FakeRow): AdapterTokenRecord {
  return row.validUntil === undefined
    ? {
        credentialId: row.credentialId,
        appId: row.appId,
        hashedSecret: row.hashedSecret,
        lastRotatedAt: row.lastRotatedAt,
      }
    : {
        credentialId: row.credentialId,
        appId: row.appId,
        hashedSecret: row.hashedSecret,
        lastRotatedAt: row.lastRotatedAt,
        validUntil: row.validUntil,
      };
}

/** An eligibility reader whose verdict per app is set by the test. */
class FakeEligibility implements ConsumerAppEligibilityReader {
  public readonly verdicts = new Map<string, ConsumerAppEligibility>();

  public check(appId: string): Promise<ConsumerAppEligibility> {
    return Promise.resolve(this.verdicts.get(appId) ?? { kind: "eligible" });
  }
}

interface Harness {
  readonly store: AdapterTokenStore;
  readonly persistence: FakeAdapterTokenPersistence;
  readonly eligibility: FakeEligibility;
  setNow(value: Date): void;
}

function makeHarness(): Harness {
  const persistence = new FakeAdapterTokenPersistence();
  const eligibility = new FakeEligibility();
  let clock = new Date("2026-07-21T00:00:00.000Z");
  let counter = 0;
  const store = new AdapterTokenStore(persistence, eligibility, {
    rotationOverlapMs: OVERLAP_MS,
    now: () => clock,
    // Deterministic, but still UUID-shaped so the token format parses.
    newCredentialId: () => {
      counter += 1;
      const suffix = counter.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${suffix}`;
    },
  });
  return {
    store,
    persistence,
    eligibility,
    setNow: (value): void => {
      clock = value;
    },
  };
}

describe("AdapterTokenStore.issue", () => {
  it("stores only a salted hash and returns the raw token exactly once (AT-1.1)", async () => {
    const { store, persistence } = makeHarness();

    const result = await store.issue("app-1");
    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") {
      return;
    }

    const parsed = parseAdapterToken(result.token.rawToken);
    expect(parsed).not.toBeNull();
    expect(parsed?.credentialId).toBe(result.token.credentialId);

    const row = persistence.rows.get(result.token.credentialId);
    expect(row).toBeDefined();
    // The stored payload is a salted hash, NOT the raw token or its secret part.
    expect(row?.hashedSecret).not.toContain(parsed?.secret ?? "");
    expect(row?.hashedSecret).not.toContain(result.token.rawToken);
    expect(row?.hashedSecret.startsWith("scrypt$")).toBe(true);
    // The hash verifies against the secret part (equality validation).
    await expect(verifySecret(parsed?.secret ?? "", row?.hashedSecret ?? "")).resolves.toBe(true);
    // First issuance is not a rotation.
    expect(result.rotated).toBe(false);
  });

  it("rejects issuance for an app with no CONSUMER spec (AT-1.4)", async () => {
    const { store, eligibility } = makeHarness();
    eligibility.verdicts.set("provider-only", { kind: "not-consumer" });

    await expect(store.issue("provider-only")).resolves.toStrictEqual({
      outcome: "app-not-consumer",
    });
  });

  it("rejects issuance for an unknown or disabled app", async () => {
    const { store, eligibility } = makeHarness();
    eligibility.verdicts.set("ghost", { kind: "not-found" });
    eligibility.verdicts.set("off", { kind: "not-active" });

    await expect(store.issue("ghost")).resolves.toStrictEqual({ outcome: "app-not-found" });
    await expect(store.issue("off")).resolves.toStrictEqual({ outcome: "app-not-active" });
  });
});

describe("AdapterTokenStore.validate", () => {
  it("resolves a valid token to its consumer app + credential id (AT-2/AT-3)", async () => {
    const { store } = makeHarness();
    const issued = await store.issue("app-1");
    if (issued.outcome !== "issued") {
      throw new Error("issue failed");
    }

    await expect(store.validate(issued.token.rawToken)).resolves.toStrictEqual({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: issued.token.credentialId,
    });
  });

  it("rejects a wrong secret of the same length (hash equality, not ===)", async () => {
    const { store } = makeHarness();
    const issued = await store.issue("app-1");
    if (issued.outcome !== "issued") {
      throw new Error("issue failed");
    }
    const parsed = parseAdapterToken(issued.token.rawToken);
    // A different 64-hex secret for the SAME credential id — equal length, so the
    // rejection comes from the constant-time hash comparison, never a length check.
    const forged = formatAdapterToken(parsed?.credentialId ?? "", generateAdapterTokenSecret());
    expect(forged.length).toBe(issued.token.rawToken.length);

    await expect(store.validate(forged)).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "secret-mismatch",
    });
  });

  it("rejects a malformed or unknown token before any app lookup", async () => {
    const { store } = makeHarness();

    await expect(store.validate("not-a-token")).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "malformed",
    });
    // Well-formed shape, but no such credential.
    const unknown = formatAdapterToken(
      "00000000-0000-4000-8000-ffffffffffff",
      generateAdapterTokenSecret(),
    );
    await expect(store.validate(unknown)).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "unknown",
    });
  });

  it("rejects a valid token whose app has been disabled (AT-4.4)", async () => {
    const { store, eligibility } = makeHarness();
    const issued = await store.issue("app-1");
    if (issued.outcome !== "issued") {
      throw new Error("issue failed");
    }
    // The app is later disabled — revocation is implicit in status.
    eligibility.verdicts.set("app-1", { kind: "not-active" });

    await expect(store.validate(issued.token.rawToken)).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "app-ineligible",
    });
  });
});

describe("AdapterTokenStore rotation overlap (AT-4)", () => {
  it("keeps both tokens valid within the window, then only the new one after cutover", async () => {
    const { store } = makeHarness();
    const first = await store.issue("app-1");
    if (first.outcome !== "issued") {
      throw new Error("issue failed");
    }

    const second = await store.rotate("app-1");
    if (second.outcome !== "issued") {
      throw new Error("rotate failed");
    }
    expect(second.rotated).toBe(true);
    expect(second.token.credentialId).not.toBe(first.token.credentialId);

    // Within the overlap window BOTH validate, each to the same app but its own id.
    await expect(store.validate(first.token.rawToken)).resolves.toStrictEqual({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: first.token.credentialId,
    });
    await expect(store.validate(second.token.rawToken)).resolves.toStrictEqual({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: second.token.credentialId,
    });

    // An explicit cutover ends the previous token immediately; the current stays.
    const cut = await store.cutover("app-1");
    expect(cut.outcome).toBe("cutover");
    if (cut.outcome === "cutover") {
      expect(cut.endedCredentialIds).toStrictEqual([first.token.credentialId]);
    }

    const afterFirst = await store.validate(first.token.rawToken);
    expect(afterFirst).toStrictEqual({ outcome: "rejected", reason: "expired" });
    const afterSecond = await store.validate(second.token.rawToken);
    expect(afterSecond).toStrictEqual({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: second.token.credentialId,
    });
  });

  it("drops the previous token once the overlap window elapses (no cutover needed)", async () => {
    const harness = makeHarness();
    const { store } = harness;
    const first = await store.issue("app-1");
    if (first.outcome !== "issued") {
      throw new Error("issue failed");
    }
    const second = await store.rotate("app-1");
    if (second.outcome !== "issued") {
      throw new Error("rotate failed");
    }

    // Advance past the overlap window (issued at the harness's fixed 00:00:00 clock):
    // the previous token expires on its own, no cutover needed.
    harness.setNow(new Date("2026-07-21T02:00:00.000Z"));
    await expect(store.validate(first.token.rawToken)).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "expired",
    });
    await expect(store.validate(second.token.rawToken)).resolves.toMatchObject({
      outcome: "resolved",
      consumerAppId: "app-1",
    });
  });

  it("cutover is a no-op when there is no overlap in progress", async () => {
    const { store } = makeHarness();
    await store.issue("app-1");
    await expect(store.cutover("app-1")).resolves.toStrictEqual({ outcome: "nothing-to-cutover" });
  });
});

describe("AdapterTokenStore.deleteForApp (deregister — AT-4.5)", () => {
  it("deletes every adapter-token credential for the app; its tokens stop validating", async () => {
    const { store, persistence } = makeHarness();
    const first = await store.issue("app-1");
    await store.rotate("app-1");
    if (first.outcome !== "issued") {
      throw new Error("issue failed");
    }

    const deleted = await store.deleteForApp("app-1");
    expect(deleted).toBe(2);
    expect([...persistence.rows.values()].filter((row) => row.appId === "app-1")).toHaveLength(0);

    await expect(store.validate(first.token.rawToken)).resolves.toStrictEqual({
      outcome: "rejected",
      reason: "unknown",
    });
  });
});
