import {
  type RecordLink,
  type RecordLinkScopeRef,
  recordRelativePath,
  type ScopePathBinding,
} from "@mediator/domain";
import type { RecordLinkSideRef } from "@mediator/db";
import { readPath, type CapturedScope, type JsonRecord, type JsonValue } from "@mediator/transform";

import { stringifyIdentityValue } from "../identity-resolution/hash.js";
import { scopeQualifiedIdentityKey } from "./scoped-queue-key.js";

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
 *
 *     **SS-14.2 — scope-qualified for a scoped rule.** When the rule is scoped
 *     ({@link QueueKeyContext.scope} present), the pre-link identity-value key is qualified
 *     by the record's resolved **container**: each side's captured scope is resolved to the
 *     **shared `ScopeLink` first** ({@link PreLinkScopeResolver}), so both directions still
 *     compute the *identical* string (SS-14.2) while two records sharing an identity value
 *     in **different** containers no longer collide. **SS-14.3** — when that container does
 *     **not** resolve, the change **cannot be safely scope-keyed**, so it is **parked**
 *     (`park-container`) rather than enqueued under a guessed / un-scoped key. A non-scoped
 *     rule keeps the exact byte-for-byte key.
 *  3. **OQ-3.2 — neither link nor identity value → the record's own native id.** A
 *     change carrying neither (e.g. a full-fetch delete of a never-linked record, or a
 *     record whose identity field is absent) touches no shared pair state, so
 *     serializing it alone under its native id is sufficient. Never scope-qualified (a
 *     native-id-keyed record cannot cross-match, and a delete carries no captured scope).
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
  /** The change's target app — the other side of the pair (SS-14 scope resolution reads it). */
  readonly targetAppId: string;
  /** The source record's native id (`ResourceBinding.nativeIdRef`). */
  readonly sourceNativeId: string;
  /** The source record as observed this poll; absent on a delete (the record is gone). */
  readonly observedRecord?: JsonRecord | undefined;
  /**
   * SS-14 — the record's **captured scope** (SS-8), for the scope-qualified pre-link key.
   * Absent for a non-scoped rule and on a delete (nothing captured — a delete never
   * reaches the OQ-3.1 scope-qualified branch anyway).
   */
  readonly capturedScope?: CapturedScope | undefined;
}

/** The per-rule context the resolver needs: where this direction's identity value lives. */
export interface QueueKeyContext {
  /**
   * The confirmed identity `FieldMapping`'s **source** IR path for this direction. The
   * value read here is used **AS-IS** (no transform — identity keys are value-preserving),
   * exactly as the Identity Resolution stage reads it, so the pre-link key matches.
   */
  readonly identitySourcePath: string;
  /**
   * SS-14 — the **target** resource's scope path bindings when the rule is **scoped**. Its
   * presence flips the pre-link identity-value key to the scope-qualified form (SS-14.2) and
   * the unresolved-container park (SS-14.3). **Absent** for a non-scoped rule, whose key is
   * byte-for-byte unchanged.
   */
  readonly scope?: QueueKeyScopeContext | undefined;
}

/** SS-14 — the scoped-rule config the pre-link key qualification needs. */
export interface QueueKeyScopeContext {
  /** The **target** resource's scope path bindings (classify L2/L3 + resolve the container). */
  readonly targetScopePathBindings: readonly ScopePathBinding[];
}

/** Which of the three OQ-2/OQ-3 rules produced the key (for observability / tests). */
export type QueueKeyBasis = "record-link" | "identity-value" | "native-id";

/**
 * The resolved `queue_key` (`queue`) or the SS-14.3 decision to **park** the record's
 * container rather than enqueue it under an unsafe key — a discriminated union so the Poller
 * can never mistake a park for an enqueue.
 */
export type QueueKeyResolution =
  | { readonly outcome: "queue"; readonly queueKey: string; readonly basis: QueueKeyBasis }
  | { readonly outcome: "park-container"; readonly reason: string };

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

/**
 * SS-14 — resolves a **pre-link** scoped change's captured scope to its **shared** container
 * `RecordLinkScopeRef` (the container the scope prefix is derived from), or a park/none
 * signal. Implemented at the composition root (it needs the outbound container fill + the
 * `ScopeLinkStore`), so `@mediator/sync-engine` stays free of those dependencies. It resolves
 * to the **same** `RecordLinkScopeRef` the Identity Resolution stage freezes onto the new
 * link (`scopeRefForNewLink`), so the poller's pre-link key and the stage's retained
 * `establishingQueueKey` compute the identical string.
 */
export interface PreLinkScopeResolver {
  resolve(input: PreLinkScopeInput): Promise<PreLinkScopeResolution>;
}

/** The per-change input the {@link PreLinkScopeResolver} resolves a container from. */
export interface PreLinkScopeInput {
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  readonly capturedScope: CapturedScope | undefined;
  readonly targetScopePathBindings: readonly ScopePathBinding[];
}

/** The {@link PreLinkScopeResolver} outcome: a resolved container, an unresolvable one (park), or a non-scoped rule. */
export type PreLinkScopeResolution =
  | { readonly kind: "scoped"; readonly scopeRef: RecordLinkScopeRef }
  | { readonly kind: "unresolved"; readonly reason: string }
  | { readonly kind: "not-scoped" };

export class QueueKeyResolver {
  readonly #links: ActiveRecordLinkLookup;
  readonly #scopeResolver: PreLinkScopeResolver | undefined;

  public constructor(links: ActiveRecordLinkLookup, scopeResolver?: PreLinkScopeResolver) {
    this.#links = links;
    this.#scopeResolver = scopeResolver;
  }

  /**
   * Resolve the opaque `queue_key` for `change` per the OQ-2/OQ-3 rule above. One
   * cheap active-link lookup, then a local read of the observed identity value (and, on a
   * **scoped** rule with an identity value, the SS-14 container resolution) — no pipeline.
   * Called by the Poller **before** the durable enqueue.
   */
  public async resolve(
    change: QueueKeyChange,
    context: QueueKeyContext,
  ): Promise<QueueKeyResolution> {
    // OQ-2 / OQ-3.3: an active RecordLink by (app, native id) → the shared link id.
    const link = await this.#links.findActiveByRecord(change.resourcePairRef, {
      appId: change.sourceAppId,
      nativeId: change.sourceNativeId,
    });
    if (link !== undefined) {
      return { outcome: "queue", queueKey: link.id, basis: "record-link" };
    }

    // OQ-3.1: no link → the observed identity-key value (same string from either side).
    const identityValue = readIdentityValue(change, context);
    if (identityValue !== undefined) {
      const identityKey = stringifyIdentityValue(identityValue);
      // SS-15.7 (carried-over SS-14 hardening) — a scoped context with NO `PreLinkScopeResolver`
      // wired must NOT silently fall through to the plain non-scoped identity-value key: that
      // would key a scoped rule as if non-scoped, a latent cross-match / cross-direction-duplicate
      // footgun. Fail loud instead (mirrors the Poller's "scoped park but no sink wired" throw) —
      // a scoped rule is always constructed with its resolver.
      if (context.scope !== undefined && this.#scopeResolver === undefined) {
        throw new Error(
          "scoped context supplied without a PreLinkScopeResolver — a scoped rule must never be keyed as if non-scoped (SS-15.7)",
        );
      }
      // SS-14.2/14.3 — scope-qualify the pre-link key on a scoped rule.
      if (context.scope !== undefined && this.#scopeResolver !== undefined) {
        const scoped = await this.#scopeResolver.resolve({
          resourcePairRef: change.resourcePairRef,
          sourceAppId: change.sourceAppId,
          targetAppId: change.targetAppId,
          capturedScope: change.capturedScope,
          targetScopePathBindings: context.scope.targetScopePathBindings,
        });
        if (scoped.kind === "unresolved") {
          // SS-14.3 — cannot be safely scope-keyed → park, never enqueue un-scoped.
          return { outcome: "park-container", reason: scoped.reason };
        }
        if (scoped.kind === "scoped") {
          return {
            outcome: "queue",
            queueKey: scopeQualifiedIdentityKey(scoped.scopeRef, identityKey),
            basis: "identity-value",
          };
        }
        // `not-scoped` — the target carries no confirmed scope binding after all; fall
        // through to the plain identity-value key (byte-for-byte the non-scoped key).
      }
      return { outcome: "queue", queueKey: identityKey, basis: "identity-value" };
    }

    // OQ-3.2: neither link nor identity value → the record's own native id.
    return { outcome: "queue", queueKey: change.sourceNativeId, basis: "native-id" };
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
  const read = readPath(change.observedRecord, recordRelativePath(context.identitySourcePath));
  return read.present ? read.value : undefined;
}
