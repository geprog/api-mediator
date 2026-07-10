import { randomUUID } from "node:crypto";

import {
  closeDb,
  createDb,
  EventOutboxRepository,
  ProcessedEventRepository,
  RegisteredAppRepository,
  resolveDatabaseUrl,
  runMigrations,
  tx,
  eventOutbox,
  processedEvent,
  registeredApp,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type { RegisteredApp } from "@mediator/domain";
import { eq, like, sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ConsumerRegistry, type EventConsumer } from "./consumer.js";
import { OutboxDispatcher } from "./dispatcher.js";
import { createSpecIngested, parseSpecIngested } from "./event.js";
import { PostgresEventBus } from "./event-bus.js";
import { ReconciliationSweep, type Reconciler } from "./reconciliation.js";

/**
 * Live-database integration test for `@mediator/event-bus`. Requires the compose
 * `postgres` service (`docker compose up -d postgres --wait`) and a resolvable
 * `DATABASE_URL`. Excluded from `pnpm verify`; run explicitly via
 * `pnpm --filter @mediator/event-bus test:integration`.
 *
 * It proves the Event Bus contract against a real Postgres + the `0004`
 * migration: transactional emit atomicity, at-least-once delivery, idempotent
 * redelivery, failure→retry, and that the reconciliation sweep runs.
 */

/**
 * A suite-owned table for a consumer's durable side effect. Not part of the
 * schema/migrations — created via raw DDL below — but described with a Drizzle
 * table object for typed, driver-agnostic access. One row per handler execution
 * (no unique constraint), so its row count is exactly how many times the effect
 * ran: dedup working ⇒ one row.
 */
const testEffect = pgTable("event_bus_test_effect", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: text("event_id").notNull(),
  consumerName: text("consumer_name").notNull(),
});

describe("Event Bus integration (requires Postgres)", () => {
  let db: Database;
  const bus = new PostgresEventBus();

  /** A consumer that validates the delivered event and writes a durable effect. */
  function effectConsumer(
    name: string,
    behavior: { failWhile?: () => boolean } = {},
  ): EventConsumer<DbTransaction> {
    return {
      name,
      handles: (type) => type === "SpecIngested",
      handle: async (event, txn) => {
        // Recover full typing from the type-agnostic delivered event.
        parseSpecIngested(event);
        if (behavior.failWhile?.() === true) {
          throw new Error("transient consumer failure");
        }
        await txn.insert(testEffect).values({ eventId: event.id, consumerName: name });
      },
    };
  }

  function dispatcherFor(consumer: EventConsumer<DbTransaction>): OutboxDispatcher<DbTransaction> {
    const registry = new ConsumerRegistry<DbTransaction>();
    registry.register(consumer);
    return new OutboxDispatcher<DbTransaction>(
      db,
      (txn) => new EventOutboxRepository(txn),
      (txn) => new ProcessedEventRepository(txn),
      registry,
      { maxAttempts: 3, batchSize: 10 },
    );
  }

  async function effectCount(eventId: string): Promise<number> {
    const rows = await db.select().from(testEffect).where(eq(testEffect.eventId, eventId));
    return rows.length;
  }

  async function ledgerCount(eventId: string): Promise<number> {
    const rows = await db.select().from(processedEvent).where(eq(processedEvent.eventId, eventId));
    return rows.length;
  }

  beforeAll(async () => {
    db = createDb(resolveDatabaseUrl(process.env));
    await runMigrations(db);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS event_bus_test_effect (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id text NOT NULL,
        consumer_name text NOT NULL
      )
    `);
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE event_outbox, processed_event, event_bus_test_effect`);
    await db.delete(registeredApp).where(like(registeredApp.name, "evtbus-test-%"));
  });

  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS event_bus_test_effect`);
    await closeDb(db);
  });

  it("applied the 0004 migration: event_outbox and processed_event are queryable", async () => {
    expect(await db.select().from(eventOutbox)).toStrictEqual([]);
    expect(await db.select().from(processedEvent)).toStrictEqual([]);
  });

  it("emits transactionally: a rolled-back producer tx leaves no outbox row", async () => {
    const event = createSpecIngested({ apiSpecId: "spec-r", appId: "app-r", role: "PROVIDER" });
    const app = testApp("evtbus-test-rollback");

    await expect(
      tx(db, async (txn) => {
        await new RegisteredAppRepository(txn).create(app);
        await bus.emit(event, txn);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    // Both the producer's write and the event rolled back together.
    expect(await new RegisteredAppRepository(db).getById(app.id)).toBeUndefined();
    expect(await new EventOutboxRepository(db).findByEventId(event.id)).toBeUndefined();
  });

  it("emits transactionally: a committed producer tx persists one unpublished row", async () => {
    const event = createSpecIngested({ apiSpecId: "spec-c", appId: "app-c", role: "PROVIDER" });
    const app = testApp("evtbus-test-commit");

    await tx(db, async (txn) => {
      await new RegisteredAppRepository(txn).create(app);
      await bus.emit(event, txn);
    });

    const row = await new EventOutboxRepository(db).findByEventId(event.id);
    expect(row).toBeDefined();
    expect(row?.type).toBe("SpecIngested");
    expect(row?.publishedAt).toBeNull();
    expect(row?.attempts).toBe(0);
    expect(row?.payload).toStrictEqual({ apiSpecId: "spec-c", appId: "app-c", role: "PROVIDER" });
  });

  it("re-emitting the same event id is a no-op (idempotent emit)", async () => {
    const event = createSpecIngested({ apiSpecId: "spec-d", appId: "app-d", role: "PROVIDER" });
    await tx(db, (txn) => bus.emit(event, txn));
    await tx(db, (txn) => bus.emit(event, txn));

    const rows = await db.select().from(eventOutbox).where(eq(eventOutbox.eventId, event.id));
    expect(rows).toHaveLength(1);
  });

  it("delivers a SpecIngested to a consumer exactly once, and redelivery stays idempotent", async () => {
    const event = createSpecIngested({ apiSpecId: "spec-1", appId: "app-1", role: "PROVIDER" });
    await tx(db, (txn) => bus.emit(event, txn));
    const dispatcher = dispatcherFor(effectConsumer("evtbus-test-consumer"));

    const first = await dispatcher.runOnce();
    expect(first).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await effectCount(event.id)).toBe(1);
    expect(await ledgerCount(event.id)).toBe(1);
    expect(
      (await new EventOutboxRepository(db).findByEventId(event.id))?.publishedAt,
    ).not.toBeNull();

    // Simulate an at-least-once redelivery: force the row back to unpublished and
    // dispatch again. The ledger must make the consumer skip → effect runs once.
    await db
      .update(eventOutbox)
      .set({ publishedAt: null })
      .where(eq(eventOutbox.eventId, event.id));

    const second = await dispatcher.runOnce();
    expect(second).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    expect(await effectCount(event.id)).toBe(1);
    expect(await ledgerCount(event.id)).toBe(1);
  });

  it("a failing consumer parks the row for retry (attempts++, last_error); a later run publishes it", async () => {
    const event = createSpecIngested({ apiSpecId: "spec-f", appId: "app-f", role: "PROVIDER" });
    await tx(db, (txn) => bus.emit(event, txn));
    let shouldFail = true;
    const dispatcher = dispatcherFor(
      effectConsumer("evtbus-test-flaky", { failWhile: () => shouldFail }),
    );

    const failedRun = await dispatcher.runOnce();
    expect(failedRun).toStrictEqual({ claimed: 1, published: 0, failed: 1 });
    const afterFailure = await new EventOutboxRepository(db).findByEventId(event.id);
    expect(afterFailure?.publishedAt).toBeNull();
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.lastError).toBe("transient consumer failure");
    expect(await effectCount(event.id)).toBe(0);
    expect(await ledgerCount(event.id)).toBe(0);

    shouldFail = false;
    const okRun = await dispatcher.runOnce();
    expect(okRun).toStrictEqual({ claimed: 1, published: 1, failed: 0 });
    const afterSuccess = await new EventOutboxRepository(db).findByEventId(event.id);
    expect(afterSuccess?.publishedAt).not.toBeNull();
    expect(afterSuccess?.attempts).toBe(1);
    expect(await effectCount(event.id)).toBe(1);
    expect(await ledgerCount(event.id)).toBe(1);
  });

  it("runSweep executes a registered reconciler", async () => {
    const ran: string[] = [];
    const reconciler: Reconciler = {
      name: "evtbus-test-reconciler",
      reconcile: () => {
        ran.push("ran");
        return Promise.resolve();
      },
    };
    const sweep = new ReconciliationSweep();
    sweep.register(reconciler);

    const result = await sweep.runSweep();

    expect(ran).toStrictEqual(["ran"]);
    expect(result.outcomes).toStrictEqual([{ name: "evtbus-test-reconciler", status: "ok" }]);
  });
});

function testApp(name: string): RegisteredApp {
  return {
    id: randomUUID(),
    name,
    status: "active",
    baseUrl: "https://example.test",
    capabilities: {
      supportsPolling: true,
      supportsDeltaQuery: false,
      supportsChangeTimestamps: true,
      defaultPollInterval: 60000,
    },
    createdAt: new Date("2026-07-10T00:00:00.000Z"),
  };
}
