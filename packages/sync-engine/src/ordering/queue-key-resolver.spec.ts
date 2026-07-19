import type { RecordLink } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { canonicalJson } from "../identity-resolution/hash.js";
import {
  QueueKeyResolver,
  type QueueKeyChange,
  type QueueKeyResolution,
} from "./queue-key-resolver.js";

/**
 * OQ-3 (and the keying half of OQ-2) — `QueueKeyResolver.resolve`: the cheap
 * pre-enqueue lookup that keys a change by its active `RecordLink` id, else its shared
 * identity-key value, else its native id
 * (`docs/requirements/phase-4-ordering-queue.md` OQ-2.1, OQ-3.1..3.4). The scope-qualified
 * SS-14 variant + the unresolved-container park live in `scoped-queue-key.spec.ts`.
 */

const RESOURCE_PAIR = "rp:users";
const APP_A = "app-a";
const APP_B = "app-b";
const CLOCK = new Date("2026-07-13T00:00:00.000Z");

function activeLink(overrides: Partial<RecordLink> = {}): RecordLink {
  return {
    id: "link-1",
    appAId: APP_A,
    appANativeId: "a1",
    appBId: APP_B,
    appBNativeId: "b1",
    resourcePairRef: RESOURCE_PAIR,
    establishedBy: "identity-match",
    status: "active",
    establishingQueueKey: { kind: "identity-value", value: "jane@example.test" },
    createdAt: CLOCK,
    tombstonedAt: null,
    ...overrides,
  };
}

function change(overrides: Partial<QueueKeyChange> = {}): QueueKeyChange {
  return {
    resourcePairRef: RESOURCE_PAIR,
    sourceAppId: APP_A,
    targetAppId: APP_B,
    sourceNativeId: "a1",
    ...overrides,
  };
}

/** Narrow a resolution to its enqueued key (the non-scoped cases never park). */
function queued(resolution: QueueKeyResolution): { queueKey: string; basis: string } {
  if (resolution.outcome !== "queue") {
    throw new Error(`expected an enqueued key, got ${resolution.outcome}`);
  }
  return { queueKey: resolution.queueKey, basis: resolution.basis };
}

describe("QueueKeyResolver", () => {
  describe("OQ-2.1 — a linked record keys by its RecordLink id (both directions → one queue)", () => {
    it("keys a linked change by the link id, from EITHER side of the pair", async () => {
      const links = new FakeRecordLinkStore();
      await links.insert(activeLink());
      const resolver = new QueueKeyResolver(links);

      // Direction A→B: source is app A's record a1.
      const forward = queued(
        await resolver.resolve(
          change({
            sourceAppId: APP_A,
            targetAppId: APP_B,
            sourceNativeId: "a1",
            observedRecord: { email: "jane@example.test" },
          }),
          { identitySourcePath: "email" },
        ),
      );
      // Direction B→A: source is app B's record b1 — the SAME shared link.
      const reverse = queued(
        await resolver.resolve(
          change({
            sourceAppId: APP_B,
            targetAppId: APP_A,
            sourceNativeId: "b1",
            observedRecord: { mail: "jane@example.test" },
          }),
          { identitySourcePath: "mail" },
        ),
      );

      expect(forward).toStrictEqual({ queueKey: "link-1", basis: "record-link" });
      // Both directions resolve to the SAME key — one queue over the shared state.
      expect(reverse.queueKey).toBe("link-1");
      expect(reverse.basis).toBe("record-link");
    });

    it("prefers the link id over an identity value even when one is observed", async () => {
      const links = new FakeRecordLinkStore();
      await links.insert(activeLink());
      const resolver = new QueueKeyResolver(links);

      const resolved = queued(
        await resolver.resolve(change({ observedRecord: { email: "jane@example.test" } }), {
          identitySourcePath: "email",
        }),
      );
      expect(resolved.basis).toBe("record-link");
      expect(resolved.queueKey).toBe("link-1");
    });
  });

  describe("OQ-3.1 — an unlinked record keys by its shared identity value", () => {
    it("keys by the observed identity value, the SAME string from either side", async () => {
      const links = new FakeRecordLinkStore(); // no links yet
      const resolver = new QueueKeyResolver(links);

      // A→B reads the identity value at path `email`; B→A reads it at a different path.
      const forward = queued(
        await resolver.resolve(
          change({
            sourceAppId: APP_A,
            targetAppId: APP_B,
            sourceNativeId: "a1",
            observedRecord: { email: "jane@example.test" },
          }),
          { identitySourcePath: "email" },
        ),
      );
      const reverse = queued(
        await resolver.resolve(
          change({
            sourceAppId: APP_B,
            targetAppId: APP_A,
            sourceNativeId: "b1",
            observedRecord: { profile: { mail: "jane@example.test" } },
          }),
          { identitySourcePath: "profile.mail" },
        ),
      );

      expect(forward).toStrictEqual({ queueKey: "jane@example.test", basis: "identity-value" });
      // Value-preserving, shared pairing → identical key from both directions.
      expect(reverse.queueKey).toBe("jane@example.test");
      expect(reverse.basis).toBe("identity-value");
    });

    it("stringifies a non-string identity value canonically (matches the stage's retained key)", async () => {
      const links = new FakeRecordLinkStore();
      const resolver = new QueueKeyResolver(links);

      const resolved = queued(
        await resolver.resolve(change({ observedRecord: { orderNo: 42 } }), {
          identitySourcePath: "orderNo",
        }),
      );
      expect(resolved.basis).toBe("identity-value");
      expect(resolved.queueKey).toBe(canonicalJson(42));
    });
  });

  describe("OQ-3.2 — neither link nor identity value keys by the native id", () => {
    it("keys a full-fetch delete (no observed record) by its own native id", async () => {
      const links = new FakeRecordLinkStore();
      const resolver = new QueueKeyResolver(links);

      const resolved = await resolver.resolve(
        change({ sourceNativeId: "a1" /* no observedRecord — a delete */ }),
        { identitySourcePath: "email" },
      );
      expect(resolved).toStrictEqual({ outcome: "queue", queueKey: "a1", basis: "native-id" });
    });

    it("keys by native id when the observed record has no identity field value", async () => {
      const links = new FakeRecordLinkStore();
      const resolver = new QueueKeyResolver(links);

      const resolved = await resolver.resolve(
        change({ sourceNativeId: "a1", observedRecord: { name: "no email here" } }),
        { identitySourcePath: "email" },
      );
      expect(resolved).toStrictEqual({ outcome: "queue", queueKey: "a1", basis: "native-id" });
    });
  });

  describe("OQ-3.4 — the identity-rewrite narrowing", () => {
    it("keys a pre-link change by the identity value AS OBSERVED (the new value on a rewrite)", async () => {
      const links = new FakeRecordLinkStore(); // still unlinked
      const resolver = new QueueKeyResolver(links);

      // The record's identity field was renamed old@ → new@ this poll (no link yet).
      // The pre-link change queues under the value as observed — the new one — which is
      // the documented narrowing back to match-first-before-create for that record.
      const resolved = await resolver.resolve(
        change({ observedRecord: { email: "new@example.test" } }),
        { identitySourcePath: "email" },
      );
      expect(resolved).toStrictEqual({
        outcome: "queue",
        queueKey: "new@example.test",
        basis: "identity-value",
      });
    });
  });

  describe("a tombstoned link does not key by link id (only an ACTIVE link does)", () => {
    it("falls back to the identity value when the only link for the record is tombstoned", async () => {
      const links = new FakeRecordLinkStore();
      await links.insert(activeLink({ id: "link-old" }));
      await links.tombstone("link-old", "observed-delete", CLOCK);
      const resolver = new QueueKeyResolver(links);

      const resolved = queued(
        await resolver.resolve(change({ observedRecord: { email: "jane@example.test" } }), {
          identitySourcePath: "email",
        }),
      );
      // findActiveByRecord returns nothing → pre-link keying, not the tombstoned link id.
      expect(resolved.basis).toBe("identity-value");
      expect(resolved.queueKey).toBe("jane@example.test");
    });
  });
});
