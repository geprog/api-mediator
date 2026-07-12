import type { CredentialMetadata } from "@mediator/db";
import type { AuditLogEntry, Credential } from "@mediator/domain";
import { describe, expect, it, vi } from "vitest";

import * as envelopeModule from "./envelope.js";
import { openEnvelope, sealEnvelope } from "./envelope.js";
import { EnvKeyProvider } from "./key-provider.js";
import {
  UnsupportedCredentialTypeError,
  type CredentialMaterial,
  type CredentialSecret,
} from "./material.js";
import {
  CredentialStore,
  type CredentialAccessAuditor,
  type CredentialPersistence,
  type CredentialStoreLogger,
  type CredentialStoreOptions,
  type DecryptedCredential,
  type OAuth2RefreshRequest,
  type OAuth2Refresher,
  type OAuth2RefreshedTokens,
  type StoredEnvelope,
} from "./store.js";

const KEY = Buffer.alloc(32, 9);

function keyProvider(): EnvKeyProvider {
  return new EnvKeyProvider(KEY);
}

/** In-memory {@link CredentialPersistence}: per-app envelopes + captured writes. */
class FakePersistence implements CredentialPersistence {
  public readonly created: Credential[] = [];
  public readonly loadCalls: string[] = [];
  public readonly updates: { credentialId: string; encryptedPayload: string }[] = [];
  readonly #byAppId = new Map<string, StoredEnvelope>();

  public set(appId: string, envelope: StoredEnvelope): void {
    this.#byAppId.set(appId, envelope);
  }

  public get(appId: string): StoredEnvelope | undefined {
    return this.#byAppId.get(appId);
  }

  public create(credential: Credential): Promise<CredentialMetadata> {
    this.created.push(credential);
    return Promise.resolve({
      id: credential.id,
      type: credential.type,
      scopes: credential.scopes,
      lastRotatedAt: credential.lastRotatedAt,
    });
  }

  public loadEnvelope(appId: string): Promise<StoredEnvelope | null> {
    this.loadCalls.push(appId);
    return Promise.resolve(this.#byAppId.get(appId) ?? null);
  }

  public updateEnvelope(credentialId: string, encryptedPayload: string): Promise<void> {
    this.updates.push({ credentialId, encryptedPayload });
    for (const [appId, env] of this.#byAppId) {
      if (env.credentialId === credentialId) {
        this.#byAppId.set(appId, { ...env, encryptedPayload });
      }
    }
    return Promise.resolve();
  }
}

class CapturingLogger implements CredentialStoreLogger {
  public readonly lines: string[] = [];

  public info(message: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    this.lines.push(`${message} ${JSON.stringify(fields)}`);
  }
}

/** Captures the metadata-only `credential-access` entries the store records (CD-3). */
class RecordingAuditor implements CredentialAccessAuditor {
  public readonly entries: AuditLogEntry[] = [];

  public record(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** A stub {@link OAuth2Refresher}: records calls; returns tokens or throws. */
class FakeRefresher implements OAuth2Refresher {
  public readonly calls: OAuth2RefreshRequest[] = [];

  public constructor(private readonly result: OAuth2RefreshedTokens | Error) {}

  public refresh(request: OAuth2RefreshRequest): Promise<OAuth2RefreshedTokens> {
    this.calls.push(request);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one item, got ${String(items.length)}`);
  }
  return first;
}

/** A store with the Phase-4 seams but a silent logger (drops the default noop). */
function storeWith(
  persistence: FakePersistence,
  options?: CredentialStoreOptions,
): CredentialStore {
  return new CredentialStore(persistence, keyProvider(), undefined, options);
}

/**
 * Simulates credential material reaching `store` from the untrusted API
 * boundary (where the compile-time discriminated union does not apply), so the
 * store's own runtime validation can be exercised — e.g. an `adapterToken` type.
 */
function untrusted(value: {
  secret: Record<string, unknown>;
  scopes?: readonly string[];
}): CredentialMaterial {
  return value as unknown as CredentialMaterial;
}

function sealSecret(secret: CredentialSecret): string {
  return sealEnvelope(Buffer.from(JSON.stringify(secret), "utf8"), KEY);
}

describe("CredentialStore.store", () => {
  it("returns metadata only — no payload field ever", async () => {
    const persistence = new FakePersistence();
    const store = new CredentialStore(persistence, keyProvider());

    const metadata = await store.store("app-1", {
      secret: { type: "apiKey", apiKey: "secret-key" },
      scopes: ["repo:read"],
    });

    expect(Object.keys(metadata).sort()).toStrictEqual(["id", "lastRotatedAt", "scopes", "type"]);
    expect(metadata).not.toHaveProperty("encryptedPayload");
    expect(metadata.type).toBe("apiKey");
    expect(metadata.scopes).toStrictEqual(["repo:read"]);
    expect(metadata.lastRotatedAt).toBeInstanceOf(Date);
  });

  it("persists an envelope (ciphertext), not the plaintext secret", async () => {
    const persistence = new FakePersistence();
    const store = new CredentialStore(persistence, keyProvider());
    const apiKey = "plaintext-should-not-be-stored";

    await store.store("app-1", { secret: { type: "apiKey", apiKey } });

    const persisted = only(persistence.created);
    // The value handed to the repo is ciphertext, not the plaintext.
    expect(persisted.encryptedPayload).not.toContain(apiKey);
    expect(persisted.type).toBe("apiKey");
    expect(persisted.lastRotatedAt).toBeInstanceOf(Date);
    // ...and it is a real, reversible envelope under the master key.
    const recovered = openEnvelope(persisted.encryptedPayload, KEY);
    expect(JSON.parse(recovered.toString("utf8"))).toStrictEqual({ type: "apiKey", apiKey });
  });

  it("rejects adapterToken through the store path (CR-1)", async () => {
    const persistence = new FakePersistence();
    const store = new CredentialStore(persistence, keyProvider());

    await expect(
      store.store("app-1", untrusted({ secret: { type: "adapterToken", apiKey: "k" } })),
    ).rejects.toBeInstanceOf(UnsupportedCredentialTypeError);
    // Nothing was persisted for a rejected type.
    expect(persistence.created).toHaveLength(0);
  });
});

describe("CredentialStore.withCredential — CD-1 decrypt-for-call", () => {
  it("hands fn the decrypted secret and returns only fn's value (no secret in return)", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);
    const secret: CredentialSecret = { type: "apiKey", apiKey: "api-key-abc" };
    persistence.set("app-1", {
      credentialId: "cred-9",
      type: "apiKey",
      scopes: ["read"],
      encryptedPayload: sealSecret(secret),
    });

    const received: DecryptedCredential[] = [];
    const result = await store.withCredential("app-1", (cred) => {
      received.push(cred);
      return Promise.resolve("outbound-call-response");
    });

    expect(result).toStrictEqual({ outcome: "invoked", value: "outbound-call-response" });
    const captured = only(received);
    expect(captured.secret).toStrictEqual(secret);
    expect(captured.type).toBe("apiKey");
    expect(captured.scopes).toStrictEqual(["read"]);
    // The secret never leaks into the returned result.
    expect(JSON.stringify(result)).not.toContain("api-key-abc");
  });

  it("hands an oauth2 caller only the access token — never the refresh token (CD-2 crit 1)", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);
    const secret: CredentialSecret = {
      type: "oauth2",
      accessToken: "access-tok-abc",
      refreshToken: "refresh-tok-xyz",
    };
    persistence.set("app-1", {
      credentialId: "cred-o",
      type: "oauth2",
      scopes: ["read"],
      encryptedPayload: sealSecret(secret),
    });

    const received: DecryptedCredential[] = [];
    await store.withCredential("app-1", (cred) => {
      received.push(cred);
      return Promise.resolve("ok");
    });

    const captured = only(received);
    expect(captured.secret).toStrictEqual({ type: "oauth2", accessToken: "access-tok-abc" });
    expect(captured.secret).not.toHaveProperty("refreshToken");
    // The refresh token never reached the callback in any form.
    expect(JSON.stringify(captured.secret)).not.toContain("refresh-tok-xyz");
  });

  it("returns no-credential without calling fn when the app has none (CD-1 crit 4)", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);

    let called = false;
    const result = await store.withCredential("public-app", () => {
      called = true;
      return Promise.resolve(1);
    });

    expect(result).toStrictEqual({ outcome: "no-credential" });
    expect(called).toBe(false);
  });

  it("zeroes the decrypted plaintext buffer after the scope (CD-1 crit 2 — no retention)", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);
    const secret: CredentialSecret = { type: "apiKey", apiKey: "zero-me-after-scope" };
    persistence.set("app-1", {
      credentialId: "cred-z",
      type: "apiKey",
      scopes: [],
      encryptedPayload: sealSecret(secret),
    });

    const spy = vi.spyOn(envelopeModule, "openEnvelope");
    let plaintextVisibleDuringCall = false;
    await store.withCredential("app-1", (cred) => {
      // During the call the decrypted buffer still holds the plaintext.
      const res = spy.mock.results[0];
      if (res?.type === "return") {
        plaintextVisibleDuringCall = res.value.includes(Buffer.from("zero-me-after-scope"));
      }
      return Promise.resolve(cred.secret.type);
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(plaintextVisibleDuringCall).toBe(true);
    const res = spy.mock.results[0];
    expect(res?.type).toBe("return");
    if (res?.type !== "return") throw new Error("expected openEnvelope to return");
    // After the scope every byte of the decrypted buffer is zeroed: the plaintext
    // does not survive the call.
    expect(res.value.every((b) => b === 0)).toBe(true);
    spy.mockRestore();
  });

  it("fetches the credential for exactly the one app, with no cross-app cache (CD-1 crit 5)", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);
    persistence.set("app-a", {
      credentialId: "cred-a",
      type: "apiKey",
      scopes: [],
      encryptedPayload: sealSecret({ type: "apiKey", apiKey: "key-a" }),
    });
    persistence.set("app-b", {
      credentialId: "cred-b",
      type: "apiKey",
      scopes: [],
      encryptedPayload: sealSecret({ type: "apiKey", apiKey: "key-b" }),
    });

    const seen: string[] = [];
    const capture = (cred: DecryptedCredential): Promise<string> => {
      seen.push(cred.secret.type === "apiKey" ? cred.secret.apiKey : "?");
      return Promise.resolve("ok");
    };
    await store.withCredential("app-a", capture);
    await store.withCredential("app-b", capture);

    // Each call loaded exactly its own app — never landscape-wide, never a cached
    // secret from the previous app.
    expect(persistence.loadCalls).toStrictEqual(["app-a", "app-b"]);
    expect(seen).toStrictEqual(["key-a", "key-b"]);
  });

  it("zeroes the plaintext even when fn throws", async () => {
    const persistence = new FakePersistence();
    const store = storeWith(persistence);
    persistence.set("app-1", {
      credentialId: "cred-t",
      type: "apiKey",
      scopes: [],
      encryptedPayload: sealSecret({ type: "apiKey", apiKey: "throw-secret" }),
    });

    const spy = vi.spyOn(envelopeModule, "openEnvelope");
    await expect(
      store.withCredential("app-1", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    const res = spy.mock.results[0];
    if (res?.type !== "return") throw new Error("expected openEnvelope to return");
    expect(res.value.every((b) => b === 0)).toBe(true);
    spy.mockRestore();
  });
});

describe("CredentialStore.withCredential — CD-2 OAuth2 refresh inside the store", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  function oauth2Store(
    persistence: FakePersistence,
    refresher: OAuth2Refresher | undefined,
  ): CredentialStore {
    return storeWith(
      persistence,
      refresher === undefined ? { now: () => now } : { now: () => now, oauth2Refresher: refresher },
    );
  }

  function setOauth2(persistence: FakePersistence, secret: CredentialSecret): void {
    persistence.set("app-o", {
      credentialId: "cred-o",
      type: "oauth2",
      scopes: ["read"],
      encryptedPayload: sealSecret(secret),
    });
  }

  it("refreshes an expired token internally and hands fn the new valid access token", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T11:00:00.000Z", // one hour in the past
    });
    const refresher = new FakeRefresher({
      accessToken: "new-access",
      refreshToken: "refresh-rotated",
      expiresAt: new Date("2026-07-11T13:00:00.000Z"),
    });
    const store = oauth2Store(persistence, refresher);

    const received: DecryptedCredential[] = [];
    const result = await store.withCredential("app-o", (cred) => {
      received.push(cred);
      return Promise.resolve("ok");
    });

    expect(result).toStrictEqual({ outcome: "invoked", value: "ok" });
    // The store exchanged the refresh token internally, scoped to this app.
    expect(only(refresher.calls)).toStrictEqual({
      appId: "app-o",
      refreshToken: "refresh-abc",
      scopes: ["read"],
    });
    // fn got the fresh access token and no refresh token.
    expect(only(received).secret).toStrictEqual({ type: "oauth2", accessToken: "new-access" });
  });

  it("re-envelope-encrypts and persists the refreshed tokens (never plaintext, CD-2 crit 3)", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T11:00:00.000Z",
    });
    const refresher = new FakeRefresher({
      accessToken: "new-access",
      refreshToken: "refresh-rotated",
      expiresAt: new Date("2026-07-11T13:00:00.000Z"),
    });
    const store = oauth2Store(persistence, refresher);

    await store.withCredential("app-o", () => Promise.resolve("ok"));

    const update = only(persistence.updates);
    expect(update.credentialId).toBe("cred-o");
    // Persisted as ciphertext, not plaintext tokens.
    expect(update.encryptedPayload).not.toContain("new-access");
    expect(update.encryptedPayload).not.toContain("refresh-rotated");
    // ...and it decrypts back to the full updated secret (rotated refresh + new expiry).
    const stored = persistence.get("app-o");
    expect(stored).toBeDefined();
    const recovered: unknown = JSON.parse(
      openEnvelope(stored?.encryptedPayload ?? "", KEY).toString("utf8"),
    );
    expect(recovered).toStrictEqual({
      type: "oauth2",
      accessToken: "new-access",
      refreshToken: "refresh-rotated",
      expiresAt: "2026-07-11T13:00:00.000Z",
    });
  });

  it("does not refresh a still-valid token (CD-2 crit 2)", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "still-valid",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T18:00:00.000Z", // hours in the future
    });
    const refresher = new FakeRefresher({ accessToken: "unused" });
    const store = oauth2Store(persistence, refresher);

    const received: DecryptedCredential[] = [];
    await store.withCredential("app-o", (cred) => {
      received.push(cred);
      return Promise.resolve("ok");
    });

    expect(refresher.calls).toHaveLength(0);
    expect(persistence.updates).toHaveLength(0);
    expect(only(received).secret).toStrictEqual({ type: "oauth2", accessToken: "still-valid" });
  });

  it("refreshes a token within the refresh threshold before it expires", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T12:00:30.000Z", // 30s ahead, inside the default 60s window
    });
    const refresher = new FakeRefresher({ accessToken: "new-access" });
    const store = oauth2Store(persistence, refresher);

    await store.withCredential("app-o", () => Promise.resolve("ok"));
    expect(refresher.calls).toHaveLength(1);
  });

  it("surfaces credential-refresh-failure and does not call fn when refresh fails (CD-2 crit 4)", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T11:00:00.000Z",
    });
    const refresher = new FakeRefresher(new Error("provider rejected: refresh-abc revoked"));
    const store = oauth2Store(persistence, refresher);

    let called = false;
    const result = await store.withCredential("app-o", () => {
      called = true;
      return Promise.resolve("ok");
    });

    expect(result.outcome).toBe("credential-refresh-failure");
    expect(called).toBe(false);
    // No stale token was persisted, and the provider error text (which could carry
    // token material) never leaks into the surfaced reason.
    expect(persistence.updates).toHaveLength(0);
    if (result.outcome === "credential-refresh-failure") {
      expect(result.reason).not.toContain("refresh-abc");
      expect(result.reason).not.toContain("revoked");
    }
  });

  it("fails the refresh when no refresher is configured (CD-2 crit 4)", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      refreshToken: "refresh-abc",
      expiresAt: "2026-07-11T11:00:00.000Z",
    });
    const store = oauth2Store(persistence, undefined);

    let called = false;
    const result = await store.withCredential("app-o", () => {
      called = true;
      return Promise.resolve("ok");
    });

    expect(result.outcome).toBe("credential-refresh-failure");
    expect(called).toBe(false);
  });

  it("fails the refresh when the credential has no stored refresh token", async () => {
    const persistence = new FakePersistence();
    setOauth2(persistence, {
      type: "oauth2",
      accessToken: "old-access",
      expiresAt: "2026-07-11T11:00:00.000Z",
    });
    const refresher = new FakeRefresher({ accessToken: "new-access" });
    const store = oauth2Store(persistence, refresher);

    const result = await store.withCredential("app-o", () => Promise.resolve("ok"));

    expect(result.outcome).toBe("credential-refresh-failure");
    expect(refresher.calls).toHaveLength(0);
  });

  it("does not exercise a refresh path for non-oauth2 types (CD-2 crit 5)", async () => {
    const persistence = new FakePersistence();
    persistence.set("app-basic", {
      credentialId: "cred-basic",
      type: "basicAuth",
      scopes: [],
      encryptedPayload: sealSecret({ type: "basicAuth", username: "u", password: "p" }),
    });
    const refresher = new FakeRefresher({ accessToken: "unused" });
    const store = storeWith(persistence, { oauth2Refresher: refresher });

    const received: DecryptedCredential[] = [];
    await store.withCredential("app-basic", (cred) => {
      received.push(cred);
      return Promise.resolve("ok");
    });

    expect(refresher.calls).toHaveLength(0);
    expect(only(received).secret).toStrictEqual({
      type: "basicAuth",
      username: "u",
      password: "p",
    });
  });
});

describe("CredentialStore.withCredential — CD-3 credential-access audit", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  const trace = { traceId: "trace-abc", spanId: "span-def" };

  it("records a metadata-only credential-access entry referencing the credential + app + trace", async () => {
    const persistence = new FakePersistence();
    const auditor = new RecordingAuditor();
    const store = storeWith(persistence, {
      auditor,
      now: () => now,
      readTraceContext: () => trace,
    });
    persistence.set("app-1", {
      credentialId: "cred-audit",
      type: "apiKey",
      scopes: [],
      encryptedPayload: sealSecret({ type: "apiKey", apiKey: "TOP-SECRET-000" }),
    });

    await store.withCredential("app-1", () => Promise.resolve("ok"));

    const entry = only(auditor.entries);
    expect(entry.type).toBe("credential-access");
    expect(entry.relatedCredentialId).toBe("cred-audit");
    expect(entry.originAppId).toBe("app-1");
    expect(entry.actor).toBe("system");
    expect(entry.details).toBe("credential accessed");
    expect(entry.traceId).toBe("trace-abc");
    expect(entry.spanId).toBe("span-def");
    expect(entry.timestamp).toStrictEqual(now);
    // No secret material anywhere in the entry.
    expect(JSON.stringify(entry)).not.toContain("TOP-SECRET-000");
  });

  it("notes an oauth2 refresh in the entry without any token values (CD-3 crit 2)", async () => {
    const persistence = new FakePersistence();
    const auditor = new RecordingAuditor();
    const store = storeWith(persistence, {
      auditor,
      now: () => now,
      oauth2Refresher: new FakeRefresher({
        accessToken: "new-access",
        refreshToken: "refresh-new",
      }),
    });
    persistence.set("app-o", {
      credentialId: "cred-o",
      type: "oauth2",
      scopes: [],
      encryptedPayload: sealSecret({
        type: "oauth2",
        accessToken: "old-access",
        refreshToken: "refresh-old",
        expiresAt: "2026-07-11T11:00:00.000Z",
      }),
    });

    await store.withCredential("app-o", () => Promise.resolve("ok"));

    const entry = only(auditor.entries);
    expect(entry.details).toBe("credential accessed (oauth2 access token refreshed)");
    const serialized = JSON.stringify(entry);
    for (const token of ["old-access", "new-access", "refresh-old", "refresh-new"]) {
      expect(serialized).not.toContain(token);
    }
  });

  it("records the no-credential case as distinguishable (no relatedCredentialId) (CD-3 crit 3)", async () => {
    const persistence = new FakePersistence();
    const auditor = new RecordingAuditor();
    const store = storeWith(persistence, { auditor, now: () => now });

    await store.withCredential("public-app", () => Promise.resolve("ok"));

    const entry = only(auditor.entries);
    expect(entry.type).toBe("credential-access");
    expect(entry.details).toBe("no credential used");
    expect(entry.originAppId).toBe("public-app");
    expect(entry).not.toHaveProperty("relatedCredentialId");
  });

  it("records no access entry when a refresh fails (deferred to OC-4)", async () => {
    const persistence = new FakePersistence();
    const auditor = new RecordingAuditor();
    const store = storeWith(persistence, {
      auditor,
      now: () => now,
      oauth2Refresher: new FakeRefresher(new Error("revoked")),
    });
    persistence.set("app-o", {
      credentialId: "cred-o",
      type: "oauth2",
      scopes: [],
      encryptedPayload: sealSecret({
        type: "oauth2",
        accessToken: "old-access",
        refreshToken: "refresh-old",
        expiresAt: "2026-07-11T11:00:00.000Z",
      }),
    });

    await store.withCredential("app-o", () => Promise.resolve("ok"));
    expect(auditor.entries).toHaveLength(0);
  });
});

describe("CredentialStore logging guard", () => {
  it("never writes plaintext secret or master key to the logger", async () => {
    const persistence = new FakePersistence();
    const logger = new CapturingLogger();
    const store = new CredentialStore(persistence, keyProvider(), logger);
    const secret: CredentialSecret = { type: "apiKey", apiKey: "TOP-SECRET-material-000" };

    await store.store("app-log", { secret, scopes: ["s1"] });
    persistence.set("app-log", {
      credentialId: "cred-log",
      type: "apiKey",
      scopes: ["s1"],
      encryptedPayload: sealSecret(secret),
    });
    await store.withCredential("app-log", () => Promise.resolve("ok"));

    const captured = logger.lines.join("\n");
    // The guard is meaningful only if the store actually logged something.
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(captured).not.toContain("TOP-SECRET-material-000");
    expect(captured).not.toContain(KEY.toString("base64"));
    expect(captured).not.toContain(KEY.toString("hex"));
  });
});
