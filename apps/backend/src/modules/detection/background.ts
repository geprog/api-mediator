import type { AppConfig } from "@mediator/config";
import {
  DetectionJobRepository,
  EventOutboxRepository,
  ProcessedEventRepository,
  tx,
  type Database,
  type DbTransaction,
} from "@mediator/db";
import {
  ConsumerRegistry,
  OutboxDispatcher,
  ReconciliationSweep,
  type EventConsumer,
  type Reconciler,
} from "@mediator/event-bus";
import { PROMPT_VERSION, type LLMMappingProvider } from "@mediator/llm";
import {
  createDbProposalStore,
  createDbSpecSource,
  runDetectionForSpec,
  type RunDetectionDeps,
} from "@mediator/mapping-engine";
import type { FastifyBaseLogger } from "fastify";

import { SpecIngestedDetectionConsumer } from "./consumer.js";
import { createMappingProvider } from "./provider.js";
import { DetectionReconciler } from "./reconciler.js";
import { createDetectionMetricsSink, type DetectionMetricsSink } from "./telemetry.js";
import { DetectionWorker } from "./worker.js";

/**
 * The Phase-2 detection-trigger background wiring (deliverable 6). It assembles,
 * with explicit constructor wiring (no DI framework):
 *
 *  - the active {@link LLMMappingProvider} from config (Ollama today, pluggable);
 *  - the engine {@link RunDetectionDeps} (spec source + proposal store adapters
 *    over the pooled db, the provider, the retry cap, and the telemetry sink wired
 *    to `onMetrics`);
 *  - the `SpecIngested` {@link SpecIngestedDetectionConsumer}, registered on an
 *    {@link OutboxDispatcher} so ingestion enqueues a job **inside the dispatcher
 *    transaction** with no LLM work;
 *  - the {@link DetectionWorker}, which claims jobs and runs detection **outside**
 *    that transaction;
 *  - the {@link DetectionReconciler}, registered on a {@link ReconciliationSweep}.
 *
 * `start()` runs the dispatcher, worker, and a periodic reconciliation sweep on
 * `unref`'d poll loops; `stop()` stops them (in-flight passes finish). The
 * dispatcher/worker/sweep are also returned so a test can drive their `runOnce()`/
 * `runSweep()` deterministically.
 *
 * This owns the **single** `OutboxDispatcher` over the shared `event_outbox`, so
 * other Phase-3+ reaction modules whose consumers must see the same outbox
 * (e.g. the `MappingApproved` artifact-instantiation consumer) register on it via
 * `additionalConsumers`/`additionalReconcilers` rather than standing up a second
 * dispatcher — a second dispatcher scanning the same outbox would claim and
 * mark-published a foreign event (an event with no consumer in its OWN registry)
 * before the intended consumer ran.
 */

export interface DetectionBackgroundDeps {
  readonly db: Database;
  readonly config: AppConfig;
  readonly logger: FastifyBaseLogger;
  /**
   * Override the LLM provider. Production omits it (built from config); tests pass
   * a `FakeProvider` so no live model is touched.
   */
  readonly provider?: LLMMappingProvider;
  /** Override the metrics sink (tests may pass a recording/no-op sink). */
  readonly metricsSink?: DetectionMetricsSink;
  /**
   * Extra Event Bus consumers to register on the shared dispatcher (Phase-3+
   * reactions to other event types, e.g. `MappingApproved`). Registered after the
   * detection consumer, so each is delivered every event of the types it handles.
   */
  readonly additionalConsumers?: readonly EventConsumer<DbTransaction>[];
  /** Extra reconcilers to register on the shared reconciliation sweep. */
  readonly additionalReconcilers?: readonly Reconciler[];
}

export interface DetectionBackground {
  readonly dispatcher: OutboxDispatcher<DbTransaction>;
  readonly worker: DetectionWorker<DbTransaction>;
  readonly sweep: ReconciliationSweep;
  /** Start the dispatcher, worker, and periodic reconciliation sweep loops. */
  start(): void;
  /** Stop all loops (an in-flight pass is allowed to finish). */
  stop(): void;
}

/** How often the reconciliation sweep re-derives missing detection jobs. */
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export function buildDetectionBackground(deps: DetectionBackgroundDeps): DetectionBackground {
  const { db, config, logger } = deps;

  const provider = deps.provider ?? createMappingProvider(config.mappingLlm);
  const sink = deps.metricsSink ?? createDetectionMetricsSink(provider.providerId);

  const runDetectionDeps: RunDetectionDeps = {
    provider,
    maxRetries: config.mappingLlm.maxRetries,
    promptVersion: PROMPT_VERSION,
    specSource: createDbSpecSource(db),
    proposalStore: createDbProposalStore(db),
    onMetrics: (metrics) => {
      sink.onLlmCall(metrics);
    },
  };

  // The heavy work, run OUTSIDE any dispatcher transaction: the engine opens its
  // own transaction per persisted proposal. Shortlist-yield telemetry is emitted
  // from the run result at this boundary.
  const runDetection = async (apiSpecId: string): Promise<void> => {
    const result = await runDetectionForSpec(apiSpecId, runDetectionDeps);
    sink.onDetectionRun(result);
  };

  // ── Consumer + dispatcher: enqueue-in-tx, no LLM ──────────────────────────
  const registry = new ConsumerRegistry<DbTransaction>();
  registry.register(
    new SpecIngestedDetectionConsumer<DbTransaction>((apiSpecId, txn) =>
      new DetectionJobRepository(txn).enqueue(apiSpecId),
    ),
  );
  // Other Phase-3+ reactions share this single dispatcher (see the class comment).
  for (const consumer of deps.additionalConsumers ?? []) {
    registry.register(consumer);
  }
  const dispatcher = new OutboxDispatcher<DbTransaction>(
    db,
    (txn) => new EventOutboxRepository(txn),
    (txn) => new ProcessedEventRepository(txn),
    registry,
    {
      onError: (error) => {
        logger.error({ err: describeError(error) }, "outbox dispatcher pass failed");
      },
    },
  );

  // ── Worker: claim + run detection outside the dispatcher tx ────────────────
  const worker = new DetectionWorker<DbTransaction>({
    scope: db,
    jobs: (txn) => new DetectionJobRepository(txn),
    runDetection,
    onError: (error) => {
      logger.error({ err: describeError(error) }, "detection worker pass failed");
    },
  });

  // ── Reconciler + sweep: re-derive missing detection jobs ───────────────────
  const reconciler = new DetectionReconciler({
    findMissingSpecIds: () => new DetectionJobRepository(db).listActiveSpecIdsWithoutDetectionJob(),
    enqueue: (apiSpecId) => tx(db, (txn) => new DetectionJobRepository(txn).enqueue(apiSpecId)),
  });
  const sweep = new ReconciliationSweep();
  sweep.register(reconciler);
  for (const extra of deps.additionalReconcilers ?? []) {
    sweep.register(extra);
  }

  // A small `unref`'d, re-entrancy-guarded loop for the sweep (mirrors the
  // dispatcher/worker loops). A richer scheduler is a Phase-6 concern.
  let sweepTimer: NodeJS.Timeout | undefined;
  let sweepRunning = false;
  let sweepTicking = false;

  const scheduleSweep = (): void => {
    const timer = setTimeout(() => {
      void tickSweep();
    }, DEFAULT_SWEEP_INTERVAL_MS);
    timer.unref();
    sweepTimer = timer;
  };
  const tickSweep = async (): Promise<void> => {
    if (!sweepTicking) {
      sweepTicking = true;
      try {
        await sweep.runSweep();
      } catch (error) {
        logger.error({ err: describeError(error) }, "reconciliation sweep failed");
      } finally {
        sweepTicking = false;
      }
    }
    if (sweepRunning) {
      scheduleSweep();
    }
  };

  return {
    dispatcher,
    worker,
    sweep,
    start(): void {
      dispatcher.start();
      worker.start();
      if (!sweepRunning) {
        sweepRunning = true;
        scheduleSweep();
      }
    },
    stop(): void {
      dispatcher.stop();
      worker.stop();
      sweepRunning = false;
      if (sweepTimer !== undefined) {
        clearTimeout(sweepTimer);
        sweepTimer = undefined;
      }
    },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
