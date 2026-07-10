import type { CredentialMetadata } from "@mediator/db";
import type { Credential } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { openEnvelope, sealEnvelope } from "./envelope.js";
import { EnvKeyProvider } from "./key-provider.js";
import {
  UnsupportedCredentialTypeError,
  type CredentialMaterial,
  type CredentialSecret,
} from "./material.js";
import {
  CredentialStore,
  type CredentialPersistence,
  type CredentialStoreLogger,
  type DecryptedCredential,
  type StoredEnvelope,
} from "./store.js";

const KEY = Buffer.alloc(32, 9);

function keyProvider(): EnvKeyProvider {
  return new EnvKeyProvider(KEY);
}

/** In-memory {@link CredentialPersistence} capturing what the store writes. */
class FakePersistence implements CredentialPersistence {
  public readonly created: Credential[] = [];
  public stored: StoredEnvelope | null = null;

  public create(credential: Credential): Promise<CredentialMetadata> {
    this.created.push(credential);
    return Promise.resolve({
      id: credential.id,
      type: credential.type,
      scopes: credential.scopes,
      lastRotatedAt: credential.lastRotatedAt,
    });
  }

  public loadEnvelope(): Promise<StoredEnvelope | null> {
    return Promise.resolve(this.stored);
  }
}

class CapturingLogger implements CredentialStoreLogger {
  public readonly lines: string[] = [];

  public info(message: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    this.lines.push(`${message} ${JSON.stringify(fields)}`);
  }
}

function only<T>(items: readonly T[]): T {
  const [first, ...rest] = items;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one item, got ${String(items.length)}`);
  }
  return first;
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

describe("CredentialStore.withCredential", () => {
  it("hands the callback the exact decrypted secret and returns only fn's value", async () => {
    const persistence = new FakePersistence();
    const store = new CredentialStore(persistence, keyProvider());
    const secret: CredentialSecret = {
      type: "oauth2",
      accessToken: "access-tok-abc",
      refreshToken: "refresh-tok-xyz",
    };
    persistence.stored = {
      credentialId: "cred-9",
      type: "oauth2",
      scopes: ["read"],
      encryptedPayload: sealSecret(secret),
    };

    const received: DecryptedCredential[] = [];
    const result = await store.withCredential("app-1", (cred) => {
      received.push(cred);
      return Promise.resolve("outbound-call-response");
    });

    expect(result).toStrictEqual({ outcome: "invoked", value: "outbound-call-response" });
    const captured = only(received);
    expect(captured.secret).toStrictEqual(secret);
    expect(captured.type).toBe("oauth2");
    expect(captured.scopes).toStrictEqual(["read"]);
    // The secret never leaks into the returned result.
    expect(JSON.stringify(result)).not.toContain("access-tok-abc");
  });

  it("returns no-credential without calling fn when the app has none", async () => {
    const persistence = new FakePersistence();
    const store = new CredentialStore(persistence, keyProvider());
    persistence.stored = null;

    let called = false;
    const result = await store.withCredential("public-app", () => {
      called = true;
      return Promise.resolve(1);
    });

    expect(result).toStrictEqual({ outcome: "no-credential" });
    expect(called).toBe(false);
  });
});

describe("CredentialStore logging guard", () => {
  it("never writes plaintext secret or master key to the logger", async () => {
    const persistence = new FakePersistence();
    const logger = new CapturingLogger();
    const store = new CredentialStore(persistence, keyProvider(), logger);
    const secret: CredentialSecret = { type: "apiKey", apiKey: "TOP-SECRET-material-000" };

    await store.store("app-log", { secret, scopes: ["s1"] });
    persistence.stored = {
      credentialId: "cred-log",
      type: "apiKey",
      scopes: ["s1"],
      encryptedPayload: sealSecret(secret),
    };
    await store.withCredential("app-log", () => Promise.resolve("ok"));

    const captured = logger.lines.join("\n");
    // The guard is meaningful only if the store actually logged something.
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(captured).not.toContain("TOP-SECRET-material-000");
    expect(captured).not.toContain(KEY.toString("base64"));
    expect(captured).not.toContain(KEY.toString("hex"));
  });
});
