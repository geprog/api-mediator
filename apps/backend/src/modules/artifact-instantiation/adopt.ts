import type { ApprovedMapping, FieldMapping, SyncRule } from "@mediator/domain";

import { canonicalResourcePairRef, resourceRefOf } from "./derive.js";

/**
 * **SL-7/SL-8 — successor adoption orchestration (the sync half + the adapter-half trigger).**
 *
 * Adoption is what a **re-review approval** actually does to everything derived from the
 * stale mapping: rather than starting the relationship over, it replaces the predecessor
 * **in place** across its `SyncRule`s and `AdapterBinding`s and marks the predecessor
 * `superseded`. It runs **only** as a consequence of the successor's `MappingApproved`
 * (SL-7.2 — the safety promise: never without a human approval), hooked in the
 * `MappingApproved` consumer when the approved mapping carries a `predecessorMappingId`.
 *
 * **Two transaction boundaries, composed for consistency (SL-8.6).** The **adapter half**
 * drives the already-built CO-7 `AdapterCompositionService.adoptSuccessor`, which owns its
 * **own** transaction: it re-points the predecessor's `AdapterBinding`s, re-validates each
 * affected endpoint's composition against the successor's (already-committed) content, flags
 * `composition-required` where an assumption broke, recomputes the adapter `GraphEdge`, and
 * drops the endpoints' caches. The **sync half** runs on the dispatcher transaction the
 * consumer handler already holds (re-point `SyncRule`s, supersede the predecessor, transfer
 * the counterpart, recompute the sync `GraphEdge`). The two are separate transactions, so a
 * partial failure is possible — the adapter half committing while the sync half rolls back,
 * or a `composition-required` flag alongside a successful sync re-point — and that outcome is
 * **consistent and recoverable**, never a silently half-adopted mapping: both re-points are
 * **idempotent** (a binding/rule already on the successor no longer matches the predecessor),
 * so a `MappingApproved` redelivery (and, later, RC-3's adoption reconciliation) re-derives
 * the missing side. A `composition-required` flag is a valid, recoverable outcome — not a
 * failure — exactly as at first composition.
 *
 * **Ordering.** The adapter half is driven **first** (its own transaction commits before the
 * sync half writes) so its transaction never contends with the dispatcher transaction's rows,
 * and it reads only committed state (the successor's carried-forward content, committed at
 * approval — SL-7.6). The sync half then re-points on the dispatcher handle.
 *
 * **Variant exclusivity.** A peer-peer mapping owns only `SyncRule`s (no bindings), a
 * consumer-provider mapping only `AdapterBinding`s (no rules) — the same construction-time
 * invariant `instantiateArtifacts` relies on — so each half is driven for the variant it
 * applies to; the predecessor is superseded either way.
 *
 * **Sync operational state (SL-8).** The re-point moves only `approvedMappingId`, so every
 * re-pointed rule **keeps** its cursor, snapshot, backfill status, and enablement (SL-8.1) —
 * the operational state describes the *relationship*, which persisted through re-review. The
 * rule's `pollOperationRef` re-validation is SL-8.2: a still-valid ref keeps its cursor and
 * snapshot untouched (the re-point does not touch them), and a poll operation the breaking
 * change *changed* was already returned to unconfirmed at SL-4/SL-5 (pausing the rule) and is
 * re-confirmed by the operator through `SyncRuleRepository.reconfirmPollOperation`, which
 * clears the cursor and rebuilds the snapshot on a changed operation — adoption itself never
 * auto-reconfirms a ref. `RecordLink`s and `SyncFieldState` are app-pair-scoped (keyed by the
 * direction-agnostic `resourcePairRef`), so adoption severs no link and re-correlates no
 * record (SL-8.3): they are untouched here.
 *
 * **`SyncFieldState` added-field-pair seeding (SL-8.5) is performed by an ASYNC link-only
 * backfill this adoption ENQUEUES — never inline in this synchronous, pure-database
 * transaction.** A field pair the successor **adds** (present in the successor, absent in the
 * predecessor by `(sourcePath, targetPath, phase)` identity) has no `SyncFieldState` baseline
 * over the pre-existing `RecordLink`s, so Conflict Detection would read its absent baseline as
 * `drifted` → target-wins-withhold, and the added field would never propagate and would
 * spuriously conflict on every sync until a link-only backfill seeds it. Seeding it here is
 * impossible: a baseline requires the field's **observed value** (`SyncFieldState.observedHash`/
 * `observedAt`), which only a live fetch produces — not synthesizable in a DB transaction. So
 * for each re-pointed `SyncRule` whose successor adds a field pair concerning that rule's
 * resource pair, adoption enqueues an **async, scoped, link-only backfill** (reusing the
 * enablement backfill path — {@link SuccessorAdoptionDeps.seedAddedFieldBaselines}): a link-only
 * pass over the **existing** `RecordLink`s that seeds baselines. It is **safe and idempotent**:
 * `SyncFieldStateStore.seed` **never erases** an existing baseline, so re-running a link-only
 * backfill over the existing links seeds ONLY the added fields (every already-seeded pair is a
 * no-op), a redelivered adoption re-enqueues without double-seeding, and a rule with **no** added
 * field pair enqueues nothing. It is a **seed pass, not a re-enable**: enablement / cursor /
 * snapshot are untouched, and it is **link-only, never a push re-backfill** (SL-8.5 — "no full
 * re-backfill"). The seeding backfill resolves against the **successor** mapping (committed at
 * approval), so it is independent of when this transaction's re-point commits.
 *
 * **`SyncFieldState` dropped-field archiving (SL-8.4) remains a deferred follow-up**, because
 * `SyncFieldState` is shared by **both** peer directions over a resource pair, so archiving a
 * field the successor dropped is only correct once the reverse direction's surviving mapping is
 * consulted (else a still-live baseline is wrongly archived); the adoption above establishes the
 * successor as the live relationship that later reconciliation pass reconciles.
 */

/**
 * The sync-side persistence the adoption drives, bound to the consumer's **dispatcher
 * transaction** so the re-point + supersede + counterpart transfer + graph recompute commit
 * atomically with the `processed_event` ledger. A narrow port (not the concrete repositories)
 * so the adoption is unit-testable against an in-memory fake mirroring these exact semantics.
 */
export interface AdoptionSyncOps {
  /** Load an `ApprovedMapping` by id (the predecessor, to read its counterpart pairing). */
  getApprovedMapping(id: string): Promise<ApprovedMapping | undefined>;
  /**
   * SL-8.5 — the predecessor's `FieldMapping`s, so adoption can determine which field pairs the
   * successor **adds** (present in the successor, absent in the predecessor) and enqueue a seeding
   * link-only backfill only for the rules those added pairs concern.
   */
  listFieldMappings(mappingId: string): Promise<readonly FieldMapping[]>;
  /**
   * SL-7.1/8.1 — re-point every `SyncRule` on the predecessor to the successor, changing
   * **only** `approvedMappingId` (cursor/snapshot/backfill/enablement retained). Returns the
   * re-pointed rules (empty for a consumer-provider predecessor, or an already-adopted one).
   */
  repointSyncRulesToSuccessor(
    supersededMappingId: string,
    successorMappingId: string,
  ): Promise<readonly SyncRule[]>;
  /** SL-7.1 — mark the predecessor `superseded` (retained for audit, never executed again). */
  markSuperseded(id: string): Promise<void>;
  /** SL-7.3 — set (or clear) a mapping's `counterpartMappingId` (transfer the pairing). */
  setCounterpart(id: string, counterpartMappingId: string | null): Promise<void>;
  /**
   * SL-7.6/7.7 — recompute the `(sourceApp → targetApp)` sync `GraphEdge` from its current
   * rule aggregate, within the dispatcher transaction, so the re-pointed rules (now under the
   * active successor) are reflected rather than the paused/stale predecessor.
   */
  recomputeSyncEdge(sourceAppId: string, targetAppId: string): Promise<void>;
}

/**
 * SL-7.5 — drive CO-7 `AdapterCompositionService.adoptSuccessor` (the adapter half) in its
 * own transaction. Injected (rather than importing the service) so the consumer stays a pure
 * event reactor and the adoption is unit-testable with a fake.
 */
export type AdapterSuccessorAdopter = (
  input: { readonly supersededMappingId: string; readonly successorMappingId: string },
  actor: string,
) => Promise<void>;

/**
 * SL-8.5 — enqueue an **async, scoped, link-only backfill** that seeds the baselines of the
 * field pairs the successor **added**, over the rule's **existing** `RecordLink`s. Injected
 * (rather than importing the Sync Engine runtime) so the consumer stays a pure event reactor:
 * production wires it to `SyncBackground.seedAddedFieldBaselines`, which resolves the backfill
 * against the **successor** mapping (committed at approval) and runs it in the background — so it
 * is decoupled from when the adoption transaction's re-point commits. **Fire-and-forget** (the
 * seeding must never block or fail the dispatcher transaction): it cannot be run inline because a
 * baseline needs the field's live observed value. Absent → no seeding is enqueued (a harness that
 * does not wire the sync runtime); a redelivered adoption re-enqueues safely (seed-never-erases).
 */
export type AddedFieldBaselineSeeder = (input: {
  readonly ruleId: string;
  readonly successorMappingId: string;
}) => void;

/** The injected adoption capability the `MappingApproved` consumer runs on a successor. */
export interface SuccessorAdoptionDeps<TTx> {
  /** Build the sync-side ops bound to the dispatcher transaction handle. */
  readonly syncOps: (tx: TTx) => AdoptionSyncOps;
  /** Drive the adapter half (CO-7) — its own transaction (SL-7.5). */
  readonly adoptAdapter: AdapterSuccessorAdopter;
  /**
   * SL-8.5 — enqueue the async link-only backfill that seeds an added field pair's baselines
   * over existing `RecordLink`s. Optional: absent → no seeding (a Phase-1..5 harness without the
   * sync runtime, where a successor cannot arise anyway).
   */
  readonly seedAddedFieldBaselines?: AddedFieldBaselineSeeder;
}

/**
 * Run successor adoption for one approved successor (see the module doc). The `successor` is
 * the just-approved `ApprovedMapping` carrying a `predecessorMappingId`; `successorFields` are
 * its persisted `FieldMapping`s (the SL-7.6 carry-forward union, already loaded by the consumer)
 * — used to detect the field pairs the successor added for the SL-8.5 seeding; `tx` is the
 * consumer's dispatcher transaction handle the sync half writes through.
 */
export async function adoptSuccessor<TTx>(params: {
  readonly successor: ApprovedMapping;
  readonly predecessorMappingId: string;
  readonly successorFields: readonly FieldMapping[];
  readonly deps: SuccessorAdoptionDeps<TTx>;
  readonly tx: TTx;
}): Promise<void> {
  const { successor, predecessorMappingId, successorFields, deps, tx } = params;
  // The human who approved the successor is the actor the adoption (and its adapter-side
  // audit row) is attributed to — adoption is the ordinary consequence of that approval.
  const actor = successor.approvedBy;

  if (successor.variant === "consumer-provider") {
    // SL-7.5 — adapter half FIRST, in CO-7's own committed transaction (reads the successor's
    // committed content; never contends with the dispatcher transaction below).
    await deps.adoptAdapter(
      { supersededMappingId: predecessorMappingId, successorMappingId: successor.id },
      actor,
    );
  }

  const syncOps = deps.syncOps(tx);

  if (successor.variant === "peer-peer") {
    // SL-7.1/8.1 — re-point the predecessor's SyncRules to the successor (only
    // approvedMappingId; every operational column retained).
    const repointed = await syncOps.repointSyncRulesToSuccessor(predecessorMappingId, successor.id);
    // SL-7.3 — transfer the counterpart pairing to the successor. Read the predecessor's
    // CURRENT counterpart (the reverse direction's own adoption may already have handed it
    // off), and skip a counterpart that is itself gone/superseded (SL-7.3 "updated/cleared").
    await transferCounterpart(successor, predecessorMappingId, syncOps);
    // SL-7.6/7.7 — reflect the re-pointed rules in the sync GraphEdge (only when the re-point
    // moved a rule; a no-op adoption leaves the edge as-is).
    if (repointed.length > 0) {
      await syncOps.recomputeSyncEdge(successor.sourceAppId, successor.targetAppId);
    }
    // SL-8.5 — for each re-pointed rule whose successor ADDS a field pair (concerning that
    // rule's resource pair), enqueue an async link-only backfill that seeds the added field's
    // baselines over the existing RecordLinks (see the module doc). No added pair → nothing.
    await enqueueAddedFieldBaselineSeeds({
      successor,
      predecessorMappingId,
      successorFields,
      repointedRules: repointed,
      deps,
      syncOps,
    });
  }

  // SL-7.1 — the stale predecessor becomes `superseded` (both variants): retained for audit,
  // never executed again — its rules/bindings now point at the successor.
  await syncOps.markSuperseded(predecessorMappingId);
}

/**
 * SL-7.3 — move the peer pair's `counterpartMappingId` onto the successor. The predecessor's
 * counterpart pointer is read live (the reverse direction's adoption may have handed it off
 * already); a counterpart that is itself `superseded`/`archived` is not linked (the pairing
 * is left cleared for that side until the reverse direction is re-reviewed).
 */
async function transferCounterpart(
  successor: ApprovedMapping,
  predecessorMappingId: string,
  syncOps: AdoptionSyncOps,
): Promise<void> {
  const predecessor = await syncOps.getApprovedMapping(predecessorMappingId);
  const counterpartId = predecessor?.counterpartMappingId ?? null;
  if (counterpartId === null) {
    return;
  }
  const counterpart = await syncOps.getApprovedMapping(counterpartId);
  if (
    counterpart === undefined ||
    counterpart.status === "superseded" ||
    counterpart.status === "archived"
  ) {
    // The counterpart is gone or already superseded — leave the successor's pairing cleared
    // (the reverse direction's own adoption re-links to the successor when it runs).
    return;
  }
  await syncOps.setCounterpart(successor.id, counterpartId);
  await syncOps.setCounterpart(counterpartId, successor.id);
}

/**
 * SL-8.5 — enqueue a scoped, link-only seeding backfill for each re-pointed rule whose successor
 * **adds** a field pair the predecessor did not have. Reads the predecessor's fields (through the
 * dispatcher tx), computes the added field pairs against the successor's fields, and — for every
 * re-pointed rule whose resource pair an added pair concerns — fires the injected async seeder.
 * A no-op when no seeder is wired, no rule was re-pointed, or the successor adds no field pair.
 */
async function enqueueAddedFieldBaselineSeeds<TTx>(params: {
  readonly successor: ApprovedMapping;
  readonly predecessorMappingId: string;
  readonly successorFields: readonly FieldMapping[];
  readonly repointedRules: readonly SyncRule[];
  readonly deps: SuccessorAdoptionDeps<TTx>;
  readonly syncOps: AdoptionSyncOps;
}): Promise<void> {
  const seed = params.deps.seedAddedFieldBaselines;
  if (seed === undefined || params.repointedRules.length === 0) {
    return;
  }
  const predecessorFields = await params.syncOps.listFieldMappings(params.predecessorMappingId);
  const rulesToSeed = rulesWithAddedFieldPairs({
    successor: params.successor,
    predecessorFields,
    successorFields: params.successorFields,
    repointedRules: params.repointedRules,
  });
  for (const rule of rulesToSeed) {
    seed({ ruleId: rule.id, successorMappingId: params.successor.id });
  }
}

/**
 * SL-8.5 — the re-pointed rules whose resource pair the successor **added** at least one field
 * pair for. A field pair is "added" when its `(sourcePath, targetPath, phase)` identity is present
 * in the successor's fields but absent in the predecessor's — so a carried-forward field (SL-7.6,
 * same paths/phase as the predecessor's, only a fresh id) is **not** counted as added, and a
 * retargeted field (a new target path) **is**. Each added field is mapped to its canonical,
 * direction-agnostic `resourcePairRef` (the SAME canonicalization `derivePeerPeerArtifacts` used to
 * build the rule's ref), and a re-pointed rule is selected iff its ref is among them.
 */
function rulesWithAddedFieldPairs(params: {
  readonly successor: ApprovedMapping;
  readonly predecessorFields: readonly FieldMapping[];
  readonly successorFields: readonly FieldMapping[];
  readonly repointedRules: readonly SyncRule[];
}): readonly SyncRule[] {
  const predecessorKeys = new Set(params.predecessorFields.map(fieldPairIdentity));
  const addedResourcePairRefs = new Set<string>();
  for (const field of params.successorFields) {
    if (predecessorKeys.has(fieldPairIdentity(field))) {
      continue;
    }
    addedResourcePairRefs.add(
      canonicalResourcePairRef(
        { appId: params.successor.sourceAppId, resourceRef: resourceRefOf(field.sourcePath) },
        { appId: params.successor.targetAppId, resourceRef: resourceRefOf(field.targetPath) },
      ),
    );
  }
  if (addedResourcePairRefs.size === 0) {
    return [];
  }
  return params.repointedRules.filter((rule) => addedResourcePairRefs.has(rule.resourcePairRef));
}

/**
 * The field-pair identity for the SL-8.5 added-vs-existing comparison: `(sourcePath, targetPath,
 * phase)`. A collision-free JSON tuple (never a NUL-byte join); `phase` collapses to `null` when
 * absent (a peer-peer / request field), so identical peer fields on both sides match.
 */
function fieldPairIdentity(field: FieldMapping): string {
  return JSON.stringify([field.sourcePath, field.targetPath, field.phase ?? null]);
}
