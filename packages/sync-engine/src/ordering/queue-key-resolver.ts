import type { RecordLink } from "@mediator/domain";
import type { RecordLinkSideRef } from "@mediator/db";
import { readPath, type JsonRecord, type JsonValue } from "@mediator/transform";

import { stringifyIdentityValue } from "../identity-resolution/hash.js";

/**
 * **OQ-2 / OQ-3 — the ordering-queue key resolver.** Decides *what* the opaque
 * `queue_key` is for one detected change, resolved by a **cheap pre-enqueue lookup**
 * so the Poller (SP) can key the change before the Identity Resolution stage (which
 * runs *inside* the queued execution) ever runs
 * (`docs/architecture/sync-engine.md` *Ordering and consistency*;
 * `docs/requirements/phase-4-ordering-queue.md` OQ-2, OQ-3;
 * `docs/flows/sync-polling-pull.md` step 3).
 *
 * The rule, in priority order:
 *
 *  1. **OQ-2 — an active `RecordLink` → its link id.** A *linked* record is keyed by
 *     the shared `RecordLink`, deliberately **not** by `(mapping, resourceId)`: both
 *     directions of a bidirectional pair resolve the *same* link (the link is shared,
 *     addressed by (app, native id) on either side), so both enqueue under the **same**
 *     key and serialize on **one** queue over their shared `SyncFieldState`/`RecordLink`.
 *     This is what makes the cross-direction value-swap unrepresentable (OQ-2.1/2.2).
 *  2. **OQ-3.1 — no link, but an observed identity value → that value.** Guaranteed the
 *     *same* string from either side, because the identity pairing is shared and
 *     value-preserving (`rename`-only) — so two directions concurrently matching-then-
 *     creating "the same" record serialize instead of racing into duplicates. The
 *     string encoding is {@link stringifyIdentityValue}, the **same** function the
 *     Identity Resolution stage retains as `RecordLink.establishingQueueKey.value`, so
 *     the OQ-4 continuation gate can recognize this queue as a link's establishing queue.
 *  3. **OQ-3.2 — neither link nor identity value → the record's own native id.** A
 *     change carrying neither (e.g. a full-fetch delete of a never-linked record, or a
 *     record whose identity field is absent) touches no shared pair state, so
 *     serializing it alone under its native id is sufficient.
 *
 * **The identity-rewrite narrowing (OQ-3.4).** The pre-link identity-value key assumes
 * the identity value is *stable* while the record is unlinked — the normal case for a
 * business key. A pre-link change that itself **rewrites the identity field** is keyed
 * by the value **as observed** (the new value): across the old change (old value) and
 * the new one (new value) the record may briefly sit under *two* identity-value queues,
 * so the two-directions-serialize guarantee narrows, for exactly that record, back to
 * match-first-before-create (the Identity Resolution stage still looks the record up by
 * the observed value before creating, so a duplicate is not created — the record simply
 * loses the pre-link *ordering* guarantee for that one transition). This is a documented
 * narrowing, not a silent gap.
 *
 * The keys are intentionally **not** scoped by `resourcePairRef`: an identity value or
 * native id shared across unrelated resource pairs collides onto one queue, which only
 * ever **over**-serializes (safe — cross-record/cross-mapping ordering is neither
 * guaranteed nor required, OQ-1.4). Under-sharing would be the dangerous direction and
 * never happens: both directions of a pair always compute the identical string.
 */
export interface QueueKeyChange {
  /** The mapped resource pair in canonical direction-agnostic form (keys links/state). */
  readonly resourcePairRef: string;
  /** The change's source app (this direction's poll source). */
  readonly sourceAppId: string;
  /** The source record's native id (`ResourceBinding.nativeIdRef`). */
  readonly sourceNativeId: string;
  /** The source record as observed this poll; absent on a delete (the record is gone). */
  readonly observedRecord?: JsonRecord | undefined;
}

/** The per-rule context the resolver needs: where this direction's identity value lives. */
export interface QueueKeyContext {
  /**
   * The confirmed identity `FieldMapping`'s **source** IR path for this direction. The
   * value read here is used **AS-IS** (no transform — identity keys are value-preserving),
   * exactly as the Identity Resolution stage reads it, so the pre-link key matches.
   */
  readonly identitySourcePath: string;
}

/** Which of the three OQ-2/OQ-3 rules produced the key (for observability / tests). */
export type QueueKeyBasis = "record-link" | "identity-value" | "native-id";

/** The resolved opaque `queue_key` plus which rule produced it. */
export interface ResolvedQueueKey {
  /** The opaque `queue_key` the Poller enqueues under (OQ-1 never interprets it). */
  readonly queueKey: string;
  readonly basis: QueueKeyBasis;
}

/**
 * The narrow active-link lookup the resolver depends on — the "cheap pre-enqueue
 * lookup" of OQ-3.3. `RecordLinkStore` (real repo + fake) satisfies it structurally,
 * so the resolver is unit-testable against the fake without the whole store.
 */
export interface ActiveRecordLinkLookup {
  findActiveByRecord(
    resourcePairRef: string,
    record: RecordLinkSideRef,
  ): Promise<RecordLink | undefined>;
}

export class QueueKeyResolver {
  readonly #links: ActiveRecordLinkLookup;

  public constructor(links: ActiveRecordLinkLookup) {
    this.#links = links;
  }

  /**
   * Resolve the opaque `queue_key` for `change` per the OQ-2/OQ-3 rule above. One
   * cheap active-link lookup, then a local read of the observed identity value — no
   * network, no pipeline. Called by the Poller **before** the durable enqueue.
   */
  public async resolve(
    change: QueueKeyChange,
    context: QueueKeyContext,
  ): Promise<ResolvedQueueKey> {
    // OQ-2 / OQ-3.3: an active RecordLink by (app, native id) → the shared link id.
    const link = await this.#links.findActiveByRecord(change.resourcePairRef, {
      appId: change.sourceAppId,
      nativeId: change.sourceNativeId,
    });
    if (link !== undefined) {
      return { queueKey: link.id, basis: "record-link" };
    }

    // OQ-3.1: no link → the observed identity-key value (same string from either side).
    const identityValue = readIdentityValue(change, context);
    if (identityValue !== undefined) {
      return { queueKey: stringifyIdentityValue(identityValue), basis: "identity-value" };
    }

    // OQ-3.2: neither link nor identity value → the record's own native id.
    return { queueKey: change.sourceNativeId, basis: "native-id" };
  }
}

/**
 * Read this direction's identity value out of the observed record, used AS-IS — the
 * same read the Identity Resolution stage performs, so the resolver's pre-link key and
 * the stage's retained `establishingQueueKey` are computed from the identical value.
 * Absent record (a delete) or absent/undefined field → no identity value.
 */
function readIdentityValue(
  change: QueueKeyChange,
  context: QueueKeyContext,
): JsonValue | undefined {
  if (change.observedRecord === undefined) {
    return undefined;
  }
  const read = readPath(change.observedRecord, context.identitySourcePath);
  return read.present ? read.value : undefined;
}
