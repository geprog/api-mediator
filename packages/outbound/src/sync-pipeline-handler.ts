import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AuditLogEntry,
  FieldMapping,
  IrRefTarget,
  RecordAddressing,
  OperationMapping,
  OutboundLoadLimits,
  ParkedConflict,
  ParkedConflictKind,
  ParkedConflictResolutionChoice,
  RecordLink,
  ScopePathBinding,
  SyncFieldState,
  SyncFieldStateSide,
  TombstoneReason,
} from "@mediator/domain";
import { recordRelativePath, stripUndefined } from "@mediator/domain";
import {
  isTransformError,
  readPath,
  setPath,
  type AppliedMapping,
  type ApplyOptions,
  type JsonRecord,
  type JsonValue,
} from "@mediator/transform";
import {
  hashFieldValue,
  type ConflictDetectionInput,
  type ConflictDetectionOutcome,
  type DeletionConflictInput,
  type DeletionConflictOutcome,
  type DeletionConflictOverride,
  type DetectedChange,
  type FieldConflictOverride,
  type FieldPlan,
  type LoopPreventionContext,
  type LoopPreventionInput,
  type LoopPreventionOutcome,
  type QueueHandler,
  type QueueHandlerContext,
  type RecordWriteInput,
  type ResolutionContext,
  type ResolutionOutcome,
  type StageTraceContext,
  type SyncEventRecorder,
} from "@mediator/sync-engine";
import type { ConflictDetectionContext, DeletionConflictContext } from "@mediator/sync-engine";

import {
  containerScopeParamNames,
  fillContainerScopeParams,
  resolveScopeRefFillValues,
  type ScopeLinkReader,
} from "./container-scope.js";
import {
  ContainerUnresolvedError,
  PermanentOutboundError,
  RecordAddressUnresolvedError,
  settleOutboundResult,
} from "./errors.js";
import type {
  OutboundCall,
  OutboundCallCommon,
  OutboundCallResult,
  TransformFailureContext,
  WrittenRepresentation,
} from "./executor.js";
import type { PriorReconciledState } from "./idempotency.js";
import type { RestOperationBinding } from "./protocol-client.js";

/**
 * **Phase 4 sync pipeline handler** — the integration slice that wires the per-record
 * pipeline **Identity Resolution → Loop Prevention → Conflict Detection →
 * Transformation → Outbound Call** (RL/EP/CF/TX/OC) into a single {@link QueueHandler}
 * the ordering-queue dispatcher runs on each enqueued `DetectedChange`
 * (`docs/flows/sync-polling-pull.md` steps 3.1–3.7 + 4; `docs/architecture/sync-engine.md`
 * *Polling pull pipeline*, *Ordering and consistency*, *Change types*, *Conflict
 * handling*, *Loop prevention*, *Write failures*).
 *
 * **Why it lives in `@mediator/outbound`, not `@mediator/sync-engine`:** it composes
 * the RL/EP/CF stages from `@mediator/sync-engine`, `applyFieldMappings` from
 * `@mediator/transform`, and the Outbound Call Executor here — and outbound already
 * depends on sync-engine (the `RestSourceReader` precedent), so a handler in
 * sync-engine that reached into outbound would be a dependency cycle. Outbound is the
 * composition layer above the stages.
 *
 * **The two distinct "parks" this handler keeps separate** (the subtlest contract):
 *  - a **conflict park** (RL ambiguous → manual, EP echo, CF all-withheld, a
 *    drifted-delete park, a `skipped-policy`) is the pipeline *doing its job*: the
 *    responsible stage records its `conflict` / `skipped-*` `SyncEvent` and processing
 *    stops **successfully** → the handler **resolves** (the queue entry is `done`);
 *  - a **dead-letter park** (a write that failed permanently, a transform error, a
 *    throttle, or a transient failure) → the handler **throws** (via
 *    {@link settleOutboundResult}, or a {@link PermanentOutboundError} for a transform
 *    error), and the **dispatcher** parks / retries / defers it via
 *    `classifyOutboundFailure`.
 *
 * A conflict must never surface as a thrown dispatcher failure; a transient failure
 * must never be swallowed as a silent `done`.
 *
 * **Deferred to the composition/BE/SA slice (not built here):** the real
 * {@link SyncPipelineContextLoader} (loads the `ApprovedMapping`/`SyncRule`/bindings and
 * resolves the operation refs to `RestOperationBinding`s), the real repositories behind
 * the stages, the real `ProtocolClient`/readers, and binding the dispatcher to this
 * handler with `classifyOutboundFailure`. This slice ships the orchestration and its
 * consumer-defined ports, unit-tested with the existing fakes.
 */

// ── Injected collaborator ports ───────────────────────────────────────────────

/** The Identity Resolution surface the handler drives (the real `IdentityResolutionStage` satisfies it). */
export interface IdentityResolutionPort {
  resolve(change: DetectedChange, context: ResolutionContext): Promise<ResolutionOutcome>;
  /** RL-2 — write the create-propagation link from a create response's native id. */
  recordCreatePropagation(
    change: DetectedChange,
    context: ResolutionContext,
    createdNativeId: string,
    /** SS-19 — the created record's container-relative address, frozen onto the new link. */
    createdRecordAddress?: string,
  ): Promise<RecordLink>;
  /** RL-5.3 — tombstone (never delete) a link on a processed deletion. */
  processDeletion(link: RecordLink, reason: TombstoneReason): Promise<RecordLink>;
}

/** The Loop Prevention surface the handler drives (the real `LoopPreventionStage` satisfies it). */
export interface LoopPreventionPort {
  check(input: LoopPreventionInput): Promise<LoopPreventionOutcome>;
  /** EP-3 — re-baseline both sides + populate the recently-written cache after a successful write. */
  recordWrite(input: RecordWriteInput): Promise<SyncFieldState[]>;
}

/** The Conflict Detection surface the handler drives (the real `ConflictDetectionStage` satisfies it). */
export interface ConflictDetectionPort {
  detect(input: ConflictDetectionInput): Promise<ConflictDetectionOutcome>;
  evaluateDeletion(input: DeletionConflictInput): Promise<DeletionConflictOutcome>;
}

/** The Outbound Call Executor surface the handler drives (the real `OutboundCallExecutor` satisfies it). */
export interface OutboundExecutorPort {
  execute(call: OutboundCall): Promise<OutboundCallResult>;
  recordTransformFailure(
    context: TransformFailureContext,
    error: unknown,
  ): Promise<OutboundCallResult>;
}

/** The Transformation Executor — `applyFieldMappings` (TX-1..TX-5), injected so it is swappable + isolatable. */
export type ApplyFieldMappingsFn = (
  fields: readonly FieldMapping[],
  source: JsonRecord,
  options?: ApplyOptions,
) => AppliedMapping;

/**
 * The narrow `SyncFieldState` port the handler itself touches (the stages own their
 * own reads/writes): reading a link's rows for the OC-2 `PriorReconciledState`, and
 * persisting App A's **source-side observation** before Conflict Detection runs.
 * `FakeSyncFieldStateStore` and the real `SyncFieldStateRepository` both satisfy it —
 * and it MUST be the **same instance** the stages hold, so a source observation the
 * handler persists is the one CF reads (`docs/architecture/sync-engine.md` *Conflict
 * handling* — CF compares over persisted observations).
 */
export interface SyncFieldStateGateway {
  findByLink(recordLinkId: string): Promise<SyncFieldState[]>;
  /**
   * `ON CONFLICT DO UPDATE` upsert of a link's per-side-field rows. The handler uses
   * it to persist a source-side observation by re-supplying each row's **existing**
   * reconciled baseline unchanged (so only the observed columns move — the baseline
   * is never disturbed before CF), exactly as EP-3 uses it to re-baseline after a write.
   */
  reBaseline(rows: readonly SyncFieldState[]): Promise<void>;
}

/** The operator's recorded resolution decision (OA-3) — mirrors the db `ParkedConflictResolution`. */
export interface ParkedConflictResolutionRecord {
  readonly choice: ParkedConflictResolutionChoice;
  readonly resolvedBy: string;
  readonly resolvedAt: Date;
}

/**
 * The narrow `parked_conflict` write port the handler owns (SA-4): it **records** a
 * structured park whenever CF's outcome parks (a `manual-resolve`/`withheld` field —
 * CF-3/CF-4/CF-5 — or a drifted-delete — CF-7), and **resolves** the rows a SA-4
 * resolution re-run referenced once that re-run completes through the pipeline. The
 * real `ParkedConflictRepository` (`@mediator/db`) satisfies it structurally — a
 * consumer-defined port here, exactly like {@link SyncFieldStateGateway}, so
 * `@mediator/outbound` never imports `@mediator/db` (no cycle). The upserts are
 * **idempotent by the open key**: re-processing the same still-conflicting field
 * updates the existing open row rather than duplicating it (SA-4 / the CF-review gap).
 * **Never** carries a raw contested value — only ids/paths/hashes (data boundary).
 */
export interface ParkedConflictWriter {
  upsertOpenFieldConflict(conflict: ParkedConflict): Promise<void>;
  upsertOpenDriftedDelete(conflict: ParkedConflict): Promise<void>;
  resolve(id: string, resolution: ParkedConflictResolutionRecord): Promise<unknown>;
}

// ── The per-change context the (deferred, composition-root) loader resolves ────

/** A target operation resolved to its wire binding + its `OperationMapping` (SP-3 selected which). */
export interface ResolvedTargetOperation {
  readonly operation: RestOperationBinding;
  readonly operationMapping: OperationMapping;
}

/**
 * Everything the pipeline stages + the Outbound Call Executor need for one change
 * that is *not* carried by the `DetectedChange` itself — the resolved
 * `ApprovedMapping`/`SyncRule`/`ResourceBinding` artifacts. Assembled by the
 * {@link SyncPipelineContextLoader} (the real binding/IR resolution is the deferred
 * composition-root job; the handler only orchestrates over the resolved shape).
 */
export interface SyncPipelineContext {
  /** RL's per-rule context (canonical A/B, identity paths, lookup path, create-op policy, field pairings). */
  readonly resolution: ResolutionContext;
  /** EP's per-change context (canonical A/B + both directions' field participation). */
  readonly loopPrevention: LoopPreventionContext;
  /** CF's write-path context (target fields, PATCH/PUT shape, drift check, LWW gate, read binding). */
  readonly conflict: ConflictDetectionContext;
  /** CF's delete-path context (delete propagation, drift check, mapped target fields, read binding). */
  readonly deletion: DeletionConflictContext;
  /** This direction's `FieldMapping`s — TX input, EP re-baseline set, source-observation fields. */
  readonly fieldMappings: readonly FieldMapping[];
  /** The **source** resource ref — the EP-2 recently-written cache probe key (`appId = sourceAppId`). */
  readonly sourceResourceRef: string;
  /** The **target** resource ref — the EP-2 cache key a successful write marks (`appId = targetAppId`). */
  readonly targetResourceRef: string;
  /** EP-2's optional write-tag fast path (the target API supports write metadata). Correctness never depends on it. */
  readonly carriesMediatorWriteTag?: boolean;
  /** The resolved `action = create` target operation (present iff the mapping approved one). */
  readonly createOperation?: ResolvedTargetOperation;
  /** The resolved `action = update` target operation (present iff the mapping approved one). */
  readonly updateOperation?: ResolvedTargetOperation;
  /** The resolved `action = delete` target operation (present iff the mapping approved one). */
  readonly deleteOperation?: ResolvedTargetOperation;
  /** The target app's base URL (`RegisteredApp.baseUrl`). */
  readonly targetBaseUrl: string;
  /** The target resource's `ResourceBinding.nativeIdRef` — reads a create's new native id from the response. */
  readonly targetResourceNativeIdRef: IrRefTarget;
  /** The target app's resolved outbound ceilings (`RegisteredApp.outboundLimits`); absent → executor default. */
  readonly targetAppLimits?: OutboundLoadLimits;
  /** The **source** resource's `ResourceBinding.changeTimestampRef` — the source observation's change timestamp. */
  readonly sourceChangeTimestampRef?: string;
  /** The **target** resource's `ResourceBinding.changeTimestampRef` — the written representation's change timestamp. */
  readonly targetChangeTimestampRef?: string;
  /**
   * SS-12 — the **target** resource's `scopePathBindings` (its `record-derived`/`scope-link`
   * container parameters), so a **linked delete** fills the delete op's still-templated
   * container `{…}` from the record's stored `RecordLink.scopeRef` — routing to the right
   * container even though a delete carries no captured scope. Absent / empty on a non-scoped
   * rule (the delete op is already fully composed at load, so no per-record fill runs).
   */
  readonly scopePathBindings?: readonly ScopePathBinding[];
  /**
   * SS-19 — how the **target** resource addresses its records, decided once at load by
   * `resolveRecordAddressing(targetBinding, isContainerScoped)`:
   *
   * - `native-id` — address from the `RecordLink`'s target-side native id. This is the
   *   default when the key is **absent**, so every existing context builder, every
   *   unscoped rule and every pre-SS-19 binding compose byte-for-byte as before.
   * - `stored-address` — address from the `RecordLink`'s target-side frozen record
   *   address (a Gitea issue's `number`).
   * - `unconfirmed-address-ref` — a scoped target with a derived-but-unconfirmed
   *   `recordAddressRef`: park, never guess.
   */
  readonly targetRecordAddressing?: RecordAddressing;
  /**
   * SS-19 — the **target** resource's confirmed `ResourceBinding.recordAddressRef`, so a
   * **create**'s response yields the new record's container-relative address to freeze onto
   * the new `RecordLink`. Absent on a native-id-addressed target.
   */
  readonly targetResourceRecordAddressRef?: IrRefTarget;
}

/**
 * Resolves a `DetectedChange` into its {@link SyncPipelineContext}. Injected so the
 * handler is unit-testable against a fake that returns a canned context; the real
 * loader (composition root) loads the `ApprovedMapping`/`SyncRule`/`ResourceBinding`s
 * and resolves operation refs to wire bindings.
 */
export interface SyncPipelineContextLoader {
  load(change: DetectedChange): Promise<SyncPipelineContext>;
}

// ── Handler construction ──────────────────────────────────────────────────────

/** The handler's injected collaborators — every stage, TX, OC, the loader, and the field-state / event ports. */
export interface SyncPipelineHandlerDeps {
  readonly identityResolution: IdentityResolutionPort;
  readonly loopPrevention: LoopPreventionPort;
  readonly conflictDetection: ConflictDetectionPort;
  readonly transform: ApplyFieldMappingsFn;
  readonly outbound: OutboundExecutorPort;
  readonly fieldState: SyncFieldStateGateway;
  readonly contextLoader: SyncPipelineContextLoader;
  /** The `SyncEvent` recorder for the one event no stage owns — a delete of a never-linked record. */
  readonly events: SyncEventRecorder;
  /** SA-4 — the structured parked-conflict store the handler records parks into + resolves re-runs against. */
  readonly parkedConflicts: ParkedConflictWriter;
  /**
   * SS-12 — the `ScopeLink` read port a **scoped** rule's linked delete/update fills its
   * target container parameter from (via the record's stored `RecordLink.scopeRef`).
   * Absent on a non-scoped deployment (the real `ScopeLinkRepository` satisfies it); a
   * scoped delete reaching the write path with no reader parks (container-unresolved),
   * never mis-writes.
   */
  readonly scopeLinks?: ScopeLinkReader;
}

export interface SyncPipelineHandlerOptions {
  readonly clock?: () => Date;
  readonly newId?: () => string;
  /** Reads the active trace context for the handler-owned `SyncEvent` (default: none). */
  readonly readTraceContext?: () => StageTraceContext | null;
  /** The `SyncEvent.actor` for the handler's system-initiated event (default `"system"`). */
  readonly actor?: string;
}

const DEFAULT_ACTOR = "system";

// ── Payload parsing (never a cast over `Record<string, unknown>`) ─────────────

/** A recursive JSON value validator — the observed record is JSON already (a polled response). */
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * The enqueued payload SP materializes with `buildChangePayload` — exactly the
 * serialized `DetectedChange`. Parsed (never cast) back into the shape the stages
 * consume; a non-delete change must carry its observed record (there is nothing to
 * transform / echo-check otherwise).
 */
const changePayloadSchema = z
  .object({
    ruleId: z.string(),
    mappingId: z.string(),
    sourceAppId: z.string(),
    targetAppId: z.string(),
    resourcePairRef: z.string(),
    sourceNativeId: z.string(),
    changeKind: z.enum(["create", "update", "delete"]),
    observedRecord: z.record(z.string(), jsonValueSchema).optional(),
    // SS-8.5 — the captured scope that rode WITH the change through the queue payload
    // (the `{ component-key → value }` routing key a `record-derived` target scope
    // binding fills from). Absent for a non-scoped / constant-only rule.
    capturedScope: z.record(z.string(), jsonValueSchema).optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.changeKind !== "delete" && payload.observedRecord === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a create/update change must carry its observedRecord",
        path: ["observedRecord"],
      });
    }
  });

/**
 * SA-4 — the operator's one-shot resolution directive, carried on the re-run's enqueued
 * payload under `resolution` (alongside the serialized `DetectedChange`). The mediator
 * builds it, so a malformed one is a bug (parked, not retried). `overrides` thread into
 * CF for a field re-run; `deleteOverride` into CF-7 for a propagate re-run; `choice` +
 * `parkedConflictIds` are what the handler records `resolved` once the re-run completes.
 */
const resolutionDirectiveSchema = z.object({
  overrides: z
    .array(z.object({ targetPath: z.string(), choice: z.enum(["source-wins", "target-wins"]) }))
    .default([]),
  deleteOverride: z.object({ choice: z.literal("propagate") }).optional(),
  parkedConflictIds: z.array(z.string()),
  choice: z.enum(["source-wins", "target-wins", "propagate"]),
  resolvedBy: z.string(),
});

/** The parsed SA-4 resolution directive the handler threads into CF + resolves against. */
export interface ResolutionDirective {
  readonly overrides: readonly FieldConflictOverride[];
  readonly deleteOverride?: DeletionConflictOverride;
  readonly parkedConflictIds: readonly string[];
  readonly choice: ParkedConflictResolutionChoice;
  readonly resolvedBy: string;
}

export class SyncPipelineHandler {
  readonly #identityResolution: IdentityResolutionPort;
  readonly #loopPrevention: LoopPreventionPort;
  readonly #conflictDetection: ConflictDetectionPort;
  readonly #transform: ApplyFieldMappingsFn;
  readonly #outbound: OutboundExecutorPort;
  readonly #fieldState: SyncFieldStateGateway;
  readonly #contextLoader: SyncPipelineContextLoader;
  readonly #events: SyncEventRecorder;
  readonly #parkedConflicts: ParkedConflictWriter;
  readonly #scopeLinks: ScopeLinkReader | undefined;
  readonly #clock: () => Date;
  readonly #newId: () => string;
  readonly #readTraceContext: () => StageTraceContext | null;
  readonly #actor: string;

  public constructor(deps: SyncPipelineHandlerDeps, options: SyncPipelineHandlerOptions = {}) {
    this.#identityResolution = deps.identityResolution;
    this.#loopPrevention = deps.loopPrevention;
    this.#conflictDetection = deps.conflictDetection;
    this.#transform = deps.transform;
    this.#outbound = deps.outbound;
    this.#fieldState = deps.fieldState;
    this.#contextLoader = deps.contextLoader;
    this.#events = deps.events;
    this.#parkedConflicts = deps.parkedConflicts;
    this.#scopeLinks = deps.scopeLinks;
    this.#clock = options.clock ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
    this.#readTraceContext = options.readTraceContext ?? ((): null => null);
    this.#actor = options.actor ?? DEFAULT_ACTOR;
  }

  /**
   * The {@link QueueHandler} the ordering-queue dispatcher runs per enqueued change.
   * Resolving = the entry is `done` (a completed pipeline OR a conflict park);
   * throwing = a write failure the dispatcher settles into retry / park / defer.
   */
  public readonly handle: QueueHandler = async (context: QueueHandlerContext): Promise<void> => {
    await this.#run(context);
  };

  async #run(queueContext: QueueHandlerContext): Promise<void> {
    const change = parseDetectedChange(queueContext.payload);
    // SA-4 — a resolution re-run carries the operator's one-shot directive alongside the
    // change (an ordinary queued execution against CURRENT state; CF re-checks drift, EP
    // re-checks echo). Absent on a poll-driven change.
    const directive = parseResolutionDirective(queueContext.payload);
    const context = await this.#contextLoader.load(change);

    // ── Step 3.1: Identity Resolution ─────────────────────────────────────────
    const resolution = await this.#identityResolution.resolve(change, context.resolution);
    switch (resolution.kind) {
      case "ambiguous-failure":
        // RL-4 — the stage recorded a `failure` event with the candidate ids and held
        // the record for manual linking. NEVER auto-link (a wrong identity silently
        // merges records). This is a conflict park: return, done.
        return;
      case "skipped-policy":
        // RL-2.2 (no create op) / RL-5.4 (counterpart deleted) — recorded, visible. Done.
        return;
      case "no-link-delete":
        // A delete of a record the mediator never linked — nothing to route or
        // tombstone. No stage owns this event, so the handler records it. Done.
        await this.#recordSkippedPolicy(
          change,
          "delete of a record with no active RecordLink — nothing to route or tombstone",
        );
        return;
      case "severed-tombstone":
      case "straight-create":
      case "resolved":
        break;
    }

    // ── Step 3.2: Loop Prevention (EP compares against App A's baselines) ──────
    const epOutcome = await this.#loopPrevention.check(
      stripUndefined({
        change,
        context: context.loopPrevention,
        resolution,
        resource: context.sourceResourceRef,
        carriesMediatorWriteTag: context.carriesMediatorWriteTag,
      }),
    );
    switch (epOutcome.kind) {
      case "echo":
        // The echo of the mediator's own write — recorded `skipped-loop`. Done.
        return;
      case "resurrection-prevented":
        // A stale snapshot over a propagated-delete tombstone — recorded `skipped-loop`,
        // not re-created. Done.
        return;
      case "skipped-policy":
        // A change to a survivor whose counterpart was deleted — recorded. Done.
        return;
      case "not-echo":
        break;
    }

    // A `severed-tombstone` always yields a terminal EP outcome above (echo /
    // resurrection-prevented / skipped-policy), so only a create / update / delete of a
    // genuine, non-echo change reaches here.
    if (resolution.kind === "straight-create") {
      await this.#runCreate(change, context);
      return;
    }
    if (resolution.kind === "resolved") {
      if (resolution.effectiveChangeKind === "delete") {
        await this.#runDelete(change, context, resolution.link, directive);
      } else {
        await this.#runUpdate(change, context, resolution.link, directive);
      }
      return;
    }
    throw new Error(
      `sync pipeline: unexpected non-echo outcome for resolution '${resolution.kind}'`,
    );
  }

  // ── Step 3.3: the deletion path ─────────────────────────────────────────────

  async #runDelete(
    change: DetectedChange,
    context: SyncPipelineContext,
    link: RecordLink,
    directive: ResolutionDirective | undefined,
  ): Promise<void> {
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetSide = opposite(sourceSide);

    // SS-12.3/12.4 — resolve the record's stored container ONCE from `RecordLink.scopeRef`
    // (a delete carries no captured scope), so BOTH the `read-before-write` drift-read AND
    // the delete write route to it; an absent/unresolvable container parks for manual
    // container linking (`ContainerUnresolvedError`) rather than a generic transient throw —
    // closing the L2/L3 record-derived-delete gap. A `deletePropagation = ignore` delete
    // reads/writes nothing (it only tombstones), so it needs no container.
    const containerScope =
      context.deletion.deletePropagation === "ignore"
        ? undefined
        : await this.#resolveLinkedContainer(context, change, link);
    // SS-19.3/19.5 — resolve the record's container-relative address ONCE too, for exactly
    // the same reason: a delete has no live source record to read it from, so it comes from
    // the `RecordLink`. Unresolvable → a loud park (never the native id, which inside this
    // container is either absent or a DIFFERENT record). An `ignore` delete addresses
    // nothing, so it needs no address.
    const recordAddress =
      context.deletion.deletePropagation === "ignore"
        ? undefined
        : this.#resolveRecordAddress(context, link, sourceSide);

    const deletion = await this.#conflictDetection.evaluateDeletion(
      stripUndefined({
        change,
        link,
        context: context.deletion,
        // SA-4.3 — the operator's "propagate the drifted delete after all" directive.
        override: directive?.deleteOverride,
        // SS-12.3 — the read-before-write drift-read routes to the stored container.
        resolvedContainerScopeValues: containerScope,
        // SS-19.3 — ...and addresses the record by the same stored address the delete will.
        resolvedRecordAddress: recordAddress,
      }),
    );
    switch (deletion.kind) {
      case "skipped-policy":
        // `deletePropagation = ignore` — CF recorded `skipped-policy`; tombstone the
        // link `observed-delete` (the pair is severed) and stop. Done.
        await this.#identityResolution.processDeletion(link, deletion.tombstoneReason);
        return;
      case "park":
        // The target drifted — CF recorded `conflict`, the link stays `active`, and NO
        // delete call is made (deletes are never auto-resolved against a drifted
        // target). A conflict park: record the structured drifted-delete row (SA-4.1)
        // and stop. A propagate re-run never reaches here (its override yields `delete`).
        await this.#recordDriftedDeletePark(change, link, targetSide, deletion.driftedFields);
        return;
      case "delete":
        break;
    }

    // CF-7.4 — undrifted target (or SA-4.3 propagate override): call the `delete`
    // operation (id filled per `targetIdParamRef` from the `RecordLink`), then tombstone
    // `propagated-delete`.
    //
    // SS-12.3/12.4/12.7 — a **scoped** delete's still-templated container `{…}` is filled
    // from the container resolved above out of the record's stored `RecordLink.scopeRef` (the
    // same container the drift-read used) — whichever layer (L3 `scope-link` or L2 frozen
    // `resolved` values), never a captured scope and never a guessed container.
    const operation = this.#fillScopedWriteOperation(
      this.#requireOperation(context.deleteOperation, "delete"),
      context,
      containerScope,
    );
    const call: OutboundCall = stripUndefined({
      ...this.#commonCall(change, context, operation, link.id),
      action: "delete" as const,
      targetNativeId: targetNativeIdOf(link, sourceSide),
      // SS-19.3 — the id path parameter is filled from this container-relative address when
      // the target has one; `targetNativeId` still keys idempotency (identity, not address).
      targetRecordAddress: recordAddress,
    });
    const result = await this.#outbound.execute(call);
    settleOutboundResult(result); // throws → dispatcher parks / retries / defers

    // On a success OR a skipped-duplicate (a re-run of a delete already propagated),
    // tombstone `propagated-delete` — idempotent; RL-5 recognizes the other side's echo.
    await this.#identityResolution.processDeletion(link, deletion.tombstoneReason);
    // SA-4.3 — a propagate re-run completed: supersede the parked drifted-delete row.
    await this.#resolveDirective(directive);
  }

  // ── Steps 3.4–3.7: the update path (resolved link) ──────────────────────────

  async #runUpdate(
    change: DetectedChange,
    context: SyncPipelineContext,
    link: RecordLink,
    directive: ResolutionDirective | undefined,
  ): Promise<void> {
    // A **create-only** rule (no approved `action = update` operation) records an
    // observed update as `skipped-policy` — visible, never silent — the same opt-in
    // shape as create / delete propagation (`docs/architecture/sync-engine.md` *Change
    // types*; `docs/architecture/data-model.md`). This is the ONLY gate for a
    // create-only rule: unlike create (gated by RL's `hasApprovedCreateOperation`) and
    // delete (guaranteed an op by enablement), the update path has no upstream gate, and
    // this also covers the identity-match downgrade (a create RL resolved against a
    // pre-existing target → an effective update on a create-only rule). It must NOT
    // dead-letter — a park would re-park on every subsequent edit forever.
    if (context.updateOperation === undefined) {
      await this.#recordSkippedPolicy(
        change,
        "no approved action=update OperationMapping — observed update on a create-only rule not propagated",
        link.id,
      );
      return;
    }

    // SS-12.3 — resolve the record's stored container ONCE from `RecordLink.scopeRef`, up
    // front, so BOTH the PUT read-carry (Conflict Detection) AND the update write route to
    // it (not a captured scope); an absent/unresolvable/unsafe container parks for manual
    // container linking (`ContainerUnresolvedError`) before any read/write (SS-12.4).
    const containerScope = await this.#resolveLinkedContainer(context, change, link);

    const now = this.#clock();
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetSide = opposite(sourceSide);
    const observed = requireObserved(change);
    // SS-19.3/19.5 — and the record's container-relative address, resolved ONCE from the
    // `RecordLink` for the same reason the container is: the PUT read-carry and the update
    // write must address the SAME record. Unresolvable → a loud park before either happens.
    const recordAddress = this.#resolveRecordAddress(context, link, sourceSide);

    // Step 3.4a — persist App A's source-side observation into `SyncFieldState` BEFORE
    // CF runs (the hard cross-slice contract: CF reads BOTH sides' observations from
    // persisted state for LWW). Only the observed columns move; each row's reconciled
    // baseline is re-supplied unchanged, so this never disturbs EP's baseline compare.
    await this.#persistSourceObservation(change, context, link, sourceSide, observed, now);

    // Step 3.4b — Conflict Detection produces the per-field write plan. SA-4.2 — a
    // resolution re-run threads the operator's one-shot field overrides INTO CF (an
    // overridden drifted field skips its manual-resolve park / auto-resolution and
    // applies the chosen side; every other CF invariant still holds).
    const cf = await this.#conflictDetection.detect(
      stripUndefined({
        change,
        link,
        context: context.conflict,
        overrides: directive?.overrides,
        // SS-12.3 — the PUT read-carry routes to the stored container, not a captured scope.
        resolvedContainerScopeValues: containerScope,
        // SS-19.3 — ...and addresses the record by the same stored address the write will.
        resolvedRecordAddress: recordAddress,
      }),
    );

    // Read the link's rows once, post-CF: reused for the SA-4 park records (contested
    // side hashes) and OC-2's prior reconciled state.
    const rows = await this.#fieldState.findByLink(link.id);
    // SA-4 — record a structured `parked_conflict` row per withheld field (except a field
    // the operator just resolved via a directive), so the SA-4.1 queue is addressable.
    await this.#recordFieldParks(
      change,
      link,
      cf,
      rows,
      sourceSide,
      targetSide,
      context,
      directive,
    );

    if (cf.kind === "no-call") {
      // Every mapped field withheld — CF recorded the lone `conflict` event; no OC call.
      // A conflict park: done. A target-wins re-run lands here (withheld, no write) —
      // the resolution is complete (baselines untouched), so supersede its parked row.
      await this.#resolveDirective(directive);
      return;
    }
    const writeSet = writeTargetPaths(cf.fields);
    if (writeSet.size === 0) {
      // A `write` outcome with no writable field (an empty mapping) — nothing to send.
      await this.#resolveDirective(directive);
      return;
    }

    // Step 3.5 — Transformation over the CF-approved fields (PATCH omit / PUT read-carry).
    let payload: JsonRecord;
    try {
      payload = this.#buildWritePayload(context.fieldMappings, cf.fields, writeSet, observed);
    } catch (error) {
      await this.#handleTransformFailure(change, link, error); // throws (dead-letter)
      return;
    }

    // OC-2 — feed the prior reconciled state (target-side `lastSyncedHash`es of the
    // written fields) so the idempotency key distinguishes a revert from a duplicate.
    const priorReconciledState = buildPriorReconciledState(rows, targetSide, writeSet);

    // Step 3.6 — the Outbound Call Executor issues the `update`. SS-12.3 — a scoped update
    // routes to the container the record's stored `RecordLink.scopeRef` names (resolved once
    // above, shared with the PUT read-carry), never a captured scope.
    const operation = this.#fillScopedWriteOperation(
      this.#requireOperation(context.updateOperation, "update"),
      context,
      containerScope,
    );
    const call: OutboundCall = stripUndefined({
      ...this.#commonCall(change, context, operation, link.id),
      action: "update" as const,
      payload,
      priorReconciledState,
      targetNativeId: targetNativeIdOf(link, sourceSide),
      // SS-19.3 — as on the delete path: address container-relatively when the target has a
      // confirmed address ref, else fall through to the native id exactly as before.
      targetRecordAddress: recordAddress,
    });
    const result = await this.#outbound.execute(call);
    settleOutboundResult(result); // throws → dispatcher
    if (result.outcome !== "success") {
      // skipped-duplicate — the original delivery already re-baselined; the operator's
      // resolution is effectively applied, so supersede its parked row (idempotent).
      await this.#resolveDirective(directive);
      return;
    }

    // Steps 3.6–3.7 — EP-3 re-baseline ONLY the written fields (a withheld field keeps
    // its untouched baseline) and populate the recently-written cache for App B.
    const writtenFieldMappings = context.fieldMappings.filter((field) =>
      writeSet.has(field.targetPath),
    );
    await this.#loopPrevention.recordWrite(
      this.#buildRecordWriteInput(change, context, {
        recordLinkId: link.id,
        writtenSide: targetSide,
        sourceSide,
        fieldMappings: writtenFieldMappings,
        writtenRepresentation: result.writtenRepresentation,
        observedSource: observed,
        targetNativeId: targetNativeIdOf(link, sourceSide),
      }),
    );
    // SA-4.2 — a source-wins re-run wrote the winning value through the normal path;
    // supersede the parked row now that the re-run completed.
    await this.#resolveDirective(directive);
  }

  // ── Steps 3.6–3.7: the create path (no link yet) ────────────────────────────

  async #runCreate(change: DetectedChange, context: SyncPipelineContext): Promise<void> {
    const observed = requireObserved(change);

    // No link → no baseline → no conflict is possible: CF is skipped for a create. All
    // mapped fields are written.
    let payload: JsonRecord;
    try {
      payload = this.#transform(context.fieldMappings, observed).output;
    } catch (error) {
      await this.#handleTransformFailure(change, undefined, error); // throws
      return;
    }

    // SS-12.2/12.6 — a scoped create's container parameter is filled at composition time
    // from the captured scope's active `ScopeLink`; a still-templated one means no active
    // link resolved → park for manual container linking (never a guessed container).
    const operation = this.#requireCreateContainerResolved(
      this.#requireOperation(context.createOperation, "create"),
      context,
    );
    const call: OutboundCall = {
      ...this.#commonCall(change, context, operation, undefined),
      action: "create",
      payload,
      // A create establishes state — there is no prior reconciled value.
      priorReconciledState: { kind: "none" },
    };
    const result = await this.#outbound.execute(call);
    settleOutboundResult(result); // throws → dispatcher
    if (result.outcome !== "success") {
      return; // skipped-duplicate — the original delivery already established the link.
    }

    // Step 3.6 — capture App B's newly assigned native id and establish the link.
    const createdNativeId = result.writtenRepresentation.createdNativeId;
    if (createdNativeId === undefined) {
      // The create succeeded but the response carried no native id at `nativeIdRef`, so
      // the `RecordLink` cannot be established. Not retryable — park loudly (a config
      // error), never a silent orphan.
      throw new PermanentOutboundError(
        "create succeeded but the response carried no native id (ResourceBinding.nativeIdRef) — cannot establish the RecordLink",
      );
    }
    const link = await this.#identityResolution.recordCreatePropagation(
      change,
      context.resolution,
      createdNativeId,
      // SS-19.3 — freeze the created record's container-relative address onto the new link,
      // so the very next update/delete of this record addresses it inside its container
      // without re-reading a source record that may by then be gone.
      result.writtenRepresentation.createdRecordAddress,
    );

    // Step 3.7 — EP-3 re-baseline both sides from the write response + observed source,
    // and mark App B's resource recently-written so its own next poll doesn't bounce back.
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetSide = opposite(sourceSide);
    await this.#loopPrevention.recordWrite(
      this.#buildRecordWriteInput(change, context, {
        recordLinkId: link.id,
        writtenSide: targetSide,
        sourceSide,
        fieldMappings: context.fieldMappings,
        writtenRepresentation: result.writtenRepresentation,
        observedSource: observed,
        targetNativeId: createdNativeId,
      }),
    );
  }

  // ── shared assembly ─────────────────────────────────────────────────────────

  /**
   * Persist App A's source-side observation. Read the link's current rows, and for
   * every source input field write the current observed hash / timestamp while
   * **re-supplying** the row's existing reconciled baseline unchanged (an
   * `ON CONFLICT DO UPDATE` upsert that moves only the observed columns). A source
   * field never seen before is inserted with its observation and no baseline (a
   * divergent seed — its first change is a conflict by construction).
   */
  async #persistSourceObservation(
    change: DetectedChange,
    context: SyncPipelineContext,
    link: RecordLink,
    sourceSide: SyncFieldStateSide,
    observed: JsonRecord,
    now: Date,
  ): Promise<void> {
    const existingRows = await this.#fieldState.findByLink(link.id);
    const bySideField = new Map<string, SyncFieldState>();
    for (const row of existingRows) {
      bySideField.set(rowKey(row.side, row.fieldPath), row);
    }
    const sourceChangeTs = readChangeTimestamp(observed, context.sourceChangeTimestampRef);
    const paths = sourceInputPaths(context.fieldMappings);
    const rows: SyncFieldState[] = paths.map((path) => {
      const existing = bySideField.get(rowKey(sourceSide, path));
      // Live record → record-relative; `fieldPath` below stays in the stored space.
      const read = readPath(observed, recordRelativePath(path));
      return stripUndefined({
        id: existing?.id ?? this.#newId(),
        recordLinkId: link.id,
        side: sourceSide,
        fieldPath: path,
        // Baseline preserved verbatim (present-together or absent-together) — the
        // observation must not disturb reconciled state before CF.
        lastSyncedHash: existing?.lastSyncedHash,
        lastSyncedAt: existing?.lastSyncedAt,
        observedHash: hashFieldValue(read.present ? read.value : null),
        observedAt: now,
        observedChangeTimestamp: sourceChangeTs,
        lastWrittenByMappingId: existing?.lastWrittenByMappingId,
        // Preserve an existing row's status — never resurrect an `archived` source row
        // to `active`; a fresh (absent) row defaults to `active`.
        status: existing?.status ?? "active",
      });
    });
    if (rows.length > 0) {
      await this.#fieldState.reBaseline(rows);
    }
  }

  /**
   * The target payload for a write, honoring the CF plan: transform only the fields CF
   * approved to write (a withheld field is omitted — the PATCH case), then, for a
   * withheld field CF carried a target value for (the PUT read-carry case), place that
   * **target current value** into the payload so it is preserved, never the contested
   * source value.
   */
  #buildWritePayload(
    fieldMappings: readonly FieldMapping[],
    plans: readonly FieldPlan[],
    writeSet: ReadonlySet<string>,
    source: JsonRecord,
  ): JsonRecord {
    const toTransform = fieldMappings.filter((field) => writeSet.has(field.targetPath));
    const payload = this.#transform(toTransform, source).output; // may throw TransformError (TX-5)
    for (const plan of plans) {
      if (plan.kind !== "withhold") {
        continue;
      }
      const carry = plan.carry;
      if (carry !== undefined && carry.present) {
        // The transform above already wrote record-relative keys — the PUT read-carry
        // must land in the SAME key space, or it would add a second, literal key.
        setPath(payload, recordRelativePath(plan.targetPath), carry.value);
      }
    }
    return payload;
  }

  /**
   * A transform failure (TX-5) is **deterministic** — retrying a bad transform is
   * pointless. Record a `failure` `SyncEvent` (never a corrupted payload) and route it
   * to a dispatcher **park** by throwing a {@link PermanentOutboundError} (via
   * `settleOutboundResult` over OC's permanent disposition). A non-transform error is
   * unexpected and rethrown untouched.
   */
  async #handleTransformFailure(
    change: DetectedChange,
    link: RecordLink | undefined,
    error: unknown,
  ): Promise<never> {
    if (!isTransformError(error)) {
      throw error;
    }
    const result = await this.#outbound.recordTransformFailure(
      stripUndefined({
        targetAppId: change.targetAppId,
        mappingId: change.mappingId,
        sourceNativeId: change.sourceNativeId,
        relatedRuleId: change.ruleId,
        recordLinkId: link?.id,
      }),
      error,
    );
    settleOutboundResult(result); // OC returns a permanent disposition → throws
    // `settleOutboundResult` always throws for a `failure` result; this is unreachable.
    throw new PermanentOutboundError("transform failure was not settled by the executor");
  }

  #buildRecordWriteInput(
    change: DetectedChange,
    context: SyncPipelineContext,
    fields: {
      readonly recordLinkId: string;
      readonly writtenSide: SyncFieldStateSide;
      readonly sourceSide: SyncFieldStateSide;
      readonly fieldMappings: readonly FieldMapping[];
      readonly writtenRepresentation: WrittenRepresentation;
      readonly observedSource: JsonRecord;
      readonly targetNativeId: string;
    },
  ): RecordWriteInput {
    const storedRepresentation = this.#requireStoredRepresentation(fields.writtenRepresentation);
    return stripUndefined({
      recordLinkId: fields.recordLinkId,
      mappingId: change.mappingId,
      writtenSide: fields.writtenSide,
      sourceSide: fields.sourceSide,
      fieldMappings: fields.fieldMappings,
      storedRepresentation,
      observedSource: fields.observedSource,
      writtenRecord: {
        appId: change.targetAppId,
        resource: context.targetResourceRef,
        nativeId: fields.targetNativeId,
      },
      writtenChangeTimestamp: readChangeTimestamp(
        storedRepresentation,
        context.targetChangeTimestampRef,
      ),
      sourceChangeTimestamp: readChangeTimestamp(
        fields.observedSource,
        context.sourceChangeTimestampRef,
      ),
    });
  }

  /** The `OutboundCallCommon` half of a call — the target app, base URL, operation + mapping, ids. */
  #commonCall(
    change: DetectedChange,
    context: SyncPipelineContext,
    operation: ResolvedTargetOperation,
    recordLinkId: string | undefined,
  ): OutboundCallCommon {
    return stripUndefined({
      targetAppId: change.targetAppId,
      baseUrl: context.targetBaseUrl,
      operation: operation.operation,
      operationMapping: operation.operationMapping,
      sourceNativeId: change.sourceNativeId,
      targetResourceNativeIdRef: context.targetResourceNativeIdRef,
      // SS-19 — lets OC read a create response's container-relative address, the same way
      // it reads the new native id. Absent on a native-id-addressed target.
      targetResourceRecordAddressRef: context.targetResourceRecordAddressRef,
      relatedRuleId: change.ruleId,
      recordLinkId,
      targetAppLimits: context.targetAppLimits,
    });
  }

  /**
   * The target's stored representation (the write response body) EP re-baselines from.
   * The no-body follow-up read (EP-3.1) is a deferred composition-slice seam — a
   * success that returns no object representation parks loudly rather than
   * silently skipping the baseline capture.
   */
  #requireStoredRepresentation(representation: WrittenRepresentation): JsonRecord {
    const body = representation.body;
    if (isJsonRecord(body)) {
      return body;
    }
    throw new PermanentOutboundError(
      "write succeeded but returned no object representation to re-baseline from — the no-body follow-up read (EP-3.1) is deferred to the composition slice",
    );
  }

  /**
   * SS-12.3/12.4 — resolve a **linked** record's target container **once** from its stored
   * `RecordLink.scopeRef`, as the `{ parameterName → value }` fill shared by both the
   * read-before-write drift-read / PUT read-carry (threaded into Conflict Detection) **and**
   * the write. Returns `undefined` for a non-scoped rule (no per-record container to fill).
   * Throws a {@link ContainerUnresolvedError} — routed to a dead-letter **container-link
   * park** (never a generic transient, never a guessed container) — when the container is
   * absent / unresolvable, or does not cover every container parameter (an unsafe/absent
   * target key), so both the read and the write route to the same resolved container or the
   * execution parks **before** either happens.
   */
  async #resolveLinkedContainer(
    context: SyncPipelineContext,
    change: DetectedChange,
    link: RecordLink,
  ): Promise<ReadonlyMap<string, string> | undefined> {
    const scopePathBindings = context.scopePathBindings ?? [];
    const containerParams = containerScopeParamNames(scopePathBindings);
    if (containerParams.length === 0) {
      return undefined; // non-scoped / constant-only — nothing to fill per record.
    }
    if (this.#scopeLinks === undefined) {
      throw new ContainerUnresolvedError(
        "a scoped linked write reached the pipeline but no ScopeLink reader is wired",
      );
    }
    const fillValues = await resolveScopeRefFillValues({
      scopeRef: link.scopeRef,
      targetAppId: change.targetAppId,
      scopePathBindings,
      reader: this.#scopeLinks,
    });
    const missing = containerParams.filter((name) => !fillValues.has(name));
    if (missing.length > 0) {
      // An unsafe / absent target container key — never route a read or write to a guessed
      // container; park for manual container linking (SS-12.4).
      throw new ContainerUnresolvedError(
        `could not resolve container parameter(s) [${missing.join(", ")}] from RecordLink.scopeRef — link a container and replay`,
      );
    }
    return fillValues;
  }

  /**
   * SS-19.3/19.5 — the **container-relative address** a linked update/delete addresses the
   * target record by, resolved **once** per execution from the `RecordLink` so the
   * drift-read / PUT read-carry and the write itself address the *same* record.
   *
   * Returns `undefined` for a native-id-addressed target (the caller then falls through to
   * `targetNativeId`, byte-for-byte the pre-SS-19 composition), and throws a
   * {@link RecordAddressUnresolvedError} — a permanent park, never a retry storm — in the
   * two cases where the mediator does not know the address:
   *
   * - the target's `recordAddressRef` is derived but **unconfirmed**, so which of the
   *   record's two identifiers the op addresses by is an open question; and
   * - the ref is confirmed but this link carries **no frozen address** for the target side
   *   (established before the ref was confirmed, or the record never exposed the field).
   *
   * Falling back to the native id here would compose a URL that 404s at best and, at
   * worst, addresses a **different** record that happens to hold that number inside the
   * resolved container. Parking is the only safe answer.
   */
  #resolveRecordAddress(
    context: SyncPipelineContext,
    link: RecordLink,
    sourceSide: SyncFieldStateSide,
  ): string | undefined {
    const addressing = context.targetRecordAddressing ?? { kind: "native-id" };
    switch (addressing.kind) {
      case "native-id":
        return undefined;
      case "unconfirmed-address-ref":
        throw new RecordAddressUnresolvedError(
          "the target resource is container-scoped but its ResourceBinding.recordAddressRef is unconfirmed — confirm which field carries the container-relative record address, then replay",
        );
      case "stored-address": {
        const address = targetRecordAddressOf(link, sourceSide);
        if (address === undefined) {
          throw new RecordAddressUnresolvedError(
            "the RecordLink carries no container-relative address for the target side — it predates the confirmed recordAddressRef; re-link the record (or replay after a fresh backfill), then replay",
          );
        }
        return address;
      }
      default:
        return assertNeverAddressing(addressing);
    }
  }

  /**
   * SS-12.3/12.7 — fill a **linked** write op's still-templated container `{…}` from the
   * container resolved once by {@link #resolveLinkedContainer} (the same one the read used),
   * whichever layer (L3 `scope-link` / L2 frozen `resolved` values). A non-scoped op
   * (`containerScope === undefined`) is returned unchanged; a leftover unfilled container
   * parameter parks (defense-in-depth — the resolution already verified completeness).
   */
  #fillScopedWriteOperation(
    operation: ResolvedTargetOperation,
    context: SyncPipelineContext,
    containerScope: ReadonlyMap<string, string> | undefined,
  ): ResolvedTargetOperation {
    if (containerScope === undefined) {
      return operation;
    }
    const containerParams = containerScopeParamNames(context.scopePathBindings ?? []);
    const filled = fillContainerScopeParams(
      operation.operation.pathTemplate,
      containerParams,
      containerScope,
      // SS-12.5 — the op's record-id path parameter is filled from the `RecordLink`'s native
      // id downstream, never from the container, even when a scope binding shares its name.
      writeRecordIdPathParamName(operation),
    );
    if (filled.unfilled.length > 0) {
      throw new ContainerUnresolvedError(
        `could not fill container parameter(s) [${filled.unfilled.join(", ")}] from RecordLink.scopeRef — link a container and replay`,
      );
    }
    return { ...operation, operation: { ...operation.operation, pathTemplate: filled.path } };
  }

  /**
   * SS-12.2/12.6 — a scoped **create**'s container parameter is filled at composition time
   * from the captured scope's **active** `ScopeLink` (the loader looks it up). A container
   * parameter still templated here means **no active `ScopeLink`** resolved → park for manual
   * container linking (a {@link ContainerUnresolvedError}), never a guessed container. A
   * non-scoped / already-filled create op is returned unchanged.
   */
  #requireCreateContainerResolved(
    operation: ResolvedTargetOperation,
    context: SyncPipelineContext,
  ): ResolvedTargetOperation {
    const containerParams = containerScopeParamNames(context.scopePathBindings ?? []);
    const pathTemplate = operation.operation.pathTemplate;
    const templated = containerParams.filter((name) => pathTemplate.includes(`{${name}}`));
    if (templated.length > 0) {
      throw new ContainerUnresolvedError(
        `create could not resolve container parameter(s) [${templated.join(", ")}] — no active ScopeLink for the captured scope; link a container and replay`,
      );
    }
    return operation;
  }

  #requireOperation(
    operation: ResolvedTargetOperation | undefined,
    action: "create" | "update" | "delete",
  ): ResolvedTargetOperation {
    if (operation === undefined) {
      // A wiring error: the stages gate on the operation existing, so reaching here
      // without one is a config mismatch — permanent, never a retry storm.
      throw new PermanentOutboundError(
        `no resolved ${action} operation for this mapping — the pipeline context is missing it`,
      );
    }
    return operation;
  }

  /** Record the one `SyncEvent` no stage owns — a delete of a record with no active link. */
  async #recordSkippedPolicy(
    change: DetectedChange,
    details: string,
    recordLinkId?: string,
  ): Promise<void> {
    const trace = this.#readTraceContext();
    const entry: AuditLogEntry = stripUndefined({
      id: this.#newId(),
      type: "sync-execution" as const,
      actor: this.#actor,
      status: "skipped-policy" as const,
      relatedRuleId: change.ruleId,
      relatedMappingId: change.mappingId,
      sourceNativeId: change.sourceNativeId,
      originAppId: change.sourceAppId,
      recordLinkId,
      details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
    await this.#events.record(entry);
  }

  /**
   * SA-4 (the CF-review gap) — record a **structured** `parked_conflict` row per field
   * CF withheld under a conflict (`manual-resolve` → kind `manual-resolve`; auto
   * `target-wins` → kind `withheld`), so the operator queue is addressable by
   * `(RecordLink, side, fieldPath)` instead of a prose `details` string. Idempotent by
   * the open key (a re-park updates the open row's contested hashes, never duplicates).
   * A field the operator just resolved via a directive is **not** re-parked. Stores only
   * the two contested sides' `observedHash` — **never** a raw value (data boundary).
   */
  async #recordFieldParks(
    change: DetectedChange,
    link: RecordLink,
    cf: ConflictDetectionOutcome,
    rows: readonly SyncFieldState[],
    sourceSide: SyncFieldStateSide,
    targetSide: SyncFieldStateSide,
    context: SyncPipelineContext,
    directive: ResolutionDirective | undefined,
  ): Promise<void> {
    const resolutions = cf.conflict?.resolutions ?? [];
    if (resolutions.length === 0) {
      return;
    }
    const overridden = new Set((directive?.overrides ?? []).map((override) => override.targetPath));
    const rowMap = new Map(rows.map((row) => [rowKey(row.side, row.fieldPath), row]));
    const targetToSource = new Map(
      context.fieldMappings.map((field) => [field.targetPath, field.sourcePath]),
    );
    const now = this.#clock();
    for (const resolution of resolutions) {
      // A source-wins field was written (not withheld) — nothing to park. A field the
      // operator resolved this execution is superseded, not re-parked.
      if (resolution.outcome === "source-wins" || overridden.has(resolution.targetPath)) {
        continue;
      }
      const kind: ParkedConflictKind =
        resolution.outcome === "manual-park" ? "manual-resolve" : "withheld";
      const sourcePath = targetToSource.get(resolution.targetPath);
      const parked: ParkedConflict = stripUndefined({
        id: this.#newId(),
        recordLinkId: link.id,
        syncRuleId: change.ruleId,
        mappingId: change.mappingId,
        kind,
        side: targetSide,
        fieldPath: resolution.targetPath,
        sourceObservedHash:
          sourcePath !== undefined
            ? rowMap.get(rowKey(sourceSide, sourcePath))?.observedHash
            : undefined,
        targetObservedHash: rowMap.get(rowKey(targetSide, resolution.targetPath))?.observedHash,
        status: "open" as const,
        sourceNativeId: change.sourceNativeId,
        details: `parked ${kind} conflict on target field '${resolution.targetPath}'`,
        createdAt: now,
        updatedAt: now,
      });
      await this.#parkedConflicts.upsertOpenFieldConflict(parked);
    }
  }

  /**
   * SA-4 (CF-7) — record the structured drifted-delete park: the link is left `active`
   * and nothing is deleted; this row is what the operator resolves (propagate / sever).
   * Addresses the whole record (no `fieldPath`); the source record is gone, so there is
   * no source value to hash — only the drifted field paths, as a metadata note.
   */
  async #recordDriftedDeletePark(
    change: DetectedChange,
    link: RecordLink,
    targetSide: SyncFieldStateSide,
    driftedFields: readonly string[],
  ): Promise<void> {
    const now = this.#clock();
    const parked: ParkedConflict = stripUndefined({
      id: this.#newId(),
      recordLinkId: link.id,
      syncRuleId: change.ruleId,
      mappingId: change.mappingId,
      kind: "drifted-delete" as const,
      side: targetSide,
      status: "open" as const,
      sourceNativeId: change.sourceNativeId,
      details: `propagated delete parked — target drifted on ${String(driftedFields.length)} field(s) [${driftedFields.join(", ")}]`,
      createdAt: now,
      updatedAt: now,
    });
    await this.#parkedConflicts.upsertOpenDriftedDelete(parked);
  }

  /**
   * SA-4 — mark the parked_conflict row(s) a resolution re-run referenced `resolved`
   * (superseded) **once the re-run completed** through the pipeline, attributed to the
   * operator (OA-3, threaded on the directive). A no-op when there is no directive; a
   * double-resolve is a safe no-op (the store only resolves an open row).
   */
  async #resolveDirective(directive: ResolutionDirective | undefined): Promise<void> {
    if (directive === undefined) {
      return;
    }
    const resolvedAt = this.#clock();
    for (const id of directive.parkedConflictIds) {
      await this.#parkedConflicts.resolve(id, {
        choice: directive.choice,
        resolvedBy: directive.resolvedBy,
        resolvedAt,
      });
    }
  }
}

// ── module-level pure helpers ─────────────────────────────────────────────────

/** Parse the enqueued payload into a `DetectedChange` — throws a permanent failure on a corrupt one. */
export function parseDetectedChange(payload: Record<string, unknown>): DetectedChange {
  const parsed = changePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // A malformed enqueue is not retryable — park it (never a cast-and-hope).
    throw new PermanentOutboundError(
      `sync pipeline: malformed change payload — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const value = parsed.data;
  return stripUndefined({
    ruleId: value.ruleId,
    mappingId: value.mappingId,
    sourceAppId: value.sourceAppId,
    targetAppId: value.targetAppId,
    resourcePairRef: value.resourcePairRef,
    sourceNativeId: value.sourceNativeId,
    changeKind: value.changeKind,
    observedRecord: value.observedRecord,
    capturedScope: value.capturedScope,
  });
}

/**
 * SA-4 — parse the optional operator resolution directive off the enqueued payload's
 * `resolution` key. Absent → an ordinary poll-driven change (`undefined`). A present but
 * malformed directive is a mediator bug, not a transient fault — parked, never retried.
 */
export function parseResolutionDirective(
  payload: Record<string, unknown>,
): ResolutionDirective | undefined {
  const raw = payload["resolution"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = resolutionDirectiveSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PermanentOutboundError(
      `sync pipeline: malformed resolution directive — ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const value = parsed.data;
  return stripUndefined({
    overrides: value.overrides,
    deleteOverride: value.deleteOverride,
    parkedConflictIds: value.parkedConflictIds,
    choice: value.choice,
    resolvedBy: value.resolvedBy,
  });
}

/** The target-field paths a CF plan writes (vs. withholds). */
function writeTargetPaths(plans: readonly FieldPlan[]): Set<string> {
  const paths = new Set<string>();
  for (const plan of plans) {
    if (plan.kind === "write") {
      paths.add(plan.targetPath);
    }
  }
  return paths;
}

/** The prior reconciled state (OC-2): the written target fields' `lastSyncedHash`es, keyed by path. */
function buildPriorReconciledState(
  rows: readonly SyncFieldState[],
  targetSide: SyncFieldStateSide,
  writeSet: ReadonlySet<string>,
): PriorReconciledState {
  const fieldHashes: Record<string, string> = {};
  for (const row of rows) {
    if (
      row.side === targetSide &&
      row.lastSyncedHash !== undefined &&
      writeSet.has(row.fieldPath)
    ) {
      fieldHashes[row.fieldPath] = row.lastSyncedHash;
    }
  }
  return Object.keys(fieldHashes).length === 0
    ? { kind: "none" }
    : { kind: "reconciled", fieldHashes };
}

/** Every source input path across a direction's field mappings (primary + additional), de-duplicated. */
function sourceInputPaths(fieldMappings: readonly FieldMapping[]): string[] {
  const paths = new Set<string>();
  for (const field of fieldMappings) {
    paths.add(field.sourcePath);
    for (const extra of field.transformConfig?.additionalInputPaths ?? []) {
      paths.add(extra);
    }
  }
  return [...paths];
}

/** The record's target-side native id — the opposite side of the change's source side. */
function targetNativeIdOf(link: RecordLink, sourceSide: SyncFieldStateSide): string {
  return sourceSide === "A" ? link.appBNativeId : link.appANativeId;
}

/**
 * SS-19 — the record's target-side **container-relative address** (the same-side mirror of
 * {@link targetNativeIdOf}), or `undefined` when the link carries none for that side.
 * Addressing only: the link still *correlates* by the native ids above.
 */
function targetRecordAddressOf(
  link: RecordLink,
  sourceSide: SyncFieldStateSide,
): string | undefined {
  return sourceSide === "A" ? link.appBRecordAddress : link.appARecordAddress;
}

/** Exhaustiveness guard for {@link RecordAddressing} — a new kind must be handled. */
function assertNeverAddressing(addressing: never): never {
  throw new PermanentOutboundError(
    `unhandled record addressing kind: ${JSON.stringify(addressing)}`,
  );
}

/**
 * SS-12.5 — this write op's **record-id path parameter** name (the one the Outbound Call
 * Executor fills from the `RecordLink`'s native id), or `undefined` when the op has no id
 * parameter **in its path** (a create carries no `targetIdParamRef`; a query/header id is
 * not a path parameter). Read from the resolved binding's `parameterLocations` keyed by
 * `OperationMapping.targetIdParamRef` — the exact id parameter the executor fills — so the
 * container fill skips it even when a scope binding shares its bare name (`{id}`).
 */
function writeRecordIdPathParamName(operation: ResolvedTargetOperation): string | undefined {
  const idRef = operation.operationMapping.targetIdParamRef;
  if (idRef === undefined) {
    return undefined;
  }
  const location = operation.operation.parameterLocations[idRef];
  return location?.in === "path" ? location.name : undefined;
}

/** Which side of the link the change's source app occupies (mirrors the stages). */
function sideOf(change: DetectedChange, appAId: string): SyncFieldStateSide {
  return change.sourceAppId === appAId ? "A" : "B";
}

function opposite(side: SyncFieldStateSide): SyncFieldStateSide {
  return side === "A" ? "B" : "A";
}

/** `SyncFieldState` map key — an escaped-space separator (never a NUL byte). */
function rowKey(side: SyncFieldStateSide, fieldPath: string): string {
  return `${side} ${fieldPath}`;
}

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + parse a record's change timestamp (epoch millis, or a Date-parseable string); `null` when absent. */
function readChangeTimestamp(record: JsonRecord, ref: string | undefined): Date | null {
  if (ref === undefined) {
    return null;
  }
  const read = readPath(record, ref);
  if (!read.present) {
    return null;
  }
  return toDate(read.value);
}

function toDate(value: JsonValue): Date | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value) : null;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

/** A write/create change must carry its observed record — otherwise the enqueue was corrupt (permanent). */
function requireObserved(change: DetectedChange): JsonRecord {
  if (change.observedRecord === undefined) {
    throw new PermanentOutboundError(
      "sync pipeline: a create/update change reached the write path with no observedRecord",
    );
  }
  return change.observedRecord;
}
