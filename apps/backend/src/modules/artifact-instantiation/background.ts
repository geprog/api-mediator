import { randomUUID } from "node:crypto";

import {
  ApprovedMappingRepository,
  DownstreamArtifactRepository,
  MappingArtifactsRepository,
  tx,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import type { EventConsumer, Reconciler } from "@mediator/event-bus";

import { MappingApprovedInstantiationConsumer, type LoadedApprovedMapping } from "./consumer.js";
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

  const consumer = new MappingApprovedInstantiationConsumer<DbTransaction>({
    load,
    ops: (handle) => new DownstreamArtifactRepository(handle),
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
      }),
  });

  return { consumer, reconciler };
}
