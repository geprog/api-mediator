import type { AppConfig } from "@mediator/config";
import { EnvKeyProvider, type CredentialStoreLogger } from "@mediator/credentials";
import {
  ApiSpecRepository,
  MappingProposalRepository,
  RegisteredAppRepository,
  ResourceBindingRepository,
  ScopeCorrespondenceRepository,
  closeDb,
  tx,
  type Database,
} from "@mediator/db";
import { PostgresEventBus } from "@mediator/event-bus";
import { PROMPT_VERSION } from "@mediator/llm";
import { getActiveTraceContext, shutdownTelemetry } from "@mediator/telemetry";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino } from "pino";

import { AnalysisExclusionsService } from "./modules/analysis-exclusions.js";
import {
  ApprovalService,
  DbApprovalUnitOfWork,
  EscapeHatchService,
  ProposalReadService,
  createEscapeHatchTelemetry,
} from "./modules/approval/index.js";
import { createDetectionMetricsSink } from "./modules/detection/telemetry.js";
import { createMappingProvider } from "./modules/detection/provider.js";
import { DbUnitOfWork } from "./modules/persistence.js";
import { RegistrationService } from "./modules/registration.js";
import { ResourceBindingService } from "./modules/resource-bindings.js";
import { ScopeLinkAuthoringResolver } from "./modules/scope-authoring.js";
import { SpecRegistry } from "./modules/spec-registry.js";
import { SyncOperatorService, type SyncOperatorEngine } from "./modules/sync/operator.js";
import { LocalAccountsAuthProvider } from "./http/auth/index.js";
import { registerErrorHandler } from "./http/errors.js";
import { registerAuthenticatedOperatorApi, type OperatorApiDeps } from "./http/operator/api.js";
import { pingDatabase, registerHealthRoute } from "./http/operator/health.js";

/**
 * Explicit composition root for the operator API — no DI framework.
 *
 * `buildServer` receives an already-loaded {@link AppConfig}, a {@link Database},
 * and a {@link Logger} rather than constructing config/db itself, which (a) keeps
 * the wiring in one place and (b) makes the server unit-testable against a fake
 * database. It builds the Fastify instance, registers routes, and returns a
 * `shutdown` that tears the process down in the right order.
 *
 * The logger is built once ({@link createServerLogger}) and shared: Fastify logs
 * through it (`loggerInstance`) and the caller wires the same instance to the db
 * pool's `'error'` handler, so a dropped idle connection is logged rather than
 * fatal, in the same format as every other log line.
 */

export interface ServerDependencies {
  readonly config: AppConfig;
  readonly db: Database;
  readonly logger: FastifyBaseLogger;
  /**
   * The Sync Engine runtime's operator surface (`buildSyncBackground`), threaded in
   * so the Phase-4 Sync HTTP API (SA-1..SA-3) can reach its enable/disable + Identity
   * Resolution seams. Optional: a server built without it (e.g. a Phase-1..3
   * integration test) simply does not mount the sync operator routes. The composition
   * root builds the sync background around `buildServer` and owns its start/stop loops.
   */
  readonly sync?: SyncOperatorEngine;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  /**
   * Graceful teardown: stop accepting/drain HTTP requests, then close the DB
   * pool, then flush and shut down telemetry last (so shutdown itself is still
   * observable).
   */
  readonly shutdown: () => Promise<void>;
}

/**
 * A pino `mixin` that stamps the active span's `traceId`/`spanId` onto every log
 * record, so logs correlate with traces in Grafana. When telemetry is disabled
 * or there is no active span, {@link getActiveTraceContext} returns `null` and
 * the fields are simply absent — never a crash. camelCase deliberately matches
 * the data model's `SyncEvent.traceId`/`spanId`; the OTel pino instrumentation's
 * own snake_case log-correlation is disabled in `@mediator/telemetry` so records
 * carry exactly this one pair.
 */
function traceContextMixin(): Record<string, string> {
  const traceContext = getActiveTraceContext();
  if (traceContext === null) {
    return {};
  }
  return { traceId: traceContext.traceId, spanId: traceContext.spanId };
}

/**
 * Build the single pino logger for the operator API, typed as the Fastify logger
 * interface it will drive. Shared by Fastify (`loggerInstance`) and the db
 * pool-error handler so all logs share one format and the trace-context mixin.
 */
export function createServerLogger(config: AppConfig): FastifyBaseLogger {
  const serviceName = config.telemetry.enabled ? config.telemetry.serviceName : "api-mediator";
  return pino({ name: serviceName, mixin: traceContextMixin });
}

/**
 * Construct the operator `/api` dependency graph with explicit constructor
 * wiring (no DI framework): the Credential Store's {@link EnvKeyProvider} from
 * the config master key, the {@link PostgresEventBus}, the transactional
 * {@link DbUnitOfWork}, the {@link SpecRegistry}, the registration/mutation
 * services, and the pooled reader repositories.
 *
 * The Credential Store logs metadata only — the injected {@link CredentialStoreLogger}
 * forwards its structured fields (`credentialId`/`appId`/`type`/`scopeCount`,
 * never a secret) through the shared server logger.
 */
function buildOperatorApiDeps(deps: ServerDependencies): OperatorApiDeps {
  const { config, db, logger } = deps;

  const keyProvider = new EnvKeyProvider(config.credentials.masterKey);
  const eventBus = new PostgresEventBus();
  const credentialLogger: CredentialStoreLogger = {
    info: (message, fields) => {
      logger.info(fields, message);
    },
  };
  const unitOfWork = new DbUnitOfWork(db, keyProvider, eventBus, credentialLogger);
  const specRegistry = new SpecRegistry();
  const specReader = new ApiSpecRepository(db);

  // ── Phase-3 Review & Approval slice (RA-1..RA-5) ───────────────────────────
  // Kept in one clearly-scoped block to minimize conflict with the concurrent
  // slice that also edits this file. The Approval Service does all of its reads
  // and writes in one transaction via `DbApprovalUnitOfWork`; the read side and
  // escape hatch use pooled reads plus (for the escape-hatch attach) a `tx`. The
  // escape hatch gets its own provider instance (a dedicated `lastUsage` seam,
  // separate from the detection background's provider).
  const proposalRepo = new MappingProposalRepository(db);
  const escapeHatchProvider = createMappingProvider(config.mappingLlm);
  const approvalService = new ApprovalService({
    unitOfWork: new DbApprovalUnitOfWork(db, eventBus),
  });
  const proposalReadService = new ProposalReadService({
    proposals: proposalRepo,
    specs: specReader,
    reviewThreshold: config.mappingLlm.reviewThreshold,
  });
  const escapeHatchService = new EscapeHatchService({
    proposals: proposalRepo,
    specs: specReader,
    detection: {
      provider: escapeHatchProvider,
      maxRetries: config.mappingLlm.maxRetries,
      promptVersion: PROMPT_VERSION,
    },
    writer: {
      attach: ({ proposalId, items, shortlistResult }) =>
        tx(db, async (txn) => {
          const repo = new MappingProposalRepository(txn);
          await repo.addItems([...items]);
          await repo.setShortlistResult(proposalId, shortlistResult);
        }),
    },
    metricsSink: createDetectionMetricsSink(escapeHatchProvider.providerId),
    telemetry: createEscapeHatchTelemetry(escapeHatchProvider.providerId),
  });

  return {
    registrar: new RegistrationService({
      unitOfWork,
      specRegistry,
      defaultPollInterval: config.registration.defaultPollInterval,
    }),
    bindingConfirmer: new ResourceBindingService({ unitOfWork }),
    // SS-18.4 — the kind-selector context reader: the pair's proposed `ScopeCorrespondence`
    // (`scope-link` selectable) + the container binding behind the derived `scopeKeyRef`.
    scopeLinkAuthoring: new ScopeLinkAuthoringResolver({
      correspondences: new ScopeCorrespondenceRepository(db),
      repos: { apiSpecs: specReader, resourceBindings: new ResourceBindingRepository(db) },
    }),
    exclusionsReplacer: new AnalysisExclusionsService({ unitOfWork }),
    appReader: new RegisteredAppRepository(db),
    specReader,
    bindingReader: new ResourceBindingRepository(db),
    proposalReadService,
    approvalService,
    escapeHatchService,
    // Phase-4 Sync HTTP API (SA-1..SA-3): built over the Sync Engine runtime's
    // operator surface + the pooled db (reads + the config/attribution `tx`). Only
    // present when the sync background is wired in.
    ...(deps.sync !== undefined ? { sync: new SyncOperatorService({ db, sync: deps.sync }) } : {}),
    // TEST/DEV-ONLY: gate the deterministic poll-trigger route on the config flag
    // (default false — off in production/dev; only the SU-6 e2e sets it). `api.ts`
    // additionally requires the sync runtime, so the route is absent unless both hold.
    syncTestPollTrigger: config.sync.testPollTrigger,
  };
}

export function buildServer(deps: ServerDependencies): RunningServer {
  const app = Fastify({ loggerInstance: deps.logger });

  // Health stays outside the authenticated context so orchestration probes reach
  // it unauthenticated; the operator API is mounted inside a context that first
  // requires an authenticated principal (OA-1).
  registerHealthRoute(app, { pingDb: () => pingDatabase(deps.db) });
  const authProvider = new LocalAccountsAuthProvider(deps.config.auth.accounts);
  registerAuthenticatedOperatorApi(app, buildOperatorApiDeps(deps), authProvider);
  registerErrorHandler(app);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeDb(deps.db);
    await shutdownTelemetry();
  };

  return { app, shutdown };
}
