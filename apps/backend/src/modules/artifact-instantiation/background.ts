import { randomUUID } from "node:crypto";

import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  tx,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type { EventConsumer, Reconciler } from "@mediator/event-bus";

import { GraphProjection } from "../graph/index.js";
import {
  proposeScopeCorrespondences,
  type ScopeCorrespondenceProposalOps,
} from "../scope-authoring.js";
import type { AdapterSuccessorAdopter, SuccessorAdoptionDeps } from "./adopt.js";
import {
  MappingApprovedInstantiationConsumer,
  type LoadedApprovedMapping,
  type ScopeProposalReporter,
} from "./consumer.js";
import { instantiateArtifacts } from "./instantiate.js";
import { ArtifactInstantiationReconciler } from "./reconciler.js";

/**
 * The Phase-3 artifact-instantiation wiring (AI-1..AI-3). It assembles, with
 * explicit constructor wiring (no DI framework), the `MappingApproved`
 * {@link MappingApprovedInstantiationConsumer} and its
 * {@link ArtifactInstantiationReconciler} over the pooled db.
 *
 * It deliberately builds **no** dispatcher of its own: `MappingApproved` rides the
 * SAME transactional outbox as every other event, and a second dispatcher scanning
 * that outbox would claim and mark-published a foreign event (e.g. `SpecIngested`)
 * without a consumer for it. So this returns the consumer + reconciler for the
 * single shared `OutboxDispatcher`/`ReconciliationSweep` to register (see the
 * composition root). The consumer runs INSIDE the dispatcher transaction — its work
 * is pure database (AI-3 criterion 3), so no offload is needed.
 */
export interface ArtifactInstantiationDeps {
  readonly db: Database;
  /**
   * SS-16 — optional sink for the SS-18 `ScopeCorrespondence` proposal outcome. The
   * composition root wires it (from the shared logger) to surface "scoped but underivable"
   * pairs to the operator; omitted, no report is made (existing harnesses unaffected).
   */
  readonly reportScopeProposal?: ScopeProposalReporter;
  /**
   * SL-7/SL-8 — the successor-adoption wiring. When present, an approved mapping carrying a
   * `predecessorMappingId` is adopted in place instead of freshly instantiated: the sync half
   * re-points the predecessor's `SyncRule`s + supersedes it + transfers the counterpart +
   * recomputes the sync `GraphEdge` (via {@link GraphProjection}) on the dispatcher
   * transaction; the adapter half drives CO-7 `adoptSuccessor` in its own transaction via
   * {@link AdapterSuccessorAdopter}. Omitted → no adoption (a Phase-1..5 harness), and a
   * successor (which cannot arise before Phase 6) falls through to fresh instantiation.
   */
  readonly adoption?: {
    readonly graphProjection: GraphProjection;
    readonly adoptAdapter: AdapterSuccessorAdopter;
  };
  /** Id factory for the instantiated rows; defaults to `crypto.randomUUID`. */
  readonly newId?: () => string;
}

export interface ArtifactInstantiation {
  readonly consumer: EventConsumer<DbTransaction>;
  readonly reconciler: Reconciler;
}

export function buildArtifactInstantiation(deps: ArtifactInstantiationDeps): ArtifactInstantiation {
  const { db } = deps;
  const newId = deps.newId ?? ((): string => randomUUID());

  // Load the ApprovedMapping + children through a given transaction handle — shared
  // by the live consumer (the dispatcher tx) and the reconciler (its own tx).
  const load = async (
    approvedMappingId: string,
    handle: DbTransaction,
  ): Promise<LoadedApprovedMapping | undefined> => {
    const mapping = await new ApprovedMappingRepository(handle).getById(approvedMappingId);
    if (mapping === undefined) {
      return undefined;
    }
    const artifacts = new MappingArtifactsRepository(handle);
    const [fields, operations] = await Promise.all([
      artifacts.listFieldMappings(approvedMappingId),
      artifacts.listOperationMappings(approvedMappingId),
    ]);
    return { mapping, fields, operations };
  };

  // SS-18.1 — the transaction-bound ops the `ScopeCorrespondence` proposal runs through:
  // the two specs' IR + `ResourceBinding`s to derive from, and the idempotent
  // never-clobbering `propose` to write with (SS-18.6).
  const scopeProposalOps = (handle: DbTransaction): ScopeCorrespondenceProposalOps => ({
    specs: new ApiSpecRepository(handle),
    bindings: new ResourceBindingRepository(handle),
    correspondences: new ScopeCorrespondenceRepository(handle),
  });

  // SL-7/SL-8 — the successor-adoption capability, bound to the dispatcher transaction. The
  // sync half runs on the same handle as the artifact instantiation (so the re-point +
  // supersede + counterpart transfer + sync GraphEdge recompute commit atomically with the
  // `processed_event` ledger); the adapter half is driven in CO-7's own transaction.
  const adoptionDeps = deps.adoption;
  const adoption: SuccessorAdoptionDeps<DbTransaction> | undefined =
    adoptionDeps === undefined
      ? undefined
      : {
          syncOps: (handle) => ({
            getApprovedMapping: (id) => new ApprovedMappingRepository(handle).getById(id),
            repointSyncRulesToSuccessor: (supersededMappingId, successorMappingId) =>
              new DownstreamArtifactRepository(handle).repointSyncRulesToSuccessor(
                supersededMappingId,
                successorMappingId,
              ),
            markSuperseded: async (id) => {
              await new ApprovedMappingRepository(handle).markSuperseded(id);
            },
            setCounterpart: (id, counterpartMappingId) =>
              new ApprovedMappingRepository(handle).setCounterpart(id, counterpartMappingId),
            recomputeSyncEdge: (sourceAppId, targetAppId) =>
              adoptionDeps.graphProjection.recomputeSyncEdgeWithin(
                handle,
                sourceAppId,
                targetAppId,
              ),
          }),
          adoptAdapter: adoptionDeps.adoptAdapter,
        };

  const consumer = new MappingApprovedInstantiationConsumer<DbTransaction>({
    load,
    ops: (handle) => new DownstreamArtifactRepository(handle),
    scopeProposalOps,
    ...(deps.reportScopeProposal !== undefined
      ? { reportScopeProposal: deps.reportScopeProposal }
      : {}),
    ...(adoption !== undefined ? { adoption } : {}),
    newId,
  });

  const reconciler = new ArtifactInstantiationReconciler({
    findMissingMappingIds: () =>
      new DownstreamArtifactRepository(db).listActiveMappingIdsWithoutArtifacts(),
    instantiate: (approvedMappingId) =>
      tx(db, async (handle) => {
        const loaded = await load(approvedMappingId, handle);
        if (loaded === undefined) {
          return;
        }
        await instantiateArtifacts({
          mapping: loaded.mapping,
          fields: loaded.fields,
          operations: loaded.operations,
          ops: new DownstreamArtifactRepository(handle),
          newId,
        });
        // The reconciler re-derives the WHOLE reaction, proposal included (SS-18.6's
        // "a re-run instantiation" case) — idempotent, so a pair that already has a
        // correspondence keeps exactly the one it has.
        const outcome = await proposeScopeCorrespondences({
          mapping: loaded.mapping,
          fields: loaded.fields,
          operations: loaded.operations,
          ops: scopeProposalOps(handle),
          newId,
        });
        // SS-16 — surface the outcome's underivable skips through the same reporter.
        deps.reportScopeProposal?.(outcome, { approvedMappingId });
      }),
  });

  return { consumer, reconciler };
}
