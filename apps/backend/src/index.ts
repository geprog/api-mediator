/**
 * `@mediator/backend` entrypoint — the operator API surface.
 *
 * Telemetry is started separately by the `otel.ts` preload (`node --import`),
 * which must run before this module so instrumented libraries are patched. Here
 * we load config, create the database pool, wire the server via the composition
 * root, start listening, and install signal handlers for graceful shutdown.
 */
import { loadConfig } from "@mediator/config";
import { createDb } from "@mediator/db";

import { buildServer, createServerLogger } from "./composition-root.js";
import { loadRepoEnv } from "./env.js";
import {
  AdapterTelemetry,
  buildAdapterCacheInvalidation,
  buildAdapterMountReactions,
  buildAdapterRuntime,
  buildAdapterServeHandler,
  createTokenConsumerAppResolver,
  InProcessResponseCache,
  ResponseCacheInvalidator,
} from "./http/adapter-runtime/index.js";
import { buildAdapterTokenValidator } from "./modules/adapter-token/index.js";
import { buildArtifactInstantiation } from "./modules/artifact-instantiation/background.js";
import { buildScopeProposalReporter } from "./modules/artifact-instantiation/report-scope-proposal.js";
import { buildDetectionBackground } from "./modules/detection/background.js";
import { buildSyncBackground } from "./modules/sync/background.js";

/**
 * Dev binds loopback: both surfaces are host-local. The operator API and the
 * token-gated Adapter Server Runtime are two separate listeners in the **same
 * process** over the **same store**, on their own config-defined ports (RT-1).
 */
const HOST = "127.0.0.1";

loadRepoEnv();
const config = loadConfig();
const logger = createServerLogger(config);
// Wire the shared logger to the pool's 'error' listener so a dropped idle
// connection (Postgres restart, admin shutdown, network partition) is logged and
// survivable — `/health` then returns 503 instead of the process crashing.
const db = createDb(config.database.url, (error) => {
  logger.error({ error: error.message }, "database pool error (idle client) — swallowed");
});
// The Phase-4 sync-engine runtime: the Scheduler/Poller change-detection loop, the
// ordering-queue dispatcher running the per-record pipeline over the real Outbound Call
// Executor + REST client + credential path, and the enable/backfill flow + in-flight
// registry. It stands up NO second dispatcher/sweep — it returns its
// `SyncExecutionReconciler` for the single shared reconciliation sweep below. Built
// BEFORE the server so its operator surface (enable/disable + Identity Resolution) can
// be threaded into the Phase-4 Sync HTTP API (SA-1..SA-3). Its loops are started
// after `listen`, stopped (gracefully — an in-flight poll/backfill/queue pass finishes)
// before the server closes its db pool.
const sync = buildSyncBackground({ config, db, logger });

// CH-3/CH-4/CH-5 — the ONE shared in-process response cache and the single coarse-invalidation
// seam over it. Built BEFORE `buildServer` so the operator API's composition service (CO-6) and
// the Adapter Server Runtime below share the exact same instance: an operator's recompose/
// disable drops the very cache the runtime serves from, over one mechanism (CH-5.6). The serve
// handler serves reads from and (on a successful write) invalidates this cache; the `SyncEvent`
// consumer and the composition service invalidate the same one.
const adapterResponseCache = new InProcessResponseCache();
const adapterCacheInvalidator = new ResponseCacheInvalidator(adapterResponseCache);

const { app, shutdown: shutdownServer } = buildServer({
  config,
  db,
  logger,
  sync,
  cacheInvalidator: adapterCacheInvalidator,
});

// The Phase-5 Adapter Server Runtime (RT-1..RT-5): a SECOND Fastify listener, on its
// own config-defined port, in the same process over the same db. It hosts each active
// CONSUMER spec's operation surface as a virtual provider and answers
// not-yet-mapped / endpoint-disabled / 404 per request. Its mount lifecycle (RT-4) is
// driven by a `SpecIngested` consumer + a reconciler that both re-derive the mounted
// surface from persisted state; they register on the single shared dispatcher/sweep
// below, exactly like the other backgrounds. Its listener is started after the
// operator `listen` (with an initial `reconcile`) and closed before the db pool.
// The Phase-5 Auth Gateway (AT-2..AT-4): the token-validating resolver that replaces
// RT's header stand-in. It validates the caller's `Authorization: Bearer` adapter
// token (constant-time salted-hash equality, still-valid bound, active consumer app)
// in front of everything the runtime does — a missing/unrecognized/expired/foreign
// token never reaches routing, planning, or a backend call (AT-2.1).
const adapterTokenValidator = buildAdapterTokenValidator({
  db,
  rotationOverlapMs: config.adapterAuth.rotationOverlapMs,
});
// The Phase-5 serve pipeline (RP/TE/AG): the real ServeHandler injected behind the
// Protocol-Server seam, replacing RT's `serving-not-implemented` placeholder. It reuses
// the Phase-4 machinery — the CredentialStore withCredential path, the REST
// ProtocolClient, and the SHARED per-app AppLoadGovernor (so adapter fan-out and sync
// share one ceiling per backend, TE-2.4) — around the pure planner/executor/aggregator.
// One shared AdapterTelemetry so the serve handler's response-cache hit/miss counters
// (CH-1.5) and the runtime's request metrics land on the same meter.
const adapterTelemetry = new AdapterTelemetry();
// The shared response cache + invalidation seam are constructed above (before `buildServer`)
// so the operator-API composition service and this serve handler share one instance.
const adapterServeHandler = buildAdapterServeHandler({
  db,
  logger,
  credentialMasterKey: config.credentials.masterKey,
  loadGovernor: sync.loadGovernor,
  cacheMetrics: adapterTelemetry,
  responseCache: adapterResponseCache,
  cacheInvalidator: adapterCacheInvalidator,
});
// CH-3 — the `sync-execution` consumer that drops cached responses for a resource the Sync
// Engine changed, through the same seam the write path uses. Registered on the shared outbox
// dispatcher below (like the other reaction consumers).
const adapterCacheInvalidation = buildAdapterCacheInvalidation({
  invalidator: adapterCacheInvalidator,
});
const adapterRuntime = buildAdapterRuntime({
  db,
  logger,
  serveHandler: adapterServeHandler,
  resolveConsumerApp: createTokenConsumerAppResolver(adapterTokenValidator),
  telemetry: adapterTelemetry,
});
const adapterMountReactions = buildAdapterMountReactions(adapterRuntime.mountManager);

// The Phase-3 artifact-instantiation reaction: the `MappingApproved` consumer that
// instantiates an approval's disabled downstream artifacts (SyncRules /
// AdapterBindings + GraphEdge), plus its reconciler. It builds NO dispatcher of its
// own — it registers on the single shared outbox dispatcher below (a second
// dispatcher over the same outbox would mark a foreign event published without
// delivering it to its consumer).
// SS-16 — surface "scoped but underivable" pairs (SS-18's typed skip reasons) to the
// operator through the shared logger, so a pair that looks scoped yet could not derive a
// `ScopeCorrespondence` is no longer silently dropped on the floor.
const artifactInstantiation = buildArtifactInstantiation({
  db,
  reportScopeProposal: buildScopeProposalReporter(logger),
});

// The Phase-2 detection-trigger background: the Event Bus dispatcher (delivers
// `SpecIngested` to the detection consumer, which enqueues a job), the durable
// `DetectionWorker` (runs the LLM detection off the dispatcher transaction), and
// the periodic reconciliation sweep. It owns the single shared outbox dispatcher +
// reconciliation sweep, so the Phase-3 `MappingApproved` consumer + reconciler and the
// Phase-4 sync-execution reconciler register on it here.
// Started after `listen`, stopped before the server closes its db pool.
const detection = buildDetectionBackground({
  config,
  db,
  logger,
  additionalConsumers: [
    artifactInstantiation.consumer,
    adapterMountReactions.consumer,
    adapterCacheInvalidation.consumer,
  ],
  additionalReconcilers: [
    artifactInstantiation.reconciler,
    sync.reconciler,
    sync.scopeDiscoveryReconciler,
    adapterMountReactions.reconciler,
  ],
});

async function shutdown(): Promise<void> {
  // Stop sync first (it awaits an in-flight poll/backfill/queue pass), then the
  // detection loops, then the adapter listener, then the operator server + db pool.
  await sync.stop();
  detection.stop();
  await adapterRuntime.app.close();
  await shutdownServer();
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "shutdown signal received");
  try {
    await shutdown();
    process.exit(0);
  } catch (error) {
    app.log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "graceful shutdown failed",
    );
    process.exit(1);
  }
}

process.once("SIGTERM", (signal) => {
  void handleSignal(signal);
});
process.once("SIGINT", (signal) => {
  void handleSignal(signal);
});

try {
  await app.listen({ port: config.http.port, host: HOST });
  // Derive the adapter surface from persisted state (RT-4.5) BEFORE the listener
  // accepts traffic, so a mounted operation never briefly answers 404 at boot.
  await adapterRuntime.mountManager.reconcile();
  await adapterRuntime.app.listen({ port: config.adapterHttp.port, host: HOST });
  detection.start();
  sync.start();
} catch (error) {
  app.log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "operator API failed to start",
  );
  await shutdown();
  process.exit(1);
}
