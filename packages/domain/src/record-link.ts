import { z } from "zod";

import {
  recordLinkEstablishedBySchema,
  recordLinkStatusSchema,
  tombstoneReasonSchema,
} from "./sync-enums.js";

/**
 * `RecordLink` — the persisted pairing of one logical record's native id in app A
 * with its native id in app B (`docs/architecture/data-model.md` `RecordLink`;
 * `docs/glossary.md` `RecordLink`, requirement SD-2). Two independently-owned apps
 * assign their own primary ids, so the pairing must be recorded explicitly: update
 * routing, conflict detection, delete propagation, and delete-echo detection all
 * depend on it. Scoped to the unordered app pair (via the direction-agnostic
 * `resourcePairRef`), so it is shared by both directions of a bidirectional pair —
 * exactly like `SyncFieldState`, which is keyed by it.
 *
 * Types only, no behavior: establishing / tombstoning / archiving is RL-* / Phase 6.
 * References its two apps **by id only** — carries no credential material
 * (SD-2 criterion 5).
 */

// ── establishingQueueKey (SD-2 criterion 4) ──────────────────────────────────

/**
 * The establishing execution's **retained pre-link ordering-queue key**, so
 * OQ-4's link-keyed queue opens strictly as a **continuation** of the queue that
 * created the link, never beside it (`docs/architecture/data-model.md`
 * `RecordLink.establishedBy`; `docs/architecture/sync-engine.md` *Ordering and
 * consistency*). Not a glossary entity — a small tag encoding, in the type system,
 * the two forms the retained key takes:
 *
 * - `identity-value` — the pre-link queue was keyed by the pair's shared,
 *   value-preserving identity-key value. This is the establishing key for a
 *   `create-propagation` or `identity-match` link (both resolve the record by that
 *   value), and what a `manual` link records **when its resource pair has a
 *   confirmed identity key**.
 * - `both-native-id-queues` — a `manual` link established **absent** a confirmed
 *   identity key: there is no single establishing queue, so the link-keyed queue
 *   opens only after **both** sides' native-id-keyed queues drain. A marker with no
 *   value; it only ever arises on a `manual` link (enforced below).
 */
export const recordLinkEstablishingQueueKeySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity-value"), value: z.string() }),
  z.object({ kind: z.literal("both-native-id-queues") }),
]);
export type RecordLinkEstablishingQueueKey = z.infer<typeof recordLinkEstablishingQueueKeySchema>;

// ── scopeRef (scoped-rule container routing, SS-10) ───────────────────────────

/**
 * The record's persisted **container**, captured at link establishment
 * (`docs/architecture/data-model.md` `RecordLink.scopeRef`; SS-10 criterion 4).
 * Present **only** on a link under a **scoped** rule — **absent** on a non-scoped
 * rule's links. It lets an operation carrying no live source record — a propagated
 * **delete**, and any no-captured-scope read (`targetDriftCheck = read-before-write`
 * / a PUT read-carry) — still fill its target scope path parameters from stored
 * state instead of re-deriving them from a source record that is gone. For a
 * *linked* record this is the authoritative scope source (a linked update/delete
 * routes by `scopeRef`, never by a captured scope, which is used only on the
 * pre-link create path).
 *
 * A discriminated union over the two fill mechanisms:
 *
 * - `scope-link` — `{ kind: "scope-link", scopeLinkId }`: the arbitrary-value-space
 *   (L3) case. The target container key is read from the referenced `ScopeLink` — a
 *   *reference*, so an **archived** `ScopeLink` still resolves its stored key for a
 *   final delete/audit (SS-10 criterion 5).
 * - `resolved` — `{ kind: "resolved", values }`: the shared-value-space (L2
 *   `record-derived`) case. The resolved `{ parameterName → value }` map, **frozen**
 *   at establishment — so an L2 rule's deletes route from stored values too, unifying
 *   the delete fix across L2 and L3.
 */
export const recordLinkScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scope-link"), scopeLinkId: z.string().min(1) }),
  z.object({ kind: z.literal("resolved"), values: z.record(z.string(), z.string()) }),
]);
export type RecordLinkScopeRef = z.infer<typeof recordLinkScopeRefSchema>;

// ── RecordLink ───────────────────────────────────────────────────────────────

/**
 * Field notes:
 *
 * - `resourcePairRef` — the mapped resource pair this link correlates, in the same
 *   **canonical direction-agnostic form** as `SyncRule.resourcePairRef` (the two
 *   (spec lineage, resource) sides ordered by a stable key, never by mapping
 *   direction), so both directions of a pair name the same link (SD-2 criterion 1).
 * - `tombstoneReason` — present **only** on a `tombstoned` link (a link is
 *   tombstoned, never deleted). The refinement makes it unrepresentable on an
 *   `active` or `archived` link and required on a `tombstoned` one (SD-2 criterion 3).
 * - `establishingQueueKey` — the retained pre-link ordering key (above); the
 *   `both-native-id-queues` marker is confined to `manual` links (SD-2 criterion 4).
 * - `tombstonedAt` — nullable: `null` on an `active`/`archived` link, set when the
 *   link is tombstoned (SD-2 criterion 5).
 * - `scopeRef` — optional (above); present only on a link under a scoped rule,
 *   absent on a non-scoped rule's links (SS-10 criterion 4).
 */
export const recordLinkSchema = z
  .object({
    id: z.string(),
    appAId: z.string(),
    appANativeId: z.string(),
    appBId: z.string(),
    appBNativeId: z.string(),
    resourcePairRef: z.string(),
    establishedBy: recordLinkEstablishedBySchema,
    status: recordLinkStatusSchema,
    tombstoneReason: tombstoneReasonSchema.optional(),
    establishingQueueKey: recordLinkEstablishingQueueKeySchema,
    createdAt: z.date(),
    tombstonedAt: z.date().nullable(),
    scopeRef: recordLinkScopeRefSchema.optional(),
  })
  .superRefine((link, ctx) => {
    // `tombstoneReason` is present iff the link is tombstoned.
    if (link.status === "tombstoned") {
      if (link.tombstoneReason === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "a tombstoned RecordLink must carry a tombstoneReason",
          path: ["tombstoneReason"],
        });
      }
    } else if (link.tombstoneReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "tombstoneReason is present only on a tombstoned RecordLink",
        path: ["tombstoneReason"],
      });
    }

    // The `both-native-id-queues` marker only ever arises on a manual link
    // established absent a confirmed identity key; a create-propagation /
    // identity-match link always resolves the record by its identity value and so
    // retains that value as its key.
    if (
      link.establishingQueueKey.kind === "both-native-id-queues" &&
      link.establishedBy !== "manual"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "the both-native-id-queues establishingQueueKey marker arises only on a manual RecordLink",
        path: ["establishingQueueKey"],
      });
    }
  });
export type RecordLink = z.infer<typeof recordLinkSchema>;
