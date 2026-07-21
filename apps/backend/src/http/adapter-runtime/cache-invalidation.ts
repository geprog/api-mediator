import { SyncRuleRepository, type DbTransaction } from "@mediator/db";
import { AuditLogStatus, AuditLogType } from "@mediator/domain";
import type { DeliveredEvent, EventConsumer } from "@mediator/event-bus";
import { z } from "zod";

import type { CacheInvalidator } from "./serve/cache-invalidator.js";

/**
 * **CH-3 — the `SyncEvent`-driven cache-invalidation consumer.** It reacts to a
 * `sync-execution` `SyncEvent` that recorded an **applied change** and drops every cached
 * adapter response of every endpoint bound to the changed backend resource, reusing the
 * Sync Engine's own change-detection signal instead of building a second one.
 *
 * The whole reaction is a cheap DB read (resolve the changed resource) plus an in-memory
 * cache drop through the shared {@link CacheInvalidator} seam — the SAME seam the adapter
 * write path (CH-4) routes through. It does NO LLM/network work, so it is safe to run inside
 * the Event-Bus dispatcher's transaction (the Phase-2 dispatcher-tx constraint). The drop
 * itself is not transactional, but that is deliberately safe: if the dispatcher tx later
 * rolls back, the only cost of the already-applied drop is a spurious miss → re-fetch — never
 * a correctness break.
 *
 * **CH-3.4 (bus loss):** the consumer is not on any request's critical path. If the event is
 * never delivered, the cached entry it would have dropped simply lives out its `cacheTtl` and
 * then expires on read — staleness bounded by `cacheTtl`, never an unbounded-stale entry.
 *
 * **CH-3.5 (coverage limit):** a backend that does not participate in peer-peer sync produces
 * no `SyncEvent` at all, so it receives no signal here and relies entirely on `cacheTtl`. That
 * is a documented coverage limit (surfaced to the operator later by the composition UI, CU-2);
 * nothing is pretended here beyond honestly not covering it.
 */

/** The consumer identity it deduplicates under (`processed_event.consumer_name`); stable. */
export const ADAPTER_CACHE_INVALIDATION_CONSUMER_NAME = "adapter-cache-invalidation";

/** The `SyncEvent`/`AuditLog` row `type` this consumer reacts to. */
const SYNC_EXECUTION_TYPE = AuditLogType["sync-execution"];

/**
 * The subset of a `sync-execution` `SyncEvent`'s persisted fields this consumer reads to
 * translate the event into a `(backendAppId, resourceRef)` invalidation signal: the executor
 * stamps `originAppId = targetAppId` (the app the change was written to,
 * `packages/outbound/src/executor.ts`), `relatedRuleId` names the `SyncRule` whose resource
 * pair changed, and `status` says whether an actual write was applied. Read defensively — a
 * payload missing any of them simply produces no invalidation.
 */
const syncExecutionSignalSchema = z.object({
  status: z.string().optional(),
  originAppId: z.string().optional(),
  relatedRuleId: z.string().optional(),
});

/**
 * Which `status` values represent an **actual applied change** (a successful write) that
 * should invalidate. Only `success` does: `failure` applied nothing knowable, and the
 * `skipped-*`/`conflict` outcomes are no-ops that changed no target data. Invalidating on
 * them would only churn the cache — still correctness-safe, but pointless — so we don't.
 */
function isAppliedChange(status: string | undefined): boolean {
  return status === AuditLogStatus.success;
}

/**
 * CH-3.2 — the target resource ref of the changed pair. `resourcePairRef` is the canonical,
 * direction-agnostic `${appId}:${resourceRef}|${appId}:${resourceRef}` key
 * (`apps/backend/src/modules/artifact-instantiation/derive.ts` `canonicalResourcePairRef`);
 * `originAppId` (= the executor's `targetAppId`) selects the target side, whose resource ref
 * is exactly the stable identifier the adapter binding uses
 * (`parseOperationRef(binding.backendOperationId).resourceRef`) — so `(originAppId, ref)`
 * matches the pair the cache captured on its entries.
 *
 * Fails closed to `undefined` (→ no invalidation, staleness bounded by `cacheTtl`) rather than
 * guessing when the pair does not have exactly one side belonging to `originAppId`: a malformed
 * ref, an origin app absent from the pair, or a same-app self-pair (two matching sides).
 */
export function targetResourceRefForOrigin(
  resourcePairRef: string,
  originAppId: string,
): string | undefined {
  const tokens = resourcePairRef.split("|");
  if (tokens.length !== 2) {
    return undefined;
  }
  // A trailing ":" on the prefix stops a shorter app id matching a longer one as a prefix
  // (app ids never contain ":", so the first ":" always ends the app-id segment).
  const prefix = `${originAppId}:`;
  const matches = tokens.filter((token) => token.startsWith(prefix));
  const token = matches.length === 1 ? matches[0] : undefined;
  if (token === undefined) {
    return undefined;
  }
  const resourceRef = token.slice(prefix.length);
  return resourceRef.length > 0 ? resourceRef : undefined;
}

/**
 * Resolve the changed pair's canonical `resourcePairRef` for a rule id, through the handler's
 * transaction. Returns `undefined` when the rule does not exist — mirroring
 * `SyncRuleRepository.getById` exactly, so a redelivered event for a since-deleted rule simply
 * invalidates nothing.
 */
export type SyncRulePairRefReader<TTx> = (ruleId: string, tx: TTx) => Promise<string | undefined>;

/**
 * The `sync-execution` {@link EventConsumer}. `TTx` is the transaction-handle type
 * (`DbTransaction` in production, an in-memory fake in tests). Idempotent: it derives the drop
 * purely from the event + committed state, so a redelivery re-drops (a no-op if nothing is
 * cached) — and the dispatcher already dedups by event id besides.
 */
export class SyncEventCacheInvalidationConsumer<TTx> implements EventConsumer<TTx> {
  public readonly name = ADAPTER_CACHE_INVALIDATION_CONSUMER_NAME;
  readonly #invalidator: CacheInvalidator;
  readonly #readResourcePairRef: SyncRulePairRefReader<TTx>;

  public constructor(
    invalidator: CacheInvalidator,
    readResourcePairRef: SyncRulePairRefReader<TTx>,
  ) {
    this.#invalidator = invalidator;
    this.#readResourcePairRef = readResourcePairRef;
  }

  public handles(type: string): boolean {
    return type === SYNC_EXECUTION_TYPE;
  }

  public async handle(event: DeliveredEvent, tx: TTx): Promise<void> {
    const parsed = syncExecutionSignalSchema.safeParse(event.payload);
    if (!parsed.success) {
      return;
    }
    const { status, originAppId, relatedRuleId } = parsed.data;
    // CH-3 selectivity — only a successful write invalidates; a skipped/failed/conflict
    // event, or one missing the target app / rule, resolves no signal and drops nothing.
    if (!isAppliedChange(status) || originAppId === undefined || relatedRuleId === undefined) {
      return;
    }
    const resourcePairRef = await this.#readResourcePairRef(relatedRuleId, tx);
    if (resourcePairRef === undefined) {
      return;
    }
    const resourceRef = targetResourceRefForOrigin(resourcePairRef, originAppId);
    if (resourceRef === undefined) {
      return;
    }
    // CH-3.1/CH-3.3 — coarse drop of every endpoint's entries bound to this backend resource.
    this.#invalidator.invalidateBackendResource(originAppId, resourceRef);
  }
}

/** The `sync-execution` cache-invalidation reaction for the shared `OutboxDispatcher` (RT-style). */
export interface AdapterCacheInvalidation {
  readonly consumer: EventConsumer<DbTransaction>;
}

/**
 * Wire the CH-3 consumer for the composition root. The rule reader resolves the changed pair's
 * `resourcePairRef` through the dispatcher's transaction via {@link SyncRuleRepository}; the
 * `invalidator` is the SAME {@link CacheInvalidator} the adapter write path uses (CH-4.3), over
 * the one shared in-process response cache.
 */
export function buildAdapterCacheInvalidation(deps: {
  readonly invalidator: CacheInvalidator;
}): AdapterCacheInvalidation {
  const consumer = new SyncEventCacheInvalidationConsumer<DbTransaction>(
    deps.invalidator,
    async (ruleId, tx) => (await new SyncRuleRepository(tx).getById(ruleId))?.resourcePairRef,
  );
  return { consumer };
}
