import { randomUUID } from "node:crypto";

import type { DetectionJobScope } from "@mediator/db";
import type {
  ApiSpec,
  ApiSpecRole,
  AppCapabilities,
  ApprovedMapping,
  AuditLogEntry,
  Ir,
  ResourceBinding,
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
  type SpecDiff,
} from "@mediator/ir";

import type { TxStores } from "./persistence.js";

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
   * Deliberately **out of scope here** (owned by later slices, so the boundary stays
   * clean): any **breaking**-change reaction — a breaking diff advances the version but
   * marks no mapping `stale`, re-pins nothing, and carries nothing forward (SL-4…SL-6).
   * **No `SpecIngested` is emitted** on any branch (that event triggers a *full* detection
   * analysis; the SL-2…SL-6 reactions are the diff's scoped consumers instead). After a
   * **breaking** advance an active mapping may still reference the now-`superseded`
   * prior version — the expected intermediate the breaking reactions resolve.
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

    // A breaking advance stops here (SL-4…SL-6 own its reaction): no re-pin, no
    // carry-forward, no stale-marking.
    return { kind: "advanced", newSpec, supersededSpec, diff };
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
      const pair = repinnedSpecPair(mapping, supersededSpec.id, newSpec.id);
      await tx.approvedMappings.repinSpecs(mapping.id, pair.sourceSpecId, pair.targetSpecId);
      await tx.audit.insert(repinAuditEntry(mapping, supersededSpec, newSpec, now));
    }

    // (2) Carry forward the analysis exclusions, dropping any that no longer resolve.
    const carriedExclusions = carryForwardAnalysisExclusions(
      supersededSpec.analysisExclusions,
      newSpec.parsedIR,
    );
    const updated = await tx.apiSpecs.updateAnalysisExclusions(newSpec.id, carriedExclusions);

    // (3) Carry forward the resource bindings as fresh rows on the new version.
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

    return updated ?? { ...newSpec, analysisExclusions: carriedExclusions };
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

/**
 * SL-2.1 — the audit row that records one re-pin. Written as a `mapping-decision`
 * entry attributed to `system` (the reaction is automatic, driven by the diff — not an
 * operator): the existing audit vocabulary carries no dedicated re-pin type, and adding
 * one is a schema migration this deterministic slice deliberately avoids. `details` is
 * metadata only — the side that advanced and the spec ids/version — never a secret.
 */
function repinAuditEntry(
  mapping: ApprovedMapping,
  supersededSpec: ApiSpec,
  newSpec: ApiSpec,
  now: Date,
): AuditLogEntry {
  const side =
    mapping.sourceSpecId === supersededSpec.id
      ? mapping.targetSpecId === supersededSpec.id
        ? "source+target"
        : "source"
      : "target";
  return {
    id: randomUUID(),
    type: "mapping-decision",
    actor: "system",
    relatedMappingId: mapping.id,
    details: `re-pinned ${side} spec ${supersededSpec.id} -> ${newSpec.id} (v${String(newSpec.version)})`,
    timestamp: now,
  };
}
