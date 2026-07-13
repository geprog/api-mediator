import { randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AuditLogEntry,
  FieldMapping,
  IrRefTarget,
  OperationMapping,
  OutboundLoadLimits,
  RecordLink,
  SyncFieldState,
  SyncFieldStateSide,
  TombstoneReason,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
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
  type DetectedChange,
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

import { PermanentOutboundError, settleOutboundResult } from "./errors.js";
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

export class SyncPipelineHandler {
  readonly #identityResolution: IdentityResolutionPort;
  readonly #loopPrevention: LoopPreventionPort;
  readonly #conflictDetection: ConflictDetectionPort;
  readonly #transform: ApplyFieldMappingsFn;
  readonly #outbound: OutboundExecutorPort;
  readonly #fieldState: SyncFieldStateGateway;
  readonly #contextLoader: SyncPipelineContextLoader;
  readonly #events: SyncEventRecorder;
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
        await this.#recordNoLinkDelete(change);
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
        await this.#runDelete(change, context, resolution.link);
      } else {
        await this.#runUpdate(change, context, resolution.link);
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
  ): Promise<void> {
    const deletion = await this.#conflictDetection.evaluateDeletion({
      change,
      link,
      context: context.deletion,
    });
    switch (deletion.kind) {
      case "skipped-policy":
        // `deletePropagation = ignore` — CF recorded `skipped-policy`; tombstone the
        // link `observed-delete` (the pair is severed) and stop. Done.
        await this.#identityResolution.processDeletion(link, deletion.tombstoneReason);
        return;
      case "park":
        // The target drifted — CF recorded `conflict`, the link stays `active`, and NO
        // delete call is made (deletes are never auto-resolved against a drifted
        // target). A conflict park: done.
        return;
      case "delete":
        break;
    }

    // CF-7.4 — undrifted target: call the `delete` operation (id filled per
    // `targetIdParamRef` from the `RecordLink`), then tombstone `propagated-delete`.
    const operation = this.#requireOperation(context.deleteOperation, "delete");
    const sourceSide = sideOf(change, context.resolution.appAId);
    const call: OutboundCall = {
      ...this.#commonCall(change, context, operation, link.id),
      action: "delete",
      targetNativeId: targetNativeIdOf(link, sourceSide),
    };
    const result = await this.#outbound.execute(call);
    settleOutboundResult(result); // throws → dispatcher parks / retries / defers

    // On a success OR a skipped-duplicate (a re-run of a delete already propagated),
    // tombstone `propagated-delete` — idempotent; RL-5 recognizes the other side's echo.
    await this.#identityResolution.processDeletion(link, deletion.tombstoneReason);
  }

  // ── Steps 3.4–3.7: the update path (resolved link) ──────────────────────────

  async #runUpdate(
    change: DetectedChange,
    context: SyncPipelineContext,
    link: RecordLink,
  ): Promise<void> {
    const now = this.#clock();
    const sourceSide = sideOf(change, context.resolution.appAId);
    const targetSide = opposite(sourceSide);
    const observed = requireObserved(change);

    // Step 3.4a — persist App A's source-side observation into `SyncFieldState` BEFORE
    // CF runs (the hard cross-slice contract: CF reads BOTH sides' observations from
    // persisted state for LWW). Only the observed columns move; each row's reconciled
    // baseline is re-supplied unchanged, so this never disturbs EP's baseline compare.
    await this.#persistSourceObservation(change, context, link, sourceSide, observed, now);

    // Step 3.4b — Conflict Detection produces the per-field write plan.
    const cf = await this.#conflictDetection.detect({ change, link, context: context.conflict });
    if (cf.kind === "no-call") {
      // Every mapped field withheld — CF recorded the lone `conflict` event; no OC call.
      // A conflict park: done.
      return;
    }
    const writeSet = writeTargetPaths(cf.fields);
    if (writeSet.size === 0) {
      // A `write` outcome with no writable field (an empty mapping) — nothing to send.
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
    const rows = await this.#fieldState.findByLink(link.id);
    const priorReconciledState = buildPriorReconciledState(rows, targetSide, writeSet);

    // Step 3.6 — the Outbound Call Executor issues the `update`.
    const operation = this.#requireOperation(context.updateOperation, "update");
    const call: OutboundCall = {
      ...this.#commonCall(change, context, operation, link.id),
      action: "update",
      payload,
      priorReconciledState,
      targetNativeId: targetNativeIdOf(link, sourceSide),
    };
    const result = await this.#outbound.execute(call);
    settleOutboundResult(result); // throws → dispatcher
    if (result.outcome !== "success") {
      return; // skipped-duplicate — the original delivery already re-baselined.
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

    const operation = this.#requireOperation(context.createOperation, "create");
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
      const read = readPath(observed, path);
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
        status: "active" as const,
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
        setPath(payload, plan.targetPath, carry.value);
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
  async #recordNoLinkDelete(change: DetectedChange): Promise<void> {
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
      details: "delete of a record with no active RecordLink — nothing to route or tombstone",
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#clock(),
    });
    await this.#events.record(entry);
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
