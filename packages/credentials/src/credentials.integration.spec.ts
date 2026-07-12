import { randomUUID } from "node:crypto";

import {
  auditLog,
  closeDb,
  createDb,
  credential,
  CredentialRepository,
  registeredApp,
  RegisteredAppRepository,
  resolveDatabaseUrl,
  runMigrations,
  type Database,
} from "@mediator/db";
import type { RegisteredApp } from "@mediator/domain";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { DbCredentialAccessAuditor, DbCredentialPersistence } from "./db-persistence.js";
import { openEnvelope } from "./envelope.js";
import { EnvKeyProvider } from "./key-provider.js";
import { CredentialStore, type OAuth2Refresher } from "./store.js";

/**
 * Live-database integration test for the Credential Store. Requires the compose
 * `postgres` service (`docker compose up -d postgres --wait`) and a resolvable
 * `DATABASE_URL`. Excluded from `pnpm verify`; run explicitly via
 * `pnpm --filter @mediator/credentials test:integration`.
 *
 * It proves the end-to-end security contract against real Postgres: `store`
 * writes ciphertext at rest (the DB `encrypted_payload` never contains the
 * plaintext secret), `withCredential` decrypts it back to the exact original,
 * the metadata read returns no payload, and the `last_rotated_at NOT NULL`
 * migration applied to the freshly-migrated schema.
 */
describe("Credential Store integration (requires Postgres)", () => {
  let db: Database;
  let store: CredentialStore;

  const appId = randomUUID();
  const masterKey = Buffer.alloc(32, 3);
  const apiKeySecret = `integration-secret-${randomUUID()}`;

  const app: RegisteredApp = {
    id: appId,
    name: "Credential Integration App",
    status: "active",
    baseUrl: "https://app.example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: false,
      defaultPollInterval: 60000,
    },
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
  };

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await new RegisteredAppRepository(db).create(app);
    store = new CredentialStore(new DbCredentialPersistence(db), new EnvKeyProvider(masterKey));
  });

  afterAll(async () => {
    await db.delete(credential).where(eq(credential.appId, appId));
    await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    await closeDb(db);
  });

  it("applied the last_rotated_at NOT NULL migration to the fresh schema", async () => {
    const result = await db.execute(
      sql`select is_nullable from information_schema.columns where table_name = 'credential' and column_name = 'last_rotated_at'`,
    );
    const rows = z.array(z.object({ is_nullable: z.string() })).parse(result.rows);
    expect(rows[0]?.is_nullable).toBe("NO");
  });

  it("stores ciphertext at rest, decrypts it back, and never returns the payload", async () => {
    const metadata = await store.store(appId, {
      secret: { type: "apiKey", apiKey: apiKeySecret },
      scopes: ["repo:read"],
    });

    // Metadata carries no payload.
    expect(metadata).not.toHaveProperty("encryptedPayload");
    expect(metadata.type).toBe("apiKey");
    expect(metadata.lastRotatedAt).toBeInstanceOf(Date);

    // Ciphertext at rest: the raw column does not contain the plaintext secret.
    const [row] = await db
      .select({ payload: credential.encryptedPayload })
      .from(credential)
      .where(eq(credential.id, metadata.id));
    expect(row?.payload).toBeDefined();
    expect(row?.payload).not.toContain(apiKeySecret);

    // Decrypt round-trip through the store's internal accessor.
    const result = await store.withCredential(appId, (cred) => Promise.resolve(cred.secret));
    expect(result).toStrictEqual({
      outcome: "invoked",
      value: { type: "apiKey", apiKey: apiKeySecret },
    });

    // The metadata read surface returns no payload.
    const listed = await new CredentialRepository(db).listByAppId(appId);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0] ?? {})).not.toContain("encryptedPayload");
  });

  it("returns no-credential for an app that has none", async () => {
    const otherAppId = randomUUID();
    const result = await store.withCredential(otherAppId, () => Promise.resolve("unused"));
    expect(result).toStrictEqual({ outcome: "no-credential" });
  });
});

/**
 * Phase-4 credential decrypt-for-call, against real Postgres: the two DB writes
 * the store introduces — persisting re-encrypted OAuth2 tokens (CD-2) and the
 * `credential-access` audit entry (CD-3) — proven end-to-end, not just against a
 * fake. A separate suite so it owns its own app/credential/audit rows and cleanup.
 */
describe("Credential Store Phase-4 decrypt-for-call integration (requires Postgres)", () => {
  let db: Database;
  const masterKey = Buffer.alloc(32, 7);
  const createdAppIds: string[] = [];

  function registeredAppRow(id: string): RegisteredApp {
    return {
      id,
      name: "Phase-4 Credential App",
      status: "active",
      baseUrl: "https://app.example.test",
      capabilities: {
        supportsPolling: true,
        supportsDeltaQuery: false,
        supportsChangeTimestamps: false,
        defaultPollInterval: 60000,
      },
      createdAt: new Date("2026-07-10T00:00:00.000Z"),
    };
  }

  async function seedApp(): Promise<string> {
    const appId = randomUUID();
    await new RegisteredAppRepository(db).create(registeredAppRow(appId));
    createdAppIds.push(appId);
    return appId;
  }

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
  });

  afterAll(async () => {
    for (const appId of createdAppIds) {
      await db.delete(auditLog).where(eq(auditLog.originAppId, appId));
      await db.delete(credential).where(eq(credential.appId, appId));
      await db.delete(registeredApp).where(eq(registeredApp.id, appId));
    }
    await closeDb(db);
  });

  it("refreshes an expired oauth2 token and persists re-encrypted tokens, preserving lastRotatedAt (CD-2)", async () => {
    const appId = await seedApp();
    const keyProvider = new EnvKeyProvider(masterKey);
    const writer = new CredentialStore(new DbCredentialPersistence(db), keyProvider);
    const metadata = await writer.store(appId, {
      secret: {
        type: "oauth2",
        accessToken: "old-access-integration",
        refreshToken: "refresh-old-integration",
        expiresAt: "2000-01-01T00:00:00.000Z", // long expired
      },
      scopes: ["read"],
    });

    const refresher: OAuth2Refresher = {
      refresh: () =>
        Promise.resolve({
          accessToken: "new-access-integration",
          refreshToken: "refresh-rotated-integration",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        }),
    };
    const store = new CredentialStore(new DbCredentialPersistence(db), keyProvider, undefined, {
      oauth2Refresher: refresher,
    });

    const result = await store.withCredential(appId, (cred) => Promise.resolve(cred.secret));
    // fn received the fresh access token and no refresh token.
    expect(result).toStrictEqual({
      outcome: "invoked",
      value: { type: "oauth2", accessToken: "new-access-integration" },
    });

    // The DB row now holds the re-encrypted updated tokens (ciphertext, not plaintext).
    const [row] = await db
      .select({ payload: credential.encryptedPayload, lastRotatedAt: credential.lastRotatedAt })
      .from(credential)
      .where(eq(credential.id, metadata.id));
    expect(row?.payload).toBeDefined();
    expect(row?.payload).not.toContain("new-access-integration");
    expect(row?.payload).not.toContain("refresh-rotated-integration");
    const recovered: unknown = JSON.parse(
      openEnvelope(row?.payload ?? "", masterKey).toString("utf8"),
    );
    expect(recovered).toStrictEqual({
      type: "oauth2",
      accessToken: "new-access-integration",
      refreshToken: "refresh-rotated-integration",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    // lastRotatedAt is preserved across an automatic refresh (not an operator rotation).
    expect(row?.lastRotatedAt).toStrictEqual(metadata.lastRotatedAt);
  });

  it("writes a metadata-only credential-access audit row referencing the credential + trace (CD-3)", async () => {
    const appId = await seedApp();
    const keyProvider = new EnvKeyProvider(masterKey);
    const secret = `audit-secret-${randomUUID()}`;
    const store = new CredentialStore(new DbCredentialPersistence(db), keyProvider, undefined, {
      auditor: new DbCredentialAccessAuditor(db),
      readTraceContext: () => ({ traceId: "trace-int-1", spanId: "span-int-1" }),
    });
    const metadata = await store.store(appId, { secret: { type: "apiKey", apiKey: secret } });

    await store.withCredential(appId, () => Promise.resolve("ok"));

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.relatedCredentialId, metadata.id));
    expect(rows).toHaveLength(1);
    const entry = rows[0];
    expect(entry?.type).toBe("credential-access");
    expect(entry?.originAppId).toBe(appId);
    expect(entry?.actor).toBe("system");
    expect(entry?.details).toBe("credential accessed");
    expect(entry?.traceId).toBe("trace-int-1");
    expect(entry?.spanId).toBe("span-int-1");
    // No secret material in any audit column.
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("writes a distinguishable no-credential audit row for a public app (CD-3 crit 3)", async () => {
    const appId = await seedApp();
    const store = new CredentialStore(
      new DbCredentialPersistence(db),
      new EnvKeyProvider(masterKey),
      undefined,
      { auditor: new DbCredentialAccessAuditor(db) },
    );

    await store.withCredential(appId, () => Promise.resolve("ok"));

    const rows = await db.select().from(auditLog).where(eq(auditLog.originAppId, appId));
    expect(rows).toHaveLength(1);
    const entry = rows[0];
    expect(entry?.type).toBe("credential-access");
    expect(entry?.details).toBe("no credential used");
    expect(entry?.relatedCredentialId).toBeNull();
  });
});
