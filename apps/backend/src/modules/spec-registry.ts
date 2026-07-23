import { randomUUID } from "node:crypto";

import type {
  DetectionJobScope,
  ReReviewResourcePair,
  ReReviewScope,
  ReReviewStaleMappingScope,
} from "@mediator/db";
import type {
  ApiSpec,
  ApiSpecRole,
  AppCapabilities,
  ApprovedMapping,
  AuditLogEntry,
  FieldMapping,
  Ir,
  OperationMapping,
  ResourceBinding,
  ScopeCorrespondence,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import { createSpecIngested } from "@mediator/event-bus";
import {
  buildIr,
  computeContentHash,
  deriveResourceBindings,
  diffSpec,
  revalidateResourceBinding,
  type RevalidatableRefName,
  type ScopeCorrespondenceSide,
  type SpecDiff,
} from "@mediator/ir";

import type { EndpointCacheInvalidator, TxStores } from "./persistence.js";
import { parseResourcePairRef } from "./sync/resolution.js";

/**
 * A spec that has already been parsed to its IR + content hash, ready to persist
 * without re-parsing. The registration orchestration pre-parses every submitted
 * document (to fail fast before any write — AR-1 crit 7) and then hands the
 * built artifacts here, so a large spec is parsed exactly once.
 */
export interface IngestArgs {
  readonly document: Record<string, unknown>;
  readonly ir: Ir;
  readonly contentHash: string;
  readonly role: ApiSpecRole;
  readonly analysisExclusions: string[];
  readonly capabilities: AppCapabilities;
}

/** Raised when {@link SpecRegistry.ingestSpec} is called for an unknown app. */
export class UnknownAppError extends Error {
  public constructor(appId: string) {
    super(`Cannot ingest a spec for unknown app ${appId}.`);
    this.name = "UnknownAppError";
  }
}

/**
 * Raised when {@link SpecRegistry.ingestNewVersion} is called for a `(app, role)`
 * lineage that has no `active` spec yet. Version advance requires a prior version to
 * diff against and supersede; the first-ever (v1) ingestion of a lineage is
 * {@link SpecRegistry.ingestSpec}'s path (Phase 1), not this one.
 */
export class NoActiveSpecError extends Error {
  public constructor(appId: string, role: ApiSpecRole) {
    super(`App ${appId} has no active ${role} spec to advance from.`);
    this.name = "NoActiveSpecError";
  }
}

/**
 * **SL-1 — the outcome of re-ingesting a document for an existing lineage.** A
 * discriminated union, not optional-field soup, so the caller handles both branches
 * exhaustively:
 *
 * - `"unchanged"` — an identical re-submission (same `contentHash`) of the already-
 *   active version (SL-1.5): **no** new version was created and **no** `diff` was
 *   computed, so nothing downstream should react.
 * - `"advanced"` — the lineage's active version advanced: `newSpec` is the new
 *   `active` version, `supersededSpec` is the prior version now `superseded`, and
 *   `diff` is the one classification (SL-1.6) the additive/breaking reactions
 *   (SL-2…SL-6) read instead of re-diffing.
 */
export type SpecReingestOutcome =
  | { readonly kind: "unchanged"; readonly activeSpec: ApiSpec }
  | {
      readonly kind: "advanced";
      readonly newSpec: ApiSpec;
      readonly supersededSpec: ApiSpec;
      readonly diff: SpecDiff;
    };

/**
 * The Spec Registry's Phase-1 responsibility: parse an OpenAPI document into the
 * IR, store it as `ApiSpec` version 1, derive its unconfirmed `ResourceBinding`s,
 * and emit `SpecIngested` — all in the caller's transaction (SI-1/SI-2, RB-1,
 * EB-1). See `docs/architecture/overview.md` *Key interfaces*
 * (`SpecRegistry.ingestSpec`).
 *
 * The registry itself holds no state and no persistence: every method takes a
 * {@link TxStores} — the tx-bound repositories + event emit — so all its DB work
 * and the emit are one atomic unit with whatever else the transaction is doing.
 */
export class SpecRegistry {
  /**
   * The documented `SpecRegistry.ingestSpec` interface: `buildIr` →
   * `computeContentHash` → create `ApiSpec` v1 → derive `ResourceBinding`s →
   * emit `SpecIngested`, all in `tx`. Capabilities (needed to derive the
   * capability-gated refs) are read from the already-persisted owning app.
   *
   * The registration orchestration does not call this — it pre-parses to fail
   * fast and then calls {@link persistIngestedSpec} directly (single parse). This
   * method is the self-contained entry point for standalone/single-spec
   * ingestion (and the Phase-6 re-ingestion path).
   */
  public async ingestSpec(
    appId: string,
    document: Record<string, unknown>,
    role: ApiSpecRole,
    analysisExclusions: string[],
    tx: TxStores,
  ): Promise<ApiSpec> {
    const app = await tx.registeredApps.getById(appId);
    if (app === undefined) {
      throw new UnknownAppError(appId);
    }
    const ir = await buildIr(document);
    const contentHash = computeContentHash(document);
    return this.persistIngestedSpec(
      appId,
      { document, ir, contentHash, role, analysisExclusions, capabilities: app.capabilities },
      tx,
    );
  }

  /**
   * Persist an already-parsed spec: create `ApiSpec` version 1 (`status=active`),
   * derive + persist its unconfirmed `ResourceBinding`s (RB-1), and emit exactly
   * one `SpecIngested` for it (EB-1) — every step on the passed transaction.
   */
  public async persistIngestedSpec(
    appId: string,
    args: IngestArgs,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const spec: ApiSpec = {
      id: randomUUID(),
      appId,
      role: args.role,
      rawDocument: args.document,
      parsedIR: args.ir,
      analysisExclusions: args.analysisExclusions,
      version: 1,
      contentHash: args.contentHash,
      status: "active",
      createdAt: new Date(),
    };
    const created = await tx.apiSpecs.create(spec);

    const bindings = deriveResourceBindings(args.ir, args.capabilities, created.id);
    await tx.resourceBindings.createMany(bindings);

    await tx.emit(
      createSpecIngested({ apiSpecId: created.id, appId: created.appId, role: created.role }),
    );

    return created;
  }

  /**
   * **SL-1.2/1.3/1.4 — the documented `SpecRegistry.diffSpec` interface**
   * (`docs/architecture/overview.md`), delegating to the pure `@mediator/ir`
   * classifier. Protocol-agnostic (over the IR, no OpenAPI logic) and side-effect
   * free; the version-advance orchestration below computes it once and hands it on.
   */
  public diffSpec(oldIr: Ir, newIr: Ir): SpecDiff {
    return diffSpec(oldIr, newIr);
  }

  /**
   * **SL-1 — advance a `(app, role)` spec lineage to a newly-ingested document and
   * classify what changed.** For a lineage that already has an `active` `ApiSpec`
   * (the first-ever v1 ingestion is {@link ingestSpec}'s Phase-1 path):
   *
   * 1. **Content-hash no-op (SL-1.5)** — an identical re-submission (same
   *    `contentHash` as the active version) creates no new version and computes no
   *    diff: `{ kind: "unchanged" }`. Nothing downstream reacts.
   * 2. **Version advance (SL-1.1)** — otherwise the document is parsed to IR, stored
   *    as a **new** `ApiSpec` version (`active`, `version + 1`), and the prior active
   *    version is marked `superseded`, so the lineage's active version advances.
   * 3. **Diff (SL-1.2/1.6)** — the `SpecDiff` between the prior active IR and the new
   *    IR is computed **once** and returned in the `"advanced"` outcome, for the
   *    SL-2…SL-6 reactions to read.
   *
   * 4. **Additive reaction (SL-2)** — when the diff classifies **additive**, the
   *    deterministic re-pin + carry-forward runs in this same transaction (see
   *    {@link applyAdditiveReaction}): every `active` `ApprovedMapping` pinned to the
   *    now-`superseded` version is re-pinned to the new one (audit-logged), and the
   *    prior version's `ResourceBinding`s + `analysisExclusions` carry forward, with
   *    anything the new IR no longer resolves dropped. Nothing that executes changes,
   *    so no mapping is set `stale` and no human review is required.
   *
   * 5. **Scoped delta trigger (SL-3)** — when the additive diff added genuinely-new
   *    **in-scope** elements, the intent to run a **scoped** delta analysis is recorded
   *    in this same transaction (a `mapping_detection_job` carrying a
   *    {@link DetectionJobScope}); the analysis itself runs later in the worker, off this
   *    transaction (DT-2). The delta becomes an **ordinary** `MappingProposal` reviewed
   *    through the Phase-3 flow — nothing is auto-approved (SL-3.3).
   *
   * 6. **Breaking reaction (SL-4 + SL-5)** — when the diff classifies **breaking**, the
   *    {@link applyBreakingReaction} runs in this same transaction: **only** the mappings
   *    that reference a changed element go `status = stale` (staying pinned to their
   *    reviewed/superseded version — SL-4.3), every mapping referencing no changed
   *    element re-pins exactly as the additive case (SL-2), the version's exclusions +
   *    bindings carry forward, and — coupled — each stale endpoint's cache is dropped
   *    (XI-2) and each affected `GraphEdge` recomputes (GR-2/GR-3). A stale mapping's
   *    `SyncRule`s pause and its `AdapterBinding`s fail `mapping-stale` as derived
   *    conditions (nothing writes their `status`). The same breaking diff **re-validates
   *    the spec's operational refs** (**SL-5**): the carried-forward `ResourceBinding`s are
   *    re-validated in place (a broken bound ref is RETAINED but returned to unconfirmed —
   *    the additive path drops, the breaking path retains), a `SyncRule.pollOperationRef`
   *    pinned to a now-gone source operation is returned to unconfirmed, and each scoped
   *    resource pair's `ScopeCorrespondence` / `ScopeLink`s are re-validated — every
   *    consequence a paused rule (a **derived** condition; nothing writes a rule status).
   *
   * 7. **Scoped re-review trigger (SL-6)** — when the breaking diff marked mappings `stale`
   *    (step 6), the intent to run each stale mapping's **scoped re-review** is recorded in
   *    this same transaction: **one** `mapping_detection_job` carrying a `re-review`
   *    {@link DetectionJobScope} with a per-stale-mapping descriptor (its id + the affected
   *    resource pairs). The detail-only LLM analysis runs later in the worker, off this
   *    transaction (DT-2), producing each stale mapping's **successor** proposal for ordinary
   *    Phase-3 re-review — nothing is auto-approved.
   *
   * **No `SpecIngested` is emitted** on any branch (that event triggers a *full* detection
   * analysis; the SL-2…SL-6 reactions are the diff's scoped consumers instead). Deliberately
   * **out of scope here** (owned by SL-7/SL-8): **adopting** an approved successor
   * (re-pointing rules/bindings, superseding the stale row).
   */
  public async ingestNewVersion(
    appId: string,
    document: Record<string, unknown>,
    role: ApiSpecRole,
    tx: TxStores,
  ): Promise<SpecReingestOutcome> {
    const app = await tx.registeredApps.getById(appId);
    if (app === undefined) {
      throw new UnknownAppError(appId);
    }
    const active = await tx.apiSpecs.findActiveByAppAndRole(appId, role);
    if (active === undefined) {
      throw new NoActiveSpecError(appId, role);
    }

    const contentHash = computeContentHash(document);
    if (contentHash === active.contentHash) {
      // SL-1.5 — identical re-submission: no new version, no diff, no reaction.
      return { kind: "unchanged", activeSpec: active };
    }

    const newIr = await buildIr(document);
    const diff = this.diffSpec(active.parsedIR, newIr);

    const newSpec = await tx.apiSpecs.create({
      id: randomUUID(),
      appId,
      role,
      rawDocument: document,
      parsedIR: newIr,
      // Exclusions (and `ResourceBinding`s) carry forward in SL-2; the advance itself
      // starts the new version with an empty scope and derives nothing (nothing
      // analyzes it in SL-1 — no `SpecIngested` is emitted).
      analysisExclusions: [],
      version: active.version + 1,
      contentHash,
      status: "active",
      createdAt: new Date(),
    });
    const superseded = await tx.apiSpecs.updateStatus(active.id, "superseded");
    // `updateStatus` returns undefined only if the row vanished mid-transaction (it did
    // not — we just read it); fall back to the known prior with its new status.
    const supersededSpec: ApiSpec = superseded ?? { ...active, status: "superseded" };

    if (diff.classification === "additive") {
      // SL-2 — the deterministic additive reaction, in this same transaction (its audit
      // rows commit with the version advance). It returns the new version reflecting the
      // carried-forward `analysisExclusions`.
      const repinnedNewSpec = await this.applyAdditiveReaction(supersededSpec, newSpec, tx);

      // SL-3 — when the additive diff added genuinely-new **in-scope** elements, record
      // (in this same transaction) the intent to run a **scoped** delta analysis. The
      // slow LLM/network work runs later in the worker, off this dispatcher/ingest
      // transaction (DT-2). The structural scope is derived once from the diff (SL-1.6),
      // honoring the carried-forward `analysisExclusions` (SL-3.4: an excluded resource is
      // never analyzed). No genuinely-new in-scope element → no scoped job (nothing to
      // review). `enqueueScoped` is idempotent under the same partial-unique index as the
      // full enqueue, so a redelivery produces the delta proposal once (SL-3.5).
      const scope = computeAdditiveAnalysisScope(
        diff,
        supersededSpec.id,
        repinnedNewSpec.analysisExclusions,
      );
      if (scope !== undefined) {
        await tx.detectionJobs.enqueueScoped(repinnedNewSpec.id, scope);
      }

      return { kind: "advanced", newSpec: repinnedNewSpec, supersededSpec, diff };
    }

    // SL-4 — the breaking reaction, in this same transaction: mark ONLY the mappings that
    // reference a changed element `stale`, re-pin the rest exactly as SL-2, carry the
    // version's exclusions + bindings forward, and — coupled — drop the stale endpoints'
    // caches (XI-2) and recompute the affected graph edges (GR-2/GR-3).
    const stalenessNewSpec = await this.applyBreakingReaction(supersededSpec, newSpec, diff, tx);
    return { kind: "advanced", newSpec: stalenessNewSpec, supersededSpec, diff };
  }

  /**
   * **SL-2 — the deterministic additive reaction to a `SpecDiff`.** Runs entirely on
   * the version-advance transaction, so its effects (re-pins, carried-forward bindings,
   * audit rows) commit atomically with the advance. Three parts, none of which change
   * anything that executes — so no mapping is set `stale` and no human review runs:
   *
   * 1. **Re-pin (SL-2.1/2.2/2.3)** — every `active` `ApprovedMapping` pinned to the
   *    now-`superseded` version (via `sourceSpecId`/`targetSpecId`) is re-pinned to the
   *    new version; each re-pin changes **only** the pinned spec version and is recorded
   *    as an audit row. After this, no `active` mapping references the superseded row.
   *    The `counterpartMappingId` link is never touched — it is defined over spec
   *    lineages, so each side's pinned version advances independently (SL-2.5).
   * 2. **Carry forward `analysisExclusions` (SL-2.4)** — the prior version's exclusions
   *    move to the new version, dropping any that no longer resolve (SL-1 created the new
   *    version with an empty exclusion set; this fills it in).
   * 3. **Carry forward `ResourceBinding`s (SL-2.4)** — the prior version's bindings are
   *    re-created as fresh rows on the new version, dropping any ref the new IR no longer
   *    resolves. For a truly additive diff nothing is dropped and confirmations carry
   *    forward intact.
   *
   * Returns the new `ApiSpec` reflecting its carried-forward `analysisExclusions`.
   */
  private async applyAdditiveReaction(
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const now = new Date();

    // (1) Re-pin every active mapping pinned to the superseded version + audit each.
    const mappings = await tx.approvedMappings.listActiveBySpecId(supersededSpec.id);
    for (const mapping of mappings) {
      await this.#repinMapping(mapping, supersededSpec, newSpec, tx, now);
    }

    // (2/3) Carry forward the version's `analysisExclusions` + `ResourceBinding`s.
    return this.#carryForwardVersionArtifacts(supersededSpec, newSpec, tx);
  }

  /**
   * **SL-4 — the breaking reaction to a `SpecDiff`.** Runs entirely on the
   * version-advance transaction, so the stale-marks, re-pins, carried-forward artifacts,
   * audit rows, and graph recompute commit atomically with the advance.
   *
   * 1. **Precise mark-stale (SL-4.1) — the load-bearing invariant.** For every `active`
   *    **and** (SL-10.5) every `suspended` `ApprovedMapping` pinned to the now-`superseded`
   *    version — a manual operator hold is independent of spec-driven staleness, so it never
   *    makes the diff skip a mapping — match its **referenced
   *    elements on the changed side** ({@link mappingChangedSideRefs} — the side that
   *    pinned the superseded spec) against the diff's **breaking** change locations
   *    ({@link computeBreakingAffectedKeys}). A mapping that references a changed element
   *    ({@link mappingReferencesChangedElement}) goes `status = stale`; a mapping that
   *    references **no** changed element is re-pinned to the new version exactly as SL-2 —
   *    "no more, no less". The matching is conservative in the dangerous direction (a
   *    field/schema change stales any mapping referencing that resource; only cross-
   *    resource / cross-operation precision distinguishes the untouched), so an ambiguous
   *    reference prefers `stale` (a false-stale is re-reviewable; a false-active silently
   *    serves a shape that changed).
   * 2. **Staleness lives on the mapping (SL-4.2/4.3).** {@link markStale} sets **only**
   *    `status` — from `active`, and (SL-10.5) from `suspended`, where the more-blocking
   *    `stale` wins and only re-review returns the mapping to `active` (resume no longer
   *    applies). An unaffected `suspended` mapping keeps its hold and, like a stale one,
   *    stays pinned; only `active` mappings are re-pinned. A stale mapping **stays pinned**
   *    to its reviewed (superseded) version
   *    (re-review — SL-6 — produces its successor against the new version). Its derived
   *    `SyncRule`s/`AdapterBinding`s keep their own `status`; the rule pauses and the
   *    binding fails `mapping-stale` as **derived** conditions (nothing writes a rule/
   *    binding status).
   * 3. **Advance the rest + re-validate the operational refs (SL-4.1 / SL-5).** Unaffected
   *    mappings re-pin + audit, and the version's `analysisExclusions` +
   *    `ResourceBinding`s carry forward — but on the breaking path the bindings carry
   *    forward **re-validated** ({@link carryForwardVersionArtifactsRevalidated}): a broken
   *    bound ref is RETAINED and returned to **unconfirmed** (SL-5.1 — vs SL-2's additive
   *    carry-forward, which DROPS it), pausing the rules that depend on it even when no
   *    mapping content was affected. Then {@link revalidatePollOperationRefs} returns a
   *    changed-lineage rule's now-gone `pollOperationRef` to unconfirmed (SL-5.2), and — for
   *    a PROVIDER spec — {@link revalidateScopeCorrespondences} re-validates each scoped
   *    pair's `ScopeCorrespondence` / `ScopeLink`s (SL-5.3). Every SL-5 consequence is a
   *    persisted unconfirmed artifact — a **derived** pause, no rule status written (SL-5.4).
   * 4. **Coupled cache + graph (SL-4.6).** {@link reactToStaleTransitions} drops each
   *    stale endpoint's cache (XI-2) and recomputes each affected `(app pair)` `GraphEdge`
   *    (GR-2/GR-3), so no cache or graph masks the pause.
   *
   * 5. **Record the scoped re-review (SL-6.1).** For each stale mapping, its affected
   *    resource pairs are computed here ({@link computeReReviewAffectedPairs}) and, if any
   *    mapping went stale, **one** `re-review` scoped `mapping_detection_job` is recorded in
   *    this same transaction (`enqueueScoped`). The worker later runs the detail-only
   *    re-analysis with the stale content as `priorFeedback`, producing each successor
   *    proposal — off this transaction (DT-2), nothing auto-approved (SL-6.3).
   *
   * SL-4 and SL-5 run on the **same** breaking diff in the **one** transaction and are
   * consistent (SL-5.6): a rule can pause for a stale mapping (SL-4), an unconfirmed ref
   * (SL-5), or both; SL-5 never un-stales an SL-4 mapping and never writes a rule status.
   *
   * Returns the new `ApiSpec` reflecting its carried-forward `analysisExclusions`.
   */
  private async applyBreakingReaction(
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    diff: SpecDiff,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const now = new Date();
    const affected = computeBreakingAffectedKeys(diff);

    // SL-10.5 — the breaking diff classifies `suspended` mappings alongside `active` ones: a
    // manual operator hold is independent of spec-driven staleness, so it never makes the
    // diff skip the mapping. A suspended mapping that references a changed element goes
    // `suspended → stale` below (the more-blocking condition wins — it then needs re-review
    // to reach `active`, and resume no longer applies); one that references nothing changed
    // stays `suspended` and — like a `stale` mapping — stays pinned to the version it was
    // reviewed against (only `active` mappings are re-pinned, data-model
    // `ApprovedMapping.sourceSpecId`).
    const activeMappings = await tx.approvedMappings.listActiveBySpecId(supersededSpec.id);
    const suspendedMappings = await tx.approvedMappings.listSuspendedBySpecId(supersededSpec.id);
    const mappings = [...activeMappings, ...suspendedMappings];
    const staleMappings: ApprovedMapping[] = [];
    // SL-6 — one re-review descriptor per stale mapping (its id + the affected resource
    // pairs), collected in this same transaction to record the scoped re-review job below.
    const reReviewDescriptors: ReReviewStaleMappingScope[] = [];
    // SL-5.2 — peer-peer mappings whose SOURCE was the changed spec: their `SyncRule`s pin a
    // source `pollOperationRef` we must re-validate (stale AND re-pinned alike — the poll-op
    // safety net is independent of mapping-staleness, so a stale rule can pause for both).
    const changedSourceMappings: ApprovedMapping[] = [];
    for (const mapping of mappings) {
      const fields = await tx.mappingArtifacts.listFieldMappings(mapping.id);
      const operations = await tx.mappingArtifacts.listOperationMappings(mapping.id);
      if (mapping.variant === "peer-peer" && mapping.sourceSpecId === supersededSpec.id) {
        changedSourceMappings.push(mapping);
      }
      // The ONE per-mapping verdict, shared verbatim with the SL-10.2 resume catch-up.
      const verdict = classifyMappingAgainstBreaking(
        mapping,
        supersededSpec.id,
        fields,
        operations,
        affected,
      );
      if (verdict.staled) {
        // SL-4.1/4.2/4.3 — stale, and STAYS pinned to the reviewed (superseded) version.
        await tx.approvedMappings.markStale(mapping.id);
        await tx.audit.insert(staleAuditEntry(mapping, supersededSpec, newSpec, now));
        staleMappings.push(mapping);
        // SL-6.1 — the resource pairs the break actually touched, for the scoped
        // detail-only re-review (computed here from the one classification — SL-1.6).
        reReviewDescriptors.push({
          staleMappingId: mapping.id,
          affectedPairs: [...verdict.affectedPairs],
        });
      } else if (mapping.status === "active") {
        // SL-4.1 — references no changed element → advance exactly as the additive case.
        await this.#repinMapping(mapping, supersededSpec, newSpec, tx, now);
      }
      // SL-10.5 — an unaffected `suspended` mapping is left untouched: it keeps its hold and,
      // like a `stale` one, stays pinned to the version it was reviewed against. Re-pinning is
      // defined for `active` mappings only (data-model `ApprovedMapping.sourceSpecId`).
    }

    // SL-2.4 exclusions + SL-5.1 re-validated (retain-unconfirmed) binding carry-forward.
    const updatedNewSpec = await this.#carryForwardVersionArtifactsRevalidated(
      supersededSpec,
      newSpec,
      tx,
    );

    // SL-5.2 — pollOperationRef re-validation for the changed lineage's peer-peer rules.
    await this.#revalidatePollOperationRefs(changedSourceMappings, newSpec.parsedIR, tx);

    // SL-5.3 — ScopeCorrespondence / ScopeLink re-validation for the changed spec's scoped
    // pairs. Only a PROVIDER spec participates in a `ScopeCorrespondence` (it correlates a
    // peer-peer sync pair); a CONSUMER advance has none to re-validate.
    if (newSpec.role === "PROVIDER") {
      await this.#revalidateScopeCorrespondences(newSpec, tx);
    }

    // SL-4.6 — coupled cache drop (XI-2) + graph recompute (GR-2/GR-3) for the stale set,
    // AFTER the stale status is written so the graph aggregate reads the paused/stale state.
    await this.#reactToStaleTransitions(staleMappings, tx);

    // SL-6.1 — record (in this same transaction) the intent to run the scoped **re-review**
    // analysis for every stale mapping: one `mapping_detection_job` carrying the `re-review`
    // {@link DetectionJobScope}. The slow detail-only LLM work runs later in the worker, off
    // this advance transaction (DT-2), producing each stale mapping's successor proposal for
    // ordinary Phase-3 re-review — nothing auto-approved (SL-6.3). No stale mapping → no job.
    // `enqueueScoped` is idempotent under the same per-spec partial-unique index as the full
    // enqueue, so a redelivered advance produces the successor proposals once (SL-6.6).
    if (reReviewDescriptors.length > 0) {
      const scope: ReReviewScope = {
        kind: "re-review",
        supersededSpecId: supersededSpec.id,
        staleMappings: reReviewDescriptors,
      };
      await tx.detectionJobs.enqueueScoped(newSpec.id, scope);
    }

    return updatedNewSpec;
  }

  /**
   * SL-2.1/2.2/2.5 — re-pin one mapping to the new version (only its pinned spec ids
   * change) and record the re-pin audit row. Shared by the additive reaction and the
   * breaking reaction's unaffected-mapping path.
   */
  async #repinMapping(
    mapping: ApprovedMapping,
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    tx: TxStores,
    now: Date,
  ): Promise<void> {
    const pair = repinnedSpecPair(mapping, supersededSpec.id, newSpec.id);
    await tx.approvedMappings.repinSpecs(mapping.id, pair.sourceSpecId, pair.targetSpecId);
    await tx.audit.insert(repinAuditEntry(mapping, supersededSpec, newSpec, now));
  }

  /**
   * SL-2.4 — carry the version-level artifacts forward to the new version: the prior
   * version's `analysisExclusions` (dropping any group the new IR no longer resolves) and
   * its `ResourceBinding`s (re-created as fresh rows, dropping refs the new IR no longer
   * resolves — verbatim confirmations otherwise). A per-version concern shared by both
   * reactions. (Returning a *breaking*-invalidated bound ref to unconfirmed is SL-5's
   * separate job; this carry-forward is the same for both diff branches.) Returns the new
   * `ApiSpec` reflecting its carried-forward `analysisExclusions`.
   */
  async #carryForwardVersionArtifacts(
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const updated = await this.#carryForwardAnalysisExclusions(supersededSpec, newSpec, tx);

    const priorBindings = await tx.resourceBindings.listByApiSpecId(supersededSpec.id);
    const carriedBindings = priorBindings.flatMap((prior) => {
      const carried = carryForwardResourceBinding(
        prior,
        newSpec.id,
        randomUUID(),
        newSpec.parsedIR,
      );
      return carried === undefined ? [] : [carried];
    });
    if (carriedBindings.length > 0) {
      await tx.resourceBindings.createMany(carriedBindings);
    }

    return updated;
  }

  /**
   * **SL-5.1 — the breaking-path binding carry-forward: retain-then-re-validate.** Carries
   * the version's `analysisExclusions` forward (identical to the additive case) and then
   * relocates the prior version's `ResourceBinding`s to the new version **verbatim**
   * ({@link carryForwardResourceBindingVerbatim} — every ref/`sourceScopeRef`/`scopePathBindings`
   * entry with its confirmation intact, dropping only a binding whose resource GROUP is
   * gone), before re-validating them **in place** against the new IR via SS-16
   * `ScopeLifecycleService.revalidateSpecBindings`.
   *
   * The difference from {@link carryForwardVersionArtifacts} (SL-2's additive path) is the
   * whole point of SL-5.1: the additive carry-forward **drops** a ref the new IR no longer
   * resolves, whereas here re-validation **retains** it and returns it to **unconfirmed** —
   * so `resolveRecordAddressing` / the enablement gate / the poll-plan resolver refuse it
   * and the dependent `SyncRule`s pause, even when no mapping content was affected. A truly
   * additive-shaped ref (still resolving) carries forward confirmed either way.
   */
  async #carryForwardVersionArtifactsRevalidated(
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const updated = await this.#carryForwardAnalysisExclusions(supersededSpec, newSpec, tx);

    const priorBindings = await tx.resourceBindings.listByApiSpecId(supersededSpec.id);
    const carriedBindings = priorBindings.flatMap((prior) => {
      const carried = carryForwardResourceBindingVerbatim(
        prior,
        newSpec.id,
        randomUUID(),
        newSpec.parsedIR,
      );
      return carried === undefined ? [] : [carried];
    });
    if (carriedBindings.length > 0) {
      await tx.resourceBindings.createMany(carriedBindings);
    }
    // SS-16 re-validates the relocated bindings in place: a broken bound ref is returned to
    // unconfirmed (retained), an unaffected one stays confirmed. Findings are the paused-ref
    // record; the persistence is the pause.
    await tx.scopeLifecycle.revalidateSpecBindings(newSpec.id, newSpec.parsedIR);

    return updated;
  }

  /** SL-2.4 — carry the version's `analysisExclusions` forward (shared by both diff branches). */
  async #carryForwardAnalysisExclusions(
    supersededSpec: ApiSpec,
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<ApiSpec> {
    const carriedExclusions = carryForwardAnalysisExclusions(
      supersededSpec.analysisExclusions,
      newSpec.parsedIR,
    );
    const updated = await tx.apiSpecs.updateAnalysisExclusions(newSpec.id, carriedExclusions);
    return updated ?? { ...newSpec, analysisExclusions: carriedExclusions };
  }

  /**
   * **SL-5.2 — re-validate `SyncRule.pollOperationRef` for the changed lineage's peer-peer
   * rules.** `pollOperationRef` pins a **source** operation (the collection read or delta
   * query the Poller calls) that is typically referenced by no mapping element, so SL-4's
   * mapping-staleness never catches a change to it — this is its dedicated safety net. For
   * every rule of a mapping whose SOURCE was the superseded spec, if the pinned poll
   * operation no longer resolves in the new IR ({@link pollOperationResolves}) it is
   * returned to **unconfirmed** (cleared), pausing the rule at the runtime backstop exactly
   * as a broken binding ref does. The cursor/snapshot are untouched here (SL-5.4 is a
   * derived pause, not a state edit); resetting them is the operator's *re-confirm onto a
   * different operation* (`SyncRuleRepository.reconfirmPollOperation`, SL-5.2's second half).
   *
   * `revalidateSpecBindings` does **not** cover this: it re-validates `ResourceBinding`
   * refs, and `pollOperationRef` lives on the `SyncRule`, so it needs this own wiring.
   */
  async #revalidatePollOperationRefs(
    changedSourceMappings: readonly ApprovedMapping[],
    newIr: Ir,
    tx: TxStores,
  ): Promise<void> {
    for (const mapping of changedSourceMappings) {
      const rules = await tx.downstreamArtifacts.listSyncRulesByMapping(mapping.id);
      for (const rule of rules) {
        const ref = rule.pollOperationRef;
        if (ref === undefined || ref.length === 0) {
          continue; // already unconfirmed — nothing to return
        }
        if (!pollOperationResolves(ref, newIr)) {
          await tx.syncRules.clearPollOperationRef(rule.id);
        }
      }
    }
  }

  /**
   * **SL-5.3 — re-validate every `ScopeCorrespondence` the changed spec participates in.**
   * For each of the changed spec's resource groups, look up the correspondences it is a side
   * of ({@link ScopeCorrespondenceSideTxReader.listByResourceSide}), dedupe by id, assemble
   * both {@link ScopeCorrespondenceSide}s ({@link assembleCorrespondenceSides} — the changed
   * side reads the new IR + its carried-forward bindings, the counterpart reads its active
   * PROVIDER spec), and hand each to SS-16 `revalidateCorrespondence`. On a scope-identity-key
   * or container break the correspondence returns to unconfirmed and its `ScopeLink`s are
   * archived (never deleted); a `constant`/`manual` link is operator-pinned and preserved.
   */
  async #revalidateScopeCorrespondences(newSpec: ApiSpec, tx: TxStores): Promise<void> {
    const seen = new Set<string>();
    for (const group of newSpec.parsedIR) {
      const correspondences = await tx.scopeCorrespondences.listByResourceSide(
        newSpec.appId,
        group.resourceRef,
      );
      for (const correspondence of correspondences) {
        if (seen.has(correspondence.id)) {
          continue;
        }
        seen.add(correspondence.id);
        const sides = await this.#assembleCorrespondenceSides(correspondence, newSpec, tx);
        if (sides === undefined) {
          continue; // a side could not be assembled (bad pair / missing counterpart) — leave it
        }
        await tx.scopeLifecycle.revalidateCorrespondence(
          correspondence,
          sides.source,
          sides.target,
        );
      }
    }
  }

  /**
   * Assemble both sides of a correspondence for re-validation. The **target** side is the
   * `resourcePairRef` token whose app is `targetContainerRef.appId`; the **source** side is
   * the other token (`revalidateScopeCorrespondence` reads `sourceContainerRef` against the
   * source side and `targetContainerRef` against the target side). Returns `undefined` when
   * the pair is unparseable or a counterpart side has no assemblable spec.
   */
  async #assembleCorrespondenceSides(
    correspondence: ScopeCorrespondence,
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<{ source: ScopeCorrespondenceSide; target: ScopeCorrespondenceSide } | undefined> {
    const parsed = parseResourcePairRef(correspondence.resourcePairRef);
    if (parsed === undefined) {
      return undefined;
    }
    const targetAppId = correspondence.targetContainerRef.appId;
    const targetToken = parsed.a.appId === targetAppId ? parsed.a : parsed.b;
    const sourceToken = targetToken === parsed.a ? parsed.b : parsed.a;
    const [source, target] = await Promise.all([
      this.#buildCorrespondenceSide(sourceToken, newSpec, tx),
      this.#buildCorrespondenceSide(targetToken, newSpec, tx),
    ]);
    return source === undefined || target === undefined ? undefined : { source, target };
  }

  /**
   * One `ScopeCorrespondenceSide`: the changed side reads the **new** spec's IR + its
   * carried-forward (already re-validated) bindings; a counterpart side reads its active
   * PROVIDER spec's IR + bindings. `undefined` when a counterpart has no active PROVIDER spec.
   */
  async #buildCorrespondenceSide(
    token: { readonly appId: string; readonly resourceRef: string },
    newSpec: ApiSpec,
    tx: TxStores,
  ): Promise<ScopeCorrespondenceSide | undefined> {
    if (token.appId === newSpec.appId) {
      const bindings = await tx.resourceBindings.listByApiSpecId(newSpec.id);
      return { appId: token.appId, ir: newSpec.parsedIR, bindings, resourceRef: token.resourceRef };
    }
    const spec = await tx.apiSpecs.findActiveByAppAndRole(token.appId, "PROVIDER");
    if (spec === undefined) {
      return undefined;
    }
    const bindings = await tx.resourceBindings.listByApiSpecId(spec.id);
    return { appId: token.appId, ir: spec.parsedIR, bindings, resourceRef: token.resourceRef };
  }

  /**
   * **SL-4.6 / XI-2 / GR-2/GR-3 — the coupled cache + graph reactions to the stale set.**
   * For each stale mapping (each keyed by its version-agnostic `(sourceApp → targetApp)`
   * app pair — consumer = source, backend = target for a consumer-provider mapping):
   *
   * - recompute its `GraphEdge` **within this transaction** via the GR seam (sync edge for
   *   a peer-peer mapping, adapter edge for a consumer-provider one), so the projection
   *   shows the paused/stale status and no stale edge masks the pause; and
   * - for a consumer-provider mapping, drop **every** `AdapterEndpoint` whose binding's
   *   mapping went stale through the SAME by-endpoint `invalidateEndpoint` seam CO-6 uses
   *   (XI-2 / CH-5.3). The drop is coarse, correctness-safe, needs no transaction, and
   *   must **never** fail the transition ({@link invalidateEndpointSafely} guards it).
   *
   * Edge recomputes are deduped by app pair and endpoint drops by id, so overlapping
   * stale mappings never re-drop or re-recompute. A peer-peer mapping has no adapter
   * bindings → no cache drop; a consumer-provider mapping has no sync rules → no sync edge.
   */
  async #reactToStaleTransitions(
    staleMappings: readonly ApprovedMapping[],
    tx: TxStores,
  ): Promise<void> {
    const recomputedSyncEdges = new Set<string>();
    const recomputedAdapterEdges = new Set<string>();
    const invalidatedEndpoints = new Set<string>();

    for (const mapping of staleMappings) {
      // A JSON tuple is a collision-free key even if an app id contains a separator
      // character — and never a NUL byte.
      const pairKey = JSON.stringify([mapping.sourceAppId, mapping.targetAppId]);
      if (mapping.variant === "peer-peer") {
        if (!recomputedSyncEdges.has(pairKey)) {
          recomputedSyncEdges.add(pairKey);
          await tx.graph.recomputeSyncEdge(mapping.sourceAppId, mapping.targetAppId);
        }
        continue;
      }

      // consumer-provider: consumer = sourceApp, backend = targetApp (data-model.md).
      if (!recomputedAdapterEdges.has(pairKey)) {
        recomputedAdapterEdges.add(pairKey);
        await tx.graph.recomputeAdapterEdge(mapping.sourceAppId, mapping.targetAppId);
      }
      const bindings = await tx.downstreamArtifacts.listAdapterBindingsByMapping(mapping.id);
      for (const binding of bindings) {
        if (invalidatedEndpoints.has(binding.adapterEndpointId)) continue;
        invalidatedEndpoints.add(binding.adapterEndpointId);
        invalidateEndpointSafely(tx.cacheInvalidator, binding.adapterEndpointId);
      }
    }
  }
}

// ── SL-4 pure helpers (the breaking mark-stale matching policy) ─────────────────

/**
 * The elements a **breaking** `SpecDiff` invalidated, bucketed by the granularity a
 * mapping's referenced refs can be matched against precisely (SL-4.1). Derived once from
 * the diff (SL-1.6 — no re-diffing); only `breaking` changes contribute (an additive
 * change never breaks a referenced element). Carries only version-stable structural
 * identifiers — never IR payload, never a secret.
 *
 * - **`resources`** — a whole resource group was **removed** (`resource-group-removed`):
 *   **every** ref into that resource (field or operation) is broken.
 * - **`fieldResources`** — a **schema/field**-level breaking change (`schema-removed`,
 *   `field-removed`/`-type-changed`/`-requiredness-changed`, a required `field-added`):
 *   the resource's data shape changed, so **field** refs into that resource are broken.
 *   A `FieldMapping` ref is `resourceRef/record-relative-path` and carries neither the
 *   schema name nor a resolvable field identity, and a newly-required field breaks
 *   writers that do not even map it — so a field/schema change is matched at the
 *   **resource** granularity for field refs (conservative: it may stale a same-resource
 *   mapping that only touched an unchanged field, a re-reviewable false-stale, but never
 *   leaves a broken reference `active`).
 * - **`operations`** — an **operation/parameter**-level breaking change
 *   (`operation-removed`/`-signature-changed`/`-ambiguous`, `request`/`response-body-changed`,
 *   any `parameter-*`): the **exact** `resourceRef/operationId` call broke. Matched by
 *   exact operation ref (a mapping using a *different* operation of the same resource
 *   stays active), since an operation ref is a reconstructible, provable identity.
 */
export interface BreakingAffectedKeys {
  readonly resources: ReadonlySet<string>;
  readonly fieldResources: ReadonlySet<string>;
  readonly operations: ReadonlySet<string>;
}

/** SL-4.1 — bucket a breaking `SpecDiff`'s change locations into {@link BreakingAffectedKeys}. Pure. */
export function computeBreakingAffectedKeys(diff: SpecDiff): BreakingAffectedKeys {
  const resources = new Set<string>();
  const fieldResources = new Set<string>();
  const operations = new Set<string>();
  for (const change of diff.changes) {
    if (change.classification !== "breaking") continue; // only breaking changes break a ref
    const location = change.location;
    switch (location.level) {
      case "resource":
        resources.add(location.resourceRef);
        break;
      case "schema":
      case "field":
        fieldResources.add(location.resourceRef);
        break;
      case "operation":
      case "parameter":
        operations.add(operationRefOf(location.resourceRef, location.operationId));
        break;
    }
  }
  return { resources, fieldResources, operations };
}

/**
 * A mapping's referenced elements **on the changed-spec side** (the side pinned to the
 * superseded version — SL-4.1). Split by ref kind so each is matched against the change
 * bucket that can break it:
 *
 * - `fieldRefs` — a `FieldMapping`'s field paths (plus an aggregate/expression's
 *   `transformConfig.additionalInputPaths`, which are read too), assigned to the spec side
 *   they actually reference. **Which path references which spec depends on the phase**: a
 *   peer-peer or consumer-provider **request**-phase field is `sourcePath`↔source-spec,
 *   `targetPath`↔target-spec; a consumer-provider **response**-phase field **inverts** it —
 *   `sourcePath` is the **backend (target-spec)** field and `targetPath` the **consumer
 *   (source-spec)** field (`serve-context.ts` / `response-mapping.ts`). `additionalInputPaths`
 *   travel with `sourcePath`'s spec. Assigning them phase-blind would silently miss a
 *   provider response-body break — the common adapter-read case (SL-4.1's exact failure).
 * - `operationRefs` — `OperationMapping.{source,target}OperationRef`. Not phase-dependent:
 *   `sourceOperationRef`↔consumer, `targetOperationRef`↔backend regardless of phase.
 * - `paramRefs` — target-side operation-input refs (`OperationMapping.targetIdParamRef`,
 *   `FieldMapping.targetLookupParamRef` — peer-peer only, never phase-bearing), matched to
 *   their owning operation.
 */
export interface MappingChangedSideRefs {
  readonly fieldRefs: readonly string[];
  readonly operationRefs: readonly string[];
  readonly paramRefs: readonly string[];
}

/**
 * SL-4.1 — extract a mapping's referenced refs **on the changed side**: the refs that
 * reference the superseded spec (source-spec refs when the mapping pinned it as source,
 * target-spec refs when as target; both for a self-referential mapping). **Phase-aware**
 * for field refs (a response-phase consumer-provider field inverts `sourcePath`/`targetPath`
 * — see the interface note); operation/parameter refs are phase-independent. Pure.
 */
export function mappingChangedSideRefs(
  mapping: Pick<ApprovedMapping, "sourceSpecId" | "targetSpecId">,
  supersededSpecId: string,
  fields: readonly FieldMapping[],
  operations: readonly OperationMapping[],
): MappingChangedSideRefs {
  const useSource = mapping.sourceSpecId === supersededSpecId;
  const useTarget = mapping.targetSpecId === supersededSpecId;
  const fieldRefs: string[] = [];
  const operationRefs: string[] = [];
  const paramRefs: string[] = [];

  for (const field of fields) {
    // A consumer-provider RESPONSE-phase field inverts the convention: `sourcePath` is the
    // backend (target-spec) field and `targetPath` the consumer (source-spec) field, the
    // opposite of a peer-peer / request-phase field. `additionalInputPaths` (never a secret —
    // resource-qualified IR paths) travel with `sourcePath`'s spec.
    const inverted = field.phase === "response";
    const primaryRefs = [field.sourcePath, ...(field.transformConfig?.additionalInputPaths ?? [])];
    const sourceSpecFieldRefs = inverted ? [field.targetPath] : primaryRefs;
    const targetSpecFieldRefs = inverted ? primaryRefs : [field.targetPath];
    if (useSource) {
      fieldRefs.push(...sourceSpecFieldRefs);
    }
    if (useTarget) {
      fieldRefs.push(...targetSpecFieldRefs);
      // `targetLookupParamRef` is peer-peer only (never phase-bearing), so it never inverts.
      if (field.targetLookupParamRef !== undefined) {
        paramRefs.push(field.targetLookupParamRef);
      }
    }
  }
  for (const operation of operations) {
    if (useSource) {
      operationRefs.push(operation.sourceOperationRef);
    }
    if (useTarget) {
      operationRefs.push(operation.targetOperationRef);
      if (operation.targetIdParamRef !== undefined) {
        paramRefs.push(operation.targetIdParamRef);
      }
    }
  }
  return { fieldRefs, operationRefs, paramRefs };
}

/**
 * **SL-4.1 — the load-bearing predicate: does the mapping reference a changed element?**
 * Pure. Matches each changed-side ref against the affected buckets:
 *
 * - a **field** ref matches when its resource had a whole-resource removal (`resources`)
 *   or a schema/field-level change (`fieldResources`);
 * - an **operation** ref matches its resource's removal (`resources`) or the **exact**
 *   broken operation (`operations`);
 * - a **parameter** ref matches its resource's removal or its owning operation's break.
 *
 * The asymmetry is deliberate (SL-4's "direction of danger"): field/schema changes match
 * at resource granularity (conservative — a same-resource unchanged-field mapping may
 * false-stale, which is re-reviewable), while operation changes match the exact operation
 * (precise — a mapping using a sibling operation stays active). Under-marking (leaving a
 * broken reference `active`) is impossible for any element that was actually touched.
 */
export function mappingReferencesChangedElement(
  refs: MappingChangedSideRefs,
  affected: BreakingAffectedKeys,
): boolean {
  for (const fieldRef of refs.fieldRefs) {
    const resource = resourceOfRef(fieldRef);
    if (affected.resources.has(resource) || affected.fieldResources.has(resource)) {
      return true;
    }
  }
  for (const operationRef of refs.operationRefs) {
    if (affected.resources.has(resourceOfRef(operationRef))) return true;
    if (affected.operations.has(operationRef)) return true;
  }
  for (const paramRef of refs.paramRefs) {
    if (affected.resources.has(resourceOfRef(paramRef))) return true;
    if (affected.operations.has(operationPrefixOfParamRef(paramRef))) return true;
  }
  return false;
}

/**
 * **SL-6.1 — the affected resource pairs of a `stale` mapping**: the resource pairs the
 * breaking change actually touched, each of which the scoped re-review re-analyzes with a
 * detail-only call (no shortlist). Pure. Groups the mapping's approved
 * `FieldMapping`/`OperationMapping` children into their **proposal-oriented** resource pairs
 * (`source-spec resource → target-spec resource`, applying the same response-phase inversion
 * as {@link mappingChangedSideRefs} — a consumer-provider response field's `sourcePath` is
 * the target-spec field), then keeps a pair when *that pair's* refs reference a changed
 * element ({@link mappingReferencesChangedElement}) — the exact predicate that made the
 * mapping stale, re-applied at pair granularity.
 *
 * The mapping is only reached here because it references a changed element, so at least one
 * group matches; the empty fallback (return **every** pair) is belt-and-suspenders so a
 * stale mapping's re-review is never scoped down to nothing (SL-6.5). Carries only
 * version-stable `resourceRef`s — never IR payload, never a secret.
 */
/**
 * **The per-mapping breaking verdict (SL-4.1 + SL-6.1) — one classification, two callers.**
 * Composes the three matching primitives into the single decision both the Spec Registry's
 * {@link SpecRegistry.applyBreakingReaction} (at advance time) and the SL-10.2 **resume
 * catch-up** (at resume time, for a mapping whose hold spanned the advance) make: does this
 * mapping reference an element the breaking diff invalidated, and if so which resource pairs
 * does the scoped re-review cover?
 *
 * Extracted so the two paths can never drift — a mapping held through a breaking advance is
 * classified by the **same** rule as one that was active for it, so a hold defers the
 * reaction without changing its outcome. Pure.
 */
export interface MappingBreakingVerdict {
  /** The mapping references a changed element → it goes `stale` and awaits re-review. */
  readonly staled: boolean;
  /** SL-6.1 — the resource pairs the break touched (empty unless `staled`). */
  readonly affectedPairs: readonly ReReviewResourcePair[];
}

/** {@link MappingBreakingVerdict} for `mapping` against a breaking diff on `changedSpecId`. Pure. */
export function classifyMappingAgainstBreaking(
  mapping: Pick<ApprovedMapping, "sourceSpecId" | "targetSpecId" | "variant">,
  changedSpecId: string,
  fields: readonly FieldMapping[],
  operations: readonly OperationMapping[],
  affected: BreakingAffectedKeys,
): MappingBreakingVerdict {
  const refs = mappingChangedSideRefs(mapping, changedSpecId, fields, operations);
  if (!mappingReferencesChangedElement(refs, affected)) {
    return { staled: false, affectedPairs: [] };
  }
  return {
    staled: true,
    affectedPairs: computeReReviewAffectedPairs(
      mapping,
      changedSpecId,
      fields,
      operations,
      affected,
    ),
  };
}

export function computeReReviewAffectedPairs(
  mapping: Pick<ApprovedMapping, "sourceSpecId" | "targetSpecId">,
  supersededSpecId: string,
  fields: readonly FieldMapping[],
  operations: readonly OperationMapping[],
  affected: BreakingAffectedKeys,
): ReReviewResourcePair[] {
  interface Group {
    readonly pair: ReReviewResourcePair;
    readonly fields: FieldMapping[];
    readonly operations: OperationMapping[];
  }
  const groups = new Map<string, Group>();
  const bucket = (sourceResource: string, targetResource: string): Group => {
    // A JSON tuple is a collision-free key (never a NUL byte).
    const key = JSON.stringify([sourceResource, targetResource]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { pair: { sourceResource, targetResource }, fields: [], operations: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const field of fields) {
    // Response-phase (consumer-provider) fields invert source/target — see mappingChangedSideRefs.
    const inverted = field.phase === "response";
    const sourceResource = resourceOfRef(inverted ? field.targetPath : field.sourcePath);
    const targetResource = resourceOfRef(inverted ? field.sourcePath : field.targetPath);
    bucket(sourceResource, targetResource).fields.push(field);
  }
  for (const operation of operations) {
    bucket(
      resourceOfRef(operation.sourceOperationRef),
      resourceOfRef(operation.targetOperationRef),
    ).operations.push(operation);
  }

  const affectedPairs: ReReviewResourcePair[] = [];
  for (const group of groups.values()) {
    const refs = mappingChangedSideRefs(mapping, supersededSpecId, group.fields, group.operations);
    if (mappingReferencesChangedElement(refs, affected)) {
      affectedPairs.push(group.pair);
    }
  }
  // A stale mapping always has ≥1 affected pair; fall back to all pairs if not (SL-6.5).
  return affectedPairs.length > 0 ? affectedPairs : [...groups.values()].map((group) => group.pair);
}

/** The `resourceRef/operationId` form of an operation change location (mirrors the approval serializer). */
function operationRefOf(resourceRef: string, operationId: string): string {
  return `${resourceRef}/${operationId}`;
}

/**
 * The resource-group portion of any serialized ref (field `issues/title`, operation
 * `issues/updateIssue`, parameter `issues/updateIssue#id`): a `resourceRef` never contains
 * a `/`, so everything before the first `/` is the resource. Mirrors the single definition
 * in `@mediator/domain` `fieldResourceRef` / the artifact-instantiation `resourceRefOf`.
 */
function resourceOfRef(ref: string): string {
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(0, slash);
}

/**
 * The owning `resourceRef/operationId` of a parameter ref (`resourceRef/operationId#param`
 * — the approval serializer's form), so a parameter break matches its operation.
 */
function operationPrefixOfParamRef(paramRef: string): string {
  const hash = paramRef.indexOf("#");
  return hash === -1 ? paramRef : paramRef.slice(0, hash);
}

/**
 * XI-2.5 — invoke the by-endpoint cache drop so it can **never** fail the triggering
 * transition. The drop is a synchronous, in-process, correctness-safe cache eviction, so
 * a throw here would be a defect — but a stale-transition must commit regardless (a missed
 * drop only costs a spurious hit until `cacheTtl`, which RP-3's `mapping-stale` guard makes
 * loud anyway). Swallow deliberately; nothing the invalidator sees is a secret.
 */
function invalidateEndpointSafely(
  cacheInvalidator: EndpointCacheInvalidator,
  endpointId: string,
): void {
  try {
    cacheInvalidator.invalidateEndpoint(endpointId);
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}

// ── SL-3 pure helper (structural scope of the additive delta analysis) ─────────

/**
 * **SL-3 — the structural analysis scope derived from an additive `SpecDiff`.** Pure
 * and total: it reads the one classification the diff already produced (SL-1.6 — no
 * re-diffing) and buckets the genuinely-new **in-scope** elements into the two
 * staging granularities the scoped analysis uses:
 *
 * - **`newResourceGroups`** — a `resource-group-added` change (SL-3.1): a scoped
 *   stage-1 shortlist for the group against each counterpart, then a detail call per
 *   shortlisted pair.
 * - **`changedResources`** — any other additive change (a new operation, a new
 *   optional field/parameter, a new schema, a gained response body) inside a resource
 *   that already existed (SL-3.2): stage 1 is skipped and a detail call runs for the
 *   already-shortlisted resource pair.
 *
 * Every excluded resource group (`analysisExclusions` on the new version, carried
 * forward by SL-2) is dropped from **both** buckets — an excluded resource is never
 * analyzed, so an additive element added to/inside it triggers nothing (SL-3.4).
 * Returns `undefined` when nothing genuinely-new is in scope: there is no delta to
 * review, so no scoped job is recorded. Only additive changes are considered (a
 * breaking diff never reaches this reaction), and only version-stable `resourceRef`s
 * are carried — never IR payload, never a secret.
 */
export function computeAdditiveAnalysisScope(
  diff: SpecDiff,
  supersededSpecId: string,
  newSpecExclusions: readonly string[],
): DetectionJobScope | undefined {
  const excluded = new Set(newSpecExclusions);
  const newResourceGroups: string[] = [];
  const changedResourceSet = new Set<string>();

  for (const change of diff.changes) {
    if (change.classification !== "additive") continue; // additive branch only (defensive)
    const { resourceRef } = change.location;
    if (excluded.has(resourceRef)) continue; // SL-3.4 — excluded groups are never analyzed
    if (change.kind === "resource-group-added") {
      newResourceGroups.push(resourceRef);
    } else {
      changedResourceSet.add(resourceRef);
    }
  }

  const newGroupSet = new Set(newResourceGroups);
  // A newly-added group's internals are covered by SL-3.1, never SL-3.2 — keep the two
  // buckets disjoint so a resource is analyzed exactly one way.
  const changedResources = [...changedResourceSet].filter((ref) => !newGroupSet.has(ref));

  if (newResourceGroups.length === 0 && changedResources.length === 0) {
    return undefined;
  }
  return { kind: "additive-delta", supersededSpecId, newResourceGroups, changedResources };
}

// ── SL-2 pure helpers (the additive re-pin / carry-forward policy) ─────────────

/**
 * SL-2.1/2.5 — the re-pinned spec pair for a mapping when `supersededSpecId` advances
 * to `newSpecId`. Whichever side pinned the superseded version advances; the other side
 * (the counterpart lineage) is carried forward unchanged, so re-pinning one side never
 * disturbs the counterpart pairing. Pure.
 */
export function repinnedSpecPair(
  mapping: Pick<ApprovedMapping, "sourceSpecId" | "targetSpecId">,
  supersededSpecId: string,
  newSpecId: string,
): { readonly sourceSpecId: string; readonly targetSpecId: string } {
  return {
    sourceSpecId: mapping.sourceSpecId === supersededSpecId ? newSpecId : mapping.sourceSpecId,
    targetSpecId: mapping.targetSpecId === supersededSpecId ? newSpecId : mapping.targetSpecId,
  };
}

/**
 * SL-2.4 — the `analysisExclusions` carried forward to the new version: every excluded
 * resource group that still resolves as a group in the new IR (`analysisExclusions`
 * names resource groups — `docs/glossary.md`). One whose group is gone is dropped. For a
 * truly additive diff no group is removed, so this is the identity — the drop is the
 * safety net the requirement states. Pure; preserves order.
 */
export function carryForwardAnalysisExclusions(
  priorExclusions: readonly string[],
  newIr: Ir,
): string[] {
  const groups = new Set(newIr.map((group) => group.resourceRef));
  return priorExclusions.filter((resourceRef) => groups.has(resourceRef));
}

/**
 * SL-2.4 — one prior-version `ResourceBinding` carried forward to the new version as a
 * fresh row (`newId` on `newSpecId`), dropping any ref/artifact the new IR no longer
 * resolves. Returns `undefined` when the resource **group** is gone from the new IR (the
 * whole binding is moot) — an additive diff never removes a group, so that too is a
 * safety net.
 *
 * The canonical IR-resolution policy (`revalidateResourceBinding`) is reused purely to
 * learn **which** refs/artifacts no longer resolve. SL-2 then **drops** them — as
 * opposed to returning them to unconfirmed, which is the breaking-change reaction SL-5
 * owns. For an additive diff `findings` is empty, so this is a verbatim copy with the
 * operator's confirmations intact — exactly "carry forward like a ref on the lineage".
 * Pure (`newId` is supplied by the caller).
 */
export function carryForwardResourceBinding(
  prior: ResourceBinding,
  newSpecId: string,
  newId: string,
  newIr: Ir,
): ResourceBinding | undefined {
  if (!newIr.some((group) => group.resourceRef === prior.resourceRef)) {
    return undefined;
  }
  const { findings } = revalidateResourceBinding(prior, newIr);
  const droppedRefs = new Set<RevalidatableRefName>();
  const droppedParams = new Set<string>();
  let dropSourceScopeRef = false;
  for (const finding of findings) {
    switch (finding.kind) {
      case "binding-ref-invalidated":
        droppedRefs.add(finding.ref);
        break;
      case "source-scope-ref-invalidated":
        dropSourceScopeRef = true;
        break;
      case "scope-parameter-removed":
        droppedParams.add(finding.parameterName);
        break;
      // A newly-required parameter is NOT introduced here — carry-forward copies what
      // existed, it never derives new scope artifacts (that is SL-3/SS-16). The container
      // and identity-key findings are correspondence-level (SL-5), not per-binding.
      case "scope-parameter-added":
      case "container-resource-removed":
      case "scope-identity-key-invalidated":
        break;
    }
  }
  return stripUndefined({
    ...prior,
    id: newId,
    apiSpecId: newSpecId,
    nativeIdRef: droppedRefs.has("nativeIdRef") ? undefined : prior.nativeIdRef,
    recordAddressRef: droppedRefs.has("recordAddressRef") ? undefined : prior.recordAddressRef,
    collectionReadRef: droppedRefs.has("collectionReadRef") ? undefined : prior.collectionReadRef,
    paginationRef: droppedRefs.has("paginationRef") ? undefined : prior.paginationRef,
    deltaCursorRef: droppedRefs.has("deltaCursorRef") ? undefined : prior.deltaCursorRef,
    deltaDeletionRef: droppedRefs.has("deltaDeletionRef") ? undefined : prior.deltaDeletionRef,
    changeTimestampRef: droppedRefs.has("changeTimestampRef")
      ? undefined
      : prior.changeTimestampRef,
    sourceScopeRef: dropSourceScopeRef ? undefined : prior.sourceScopeRef,
    scopePathBindings: (prior.scopePathBindings ?? []).filter(
      (entry) => !droppedParams.has(entry.parameterName),
    ),
  });
}

// ── SL-5 pure helpers (the breaking operational-ref carry-forward / resolution policy) ──

/**
 * **SL-5.1 — one prior-version `ResourceBinding` carried forward to the new version
 * VERBATIM.** A fresh row (`newId` on `newSpecId`) with every ref, `sourceScopeRef`, and
 * `scopePathBindings` entry — including its operator confirmation — copied unchanged.
 *
 * The contrast with the additive {@link carryForwardResourceBinding} is exactly SL-5.1's
 * "retains vs drops": additive **drops** any ref the new IR no longer resolves; the breaking
 * path copies everything here and defers the decision to
 * `ScopeLifecycleService.revalidateSpecBindings`, which **retains** a broken ref but returns
 * it to unconfirmed (so it pauses the rule rather than silently reverting to a permissive
 * default — see the SS-16 policy's "invalidated artifacts are retained, never dropped"). The
 * one thing dropped is a binding whose resource **group** is gone from the new IR (the whole
 * binding is moot — SL-4 stales the mapping over that resource), mirroring the additive
 * drop-the-moot-binding guard. Pure (`newId` supplied by the caller).
 */
export function carryForwardResourceBindingVerbatim(
  prior: ResourceBinding,
  newSpecId: string,
  newId: string,
  newIr: Ir,
): ResourceBinding | undefined {
  if (!newIr.some((group) => group.resourceRef === prior.resourceRef)) {
    return undefined;
  }
  return { ...prior, id: newId, apiSpecId: newSpecId };
}

/**
 * **SL-5.2 — whether a `SyncRule.pollOperationRef` still resolves to an operation in the
 * new IR.** `pollOperationRef` is either a bare `operationId` or the serialized
 * `resourceRef/operationId` form; the leading (slash-free) `resourceRef` is split off the
 * **first** `/` exactly as the source binding resolver's `parseOperationRef` does (a
 * synthetic operationId — Vikunja's `"get /tasks/{id}"` — itself contains slashes). The
 * operation is looked up across **all** groups: "does the operation the Poller pins still
 * exist in the new spec". A removed or renamed poll operation returns `false` → the caller
 * clears the ref and the rule pauses. Pure.
 */
export function pollOperationResolves(pollOperationRef: string, ir: Ir): boolean {
  const slash = pollOperationRef.indexOf("/");
  const operationId =
    slash > 0 && slash < pollOperationRef.length - 1
      ? pollOperationRef.slice(slash + 1)
      : pollOperationRef;
  return ir.some((group) =>
    group.operations.some((operation) => operation.operationId === operationId),
  );
}

/**
 * SL-2.1 — the audit row that records one re-pin. Written as a `mapping-decision`
 * entry attributed to `system` (the reaction is automatic, driven by the diff — not an
 * operator): the existing audit vocabulary carries no dedicated re-pin type, and adding
 * one is a schema migration this deterministic slice deliberately avoids. `details` is
 * metadata only — the side that advanced and the spec ids/version — never a secret.
 */
export function repinAuditEntry(
  mapping: ApprovedMapping,
  supersededSpec: ApiSpec,
  newSpec: ApiSpec,
  now: Date,
): AuditLogEntry {
  const side = changedSide(mapping, supersededSpec.id);
  return {
    id: randomUUID(),
    type: "mapping-decision",
    actor: "system",
    relatedMappingId: mapping.id,
    details: `re-pinned ${side} spec ${supersededSpec.id} -> ${newSpec.id} (v${String(newSpec.version)})`,
    timestamp: now,
  };
}

/**
 * SL-4.1 — the audit row that records one mapping going `stale` because it references a
 * changed element. Same `mapping-decision`/`system` shape and metadata-only discipline as
 * {@link repinAuditEntry} (no dedicated stale audit type is coined — no migration in this
 * slice): the side whose spec broke and the superseded/new spec ids, never a secret. Makes
 * the stale transition queryable in the audit log alongside the re-pins (SL-4.5).
 */
export function staleAuditEntry(
  mapping: ApprovedMapping,
  supersededSpec: ApiSpec,
  newSpec: ApiSpec,
  now: Date,
): AuditLogEntry {
  const side = changedSide(mapping, supersededSpec.id);
  return {
    id: randomUUID(),
    type: "mapping-decision",
    actor: "system",
    relatedMappingId: mapping.id,
    details: `marked stale: references a changed element on the ${side} spec ${supersededSpec.id} (breaking advance -> ${newSpec.id} v${String(newSpec.version)}); stays pinned to ${supersededSpec.id}`,
    timestamp: now,
  };
}

/** Which side of a mapping pinned the now-superseded spec — for audit `details` (metadata only). */
function changedSide(
  mapping: Pick<ApprovedMapping, "sourceSpecId" | "targetSpecId">,
  supersededSpecId: string,
): "source" | "target" | "source+target" {
  return mapping.sourceSpecId === supersededSpecId
    ? mapping.targetSpecId === supersededSpecId
      ? "source+target"
      : "source"
    : "target";
}
