import { randomUUID } from "node:crypto";

import type { ApiSpec, ApiSpecRole, AppCapabilities, Ir } from "@mediator/domain";
import { createSpecIngested } from "@mediator/event-bus";
import {
  buildIr,
  computeContentHash,
  deriveResourceBindings,
  diffSpec,
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
   * Deliberately **out of scope here** (owned by later slices, so the boundary stays
   * clean): applying either reaction — no mapping is re-pinned or set `stale`, no
   * `ResourceBinding`/`analysisExclusions` carry-forward (SL-2), and **no
   * `SpecIngested` is emitted** (that event triggers a *full* detection analysis; the
   * SL-2…SL-6 reactions are the diff's scoped consumers instead). Between this
   * transition and those reactions an active mapping may still reference the now-
   * `superseded` prior version — the expected intermediate the reactions resolve.
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

    return {
      kind: "advanced",
      newSpec,
      // `updateStatus` returns undefined only if the row vanished mid-transaction (it
      // did not — we just read it); fall back to the known prior with its new status.
      supersededSpec: superseded ?? { ...active, status: "superseded" },
      diff,
    };
  }
}
