import type { ServeHandler } from "@mediator/adapter-engine";
import {
  CredentialStore,
  DbCredentialAccessAuditor,
  DbCredentialPersistence,
  EnvKeyProvider,
  type CredentialStoreLogger,
} from "@mediator/credentials";
import { AdapterWriteOutcomeRepository, RecordLinkRepository, type Database } from "@mediator/db";
import {
  AppLoadGovernor,
  FetchRestProtocolClient,
  type CredentialApplier,
  type ProtocolClient,
} from "@mediator/outbound";
import { getActiveTraceContext } from "@mediator/telemetry";
import type { FastifyBaseLogger } from "fastify";

import { createCredentialApplier } from "../../../modules/sync/credential-applier.js";
import { AdapterBackendCaller } from "./backend-call.js";
import { InProcessResponseCache, type ResponseCacheMetrics } from "./response-cache.js";
import { DbServeContextLoader } from "./serve-context.js";
import { AdapterServeHandler } from "./serve-handler.js";
import { RecordLinkUnionLinkResolver } from "./union-links.js";
import { DbWriteOutcomeStore } from "./write-outcome-store.js";

/**
 * Wire the concrete {@link ServeHandler} (RP/TE/AG) the Adapter Server Runtime injects
 * behind its Protocol-Server seam. It composes the **real** Phase-4 machinery — the
 * `CredentialStore` `withCredential` decrypt-for-use path, the REST `ProtocolClient`,
 * the shared per-app `AppLoadGovernor`, and the composition-root `CredentialApplier` —
 * around the pure RP/TE/AG stages. No new outbound/credential/governor code is coined;
 * the serve handler reuses these seams exactly as the Sync Engine does.
 */
export interface BuildAdapterServeHandlerDeps {
  readonly db: Database;
  readonly logger: FastifyBaseLogger;
  /** The decoded 32-byte credential store master key (`config.credentials.masterKey`). */
  readonly credentialMasterKey: Buffer;
  /**
   * The **shared** per-app load governor (OC-3 / TE-2.4). Pass the Sync Engine's
   * instance so adapter + sync traffic compete for one ceiling per backend app.
   */
  readonly loadGovernor: AppLoadGovernor;
  /** The REST Protocol Client; default {@link FetchRestProtocolClient}. Overridable in tests. */
  readonly protocolClient?: ProtocolClient;
  /** How a decrypted secret becomes request auth; default the composition-root applier. */
  readonly credentialApplier?: CredentialApplier;
  /** AG-5.1 — the config-defined per-request union row ceiling; default when omitted. */
  readonly unionRowCeiling?: number;
  /**
   * CH-1.5 — the response-cache hit/miss metric seam (the shared `AdapterTelemetry`
   * satisfies it). Optional: when omitted the cache metric is a no-op, so a serve handler
   * built in isolation (integration tests) needs no telemetry wiring.
   */
  readonly cacheMetrics?: ResponseCacheMetrics;
  /** CH-1.4 — injected clock so tests can drive TTL deterministically; default real time. */
  readonly now?: () => Date;
}

export function buildAdapterServeHandler(deps: BuildAdapterServeHandlerDeps): ServeHandler {
  const credentialLogger: CredentialStoreLogger = {
    info: (message, fields) => {
      deps.logger.info(fields, message);
    },
  };
  const credentialStore = new CredentialStore(
    new DbCredentialPersistence(deps.db),
    new EnvKeyProvider(deps.credentialMasterKey),
    credentialLogger,
    { auditor: new DbCredentialAccessAuditor(deps.db), readTraceContext: getActiveTraceContext },
  );

  const protocol = deps.protocolClient ?? new FetchRestProtocolClient();
  const applyCredential = deps.credentialApplier ?? createCredentialApplier();
  const backendCaller = new AdapterBackendCaller(protocol, credentialStore, deps.loadGovernor, {
    applyCredential,
  });

  return new AdapterServeHandler({
    loader: new DbServeContextLoader(deps.db),
    backendCaller,
    // AG-3.3 — link-based dedup reads existing `RecordLink`s over the same DB. The bounded
    // paged union reader (AG-5) defaults to one over `backendCaller` inside the handler, so
    // it needs no explicit wiring here.
    unionLinkResolver: new RecordLinkUnionLinkResolver(new RecordLinkRepository(deps.db)),
    // WR-3 — the bounded write-outcome store the write serve path deduplicates against
    // (default 24h dedup window, matching the Phase-4 OC-2 lookback). Read serving never
    // consults it.
    writeOutcomeStore: new DbWriteOutcomeStore(new AdapterWriteOutcomeRepository(deps.db)),
    // CH-1 — the real in-process response cache; it activates only for endpoints with a
    // `cacheTtl` set, so a serve handler built here caches read responses when composed to.
    responseCache: new InProcessResponseCache(),
    ...(deps.cacheMetrics !== undefined ? { cacheMetrics: deps.cacheMetrics } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.unionRowCeiling !== undefined ? { unionRowCeiling: deps.unionRowCeiling } : {}),
    logger: {
      warn: (fields, message) => {
        deps.logger.warn(fields, message);
      },
    },
  });
}
