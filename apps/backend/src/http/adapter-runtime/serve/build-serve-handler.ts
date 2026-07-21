import type { ServeHandler } from "@mediator/adapter-engine";
import {
  CredentialStore,
  DbCredentialAccessAuditor,
  DbCredentialPersistence,
  EnvKeyProvider,
  type CredentialStoreLogger,
} from "@mediator/credentials";
import type { Database } from "@mediator/db";
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
import { DbServeContextLoader } from "./serve-context.js";
import { AdapterServeHandler } from "./serve-handler.js";

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
    logger: {
      warn: (fields, message) => {
        deps.logger.warn(fields, message);
      },
    },
  });
}
