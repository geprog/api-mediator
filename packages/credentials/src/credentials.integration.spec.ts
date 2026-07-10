import { randomUUID } from "node:crypto";

import {
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

import { DbCredentialPersistence } from "./db-persistence.js";
import { EnvKeyProvider } from "./key-provider.js";
import { CredentialStore } from "./store.js";

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
