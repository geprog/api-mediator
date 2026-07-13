/**
 * `@mediator/outbound` — the **Outbound Call Executor** and the REST **Protocol
 * Client** (Phase 4, OC-1..OC-5 criteria in scope). The single choke point through
 * which all outbound sync traffic passes: the deterministic idempotency key (OC-2),
 * per-app load discipline (OC-3), authenticated REST calls inside a `withCredential`
 * scope through the named Protocol Client seam (OC-1), retry/park routing (OC-4, via
 * the ordering queue), and one `SyncEvent` per resolved call (OC-5 crit 1 & 4).
 * Shared with the Adapter Engine (Phase 5); Phase 4 stands it up for sync.
 *
 * Security invariants realized here: credential material is used only inside
 * `withCredential` and never logged/returned/audited; no live payload value reaches
 * a log, a `SyncEvent`, an error, or an LLM — only hashes/ids/status/short notes.
 */

// The Protocol Client seam + its REST request/response + operation-binding shapes.
export type {
  HttpMethod,
  OutboundRequest,
  OutboundResponse,
  ParameterLocation,
  ProtocolClient,
  RestOperationBinding,
} from "./protocol-client.js";

// The REST implementation of the Protocol Client seam (OC-1).
export {
  FetchRestProtocolClient,
  OutboundTransportError,
  type FetchRestProtocolClientOptions,
  type HttpFetch,
  type HttpFetchInit,
  type HttpFetchResponse,
} from "./rest-protocol-client.js";

// The deterministic idempotency key + payload hash (OC-2).
export {
  canonicalJson,
  computeDeleteIdempotencyKey,
  computePayloadHash,
  computeWriteIdempotencyKey,
  type DeleteKeyInput,
  type PriorReconciledState,
  type WriteKeyInput,
} from "./idempotency.js";

// Per-app load discipline (OC-3).
export {
  AppLoadGovernor,
  type AcquireResult,
  type AppLoadGovernorOptions,
} from "./load-governor.js";

// The REST source reader — the Sync Engine's SourceReader seam, obeying the same OC-3
// per-app ceilings as writes (SP-2 criterion 4). Lives here (not in @mediator/sync-engine)
// because outbound already depends on sync-engine; the reverse would be a cycle.
export {
  RestSourceReader,
  type RestDeltaConvention,
  type RestDeletionConvention,
  type RestPaginationConvention,
  type RestSourceBindingResolver,
  type RestSourceReadBinding,
  type RestSourceReaderOptions,
} from "./rest-source-reader.js";

// The SyncEvent store port + real + fake (OC-2 lookback / OC-5 write).
export { DbSyncEventStore, FakeSyncEventStore, type SyncEventStore } from "./sync-event-store.js";

// The failure signals + classifier the ordering queue settles outbound calls with (OC-4).
export {
  PermanentOutboundError,
  RetryableOutboundError,
  ThrottledOutboundError,
  classifyOutboundFailure,
  settleOutboundResult,
} from "./errors.js";

// The executor itself (OC-1/2/3/5 + OC-4 disposition).
export {
  OutboundCallExecutor,
  type CredentialAccess,
  type CredentialApplier,
  type OutboundCall,
  type OutboundCallCommon,
  type OutboundCallExecutorOptions,
  type OutboundCallResult,
  type TransformFailureContext,
  type WrittenRepresentation,
} from "./executor.js";
