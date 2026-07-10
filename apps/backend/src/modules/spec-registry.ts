import { randomUUID } from "node:crypto";

import type { ApiSpec, ApiSpecRole, AppCapabilities, Ir } from "@mediator/domain";
import { createSpecIngested } from "@mediator/event-bus";
import { buildIr, computeContentHash, deriveResourceBindings } from "@mediator/ir";

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
}
