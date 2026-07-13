import { randomUUID } from "node:crypto";

import type {
  AuditLogEntry,
  IrRefTarget,
  OperationMapping,
  OutboundLoadLimits,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";
import type {
  DecryptedCredential,
  UsableCredentialSecret,
  WithCredentialResult,
} from "@mediator/credentials";
import { getActiveTraceContext, type ActiveTraceContext } from "@mediator/telemetry";
import { isTransformError, readPath, type JsonRecord, type JsonValue } from "@mediator/transform";

import {
  computeDeleteIdempotencyKey,
  computePayloadHash,
  computeWriteIdempotencyKey,
  type PriorReconciledState,
} from "./idempotency.js";
import { AppLoadGovernor } from "./load-governor.js";
import type {
  OutboundRequest,
  OutboundResponse,
  ProtocolClient,
  RestOperationBinding,
} from "./protocol-client.js";
import type { SyncEventStore } from "./sync-event-store.js";

/**
 * OC-1 / OC-2 / OC-3 / OC-5 — the **Outbound Call Executor**: the single choke
 * point every outbound sync write passes through. It computes the deterministic
 * idempotency key (OC-2) and deduplicates within a bounded lookback, enforces the
 * target app's load ceilings (OC-3), issues the authenticated REST call inside a
 * `withCredential` scope through the {@link ProtocolClient} seam (OC-1), records
 * exactly one `sync-execution` `SyncEvent` per resolved call (OC-5 criterion 1),
 * and returns a disposition the ordering queue settles into retry / park / defer
 * (OC-4, via `settleOutboundResult` + `classifyOutboundFailure`).
 *
 * Deliberately **deferred** to later slices (OC returns the seam value, does not do
 * the work): re-baselining the written side's `SyncFieldState` + the recently-written
 * cache (OC-5 criterion 2 — EP owns it; OC returns {@link WrittenRepresentation.body}),
 * and persisting a create's native id on the `RecordLink` (OC-5 criterion 3 — RL-2
 * owns it; OC returns {@link WrittenRepresentation.createdNativeId}).
 *
 * **Security:** no credential material or live payload value is ever logged, put on
 * a `SyncEvent`, or otherwise sent anywhere — only hashes/ids/status/short notes.
 */

/** The fields common to every {@link OutboundCall}. */
export interface OutboundCallCommon {
  /** The target app whose credential + ceilings the call uses (`RegisteredApp.id`). */
  readonly targetAppId: string;
  /** The target app's base URL (`RegisteredApp.baseUrl`). */
  readonly baseUrl: string;
  /** The resolved REST binding of the action-selected target operation (SP-3 picked it). */
  readonly operation: RestOperationBinding;
  /** The selected `OperationMapping` — its `targetIdParamRef` fills the id param, its `mappingId` keys idempotency. */
  readonly operationMapping: OperationMapping;
  /** The **source** record's native id — an idempotency-key input (never the `RecordLink`). */
  readonly sourceNativeId: string;
  /** The target resource's `ResourceBinding.nativeIdRef` — reads a create's new native id from the response. */
  readonly targetResourceNativeIdRef: IrRefTarget;
  /** The `SyncRule` this execution belongs to (OC-5 `relatedRuleId`). */
  readonly relatedRuleId?: string;
  /** The `RecordLink` id, once one exists (OC-5 `recordLinkId`; a create has none yet). */
  readonly recordLinkId?: string;
  /** The target app's resolved outbound ceilings (`RegisteredApp.outboundLimits`); absent → executor default. */
  readonly targetAppLimits?: OutboundLoadLimits;
}

/**
 * One outbound call, discriminated by the change's `action` (which SP already
 * matched to `operationMapping.action`):
 *  - `create` — sends the transformed payload; captures the new native id from the
 *    response; keys on payload + prior state (`none` for a first write).
 *  - `update` — like create, plus fills the target op's id parameter from
 *    `targetNativeId` via `operationMapping.targetIdParamRef`.
 *  - `delete` — no payload; fills the id parameter; keys on the delete marker +
 *    `targetNativeId`.
 */
export type OutboundCall =
  | (OutboundCallCommon & {
      readonly action: "create";
      readonly payload: JsonRecord;
      readonly priorReconciledState: PriorReconciledState;
    })
  | (OutboundCallCommon & {
      readonly action: "update";
      readonly payload: JsonRecord;
      readonly priorReconciledState: PriorReconciledState;
      /** The target-side native id to route the update to (provided; OC does not read `RecordLink`). */
      readonly targetNativeId: string;
    })
  | (OutboundCallCommon & {
      readonly action: "delete";
      /** The link's target-side native id: the id parameter value **and** a delete-key input. */
      readonly targetNativeId: string;
    });

/**
 * The target's written representation OC returns for the deferred OC-5 slices:
 *  - `body` — the write response body (the target's **stored representation**), or
 *    `undefined` when the API returned none (EP/SP does a follow-up read). The echo
 *    baseline (OC-5 criterion 2) is EP's job — OC only returns this.
 *  - `createdNativeId` — a create's newly assigned native id (OC-1 criterion 3),
 *    for the `RecordLink` write (RL-2 — OC-5 criterion 3). `undefined` for an
 *    update/delete, or a create whose response did not carry the id.
 */
export interface WrittenRepresentation {
  readonly body: JsonValue | undefined;
  readonly createdNativeId: string | undefined;
}

/** The disposition of a resolved outbound call. */
export type OutboundCallResult =
  | {
      readonly outcome: "success";
      readonly idempotencyKey: string;
      readonly syncEventId: string;
      readonly writtenRepresentation: WrittenRepresentation;
    }
  | {
      /** A duplicate delivery (a prior success for this key inside the lookback) — no call, no new event. */
      readonly outcome: "skipped-duplicate";
      readonly idempotencyKey: string;
    }
  | {
      /** A per-app ceiling / `Retry-After` wait — the caller `defer`s (OC-3 crit 5); no event. */
      readonly outcome: "throttled";
      readonly retryAfterMs: number;
    }
  | {
      readonly outcome: "failure";
      /** `retryable` (transient) retries with backoff; `permanent` parks immediately (OC-4). */
      readonly disposition: "retryable" | "permanent";
      readonly idempotencyKey: string | undefined;
      readonly syncEventId: string;
      /** A non-secret failure note (status code / transform-error kind / refresh failure). */
      readonly reason: string;
    };

/** The context a routed pre-call failure (a `TransformError`) records its event with. */
export interface TransformFailureContext {
  readonly targetAppId: string;
  readonly mappingId: string;
  readonly sourceNativeId: string;
  readonly relatedRuleId?: string;
  readonly recordLinkId?: string;
}

/** How to apply a decrypted credential's secret to the request headers (inside `withCredential`). */
export type CredentialApplier = (
  headers: Readonly<Record<string, string>>,
  secret: UsableCredentialSecret,
) => Record<string, string>;

/** The narrow credential-access port OC needs (the real `CredentialStore` satisfies it). */
export interface CredentialAccess {
  withCredential<T>(
    appId: string,
    fn: (credential: DecryptedCredential) => Promise<T>,
  ): Promise<WithCredentialResult<T>>;
}

/** Tuning + injection points for {@link OutboundCallExecutor}. */
export interface OutboundCallExecutorOptions {
  /** Config-level default ceilings applied when an app declares none (OC-3 crit 2). */
  readonly defaultLimits?: OutboundLoadLimits;
  /** OC-2 lookback retention window (ms) — the dedup never scans older history. Default 24h. */
  readonly lookbackWindowMs?: number;
  /** OC-2 lookback hard cap — at most this many recent per-key events are scanned. Default 50. */
  readonly lookbackLimit?: number;
  /** Reads the active OTel trace context for `SyncEvent` correlation (default: {@link getActiveTraceContext}). */
  readonly readTraceContext?: () => ActiveTraceContext | null;
  /** Clock seam (default `() => new Date()`). */
  readonly now?: () => Date;
  /** How a decrypted secret becomes request auth (default: `Authorization` header per type). */
  readonly applyCredential?: CredentialApplier;
  /** The `SyncEvent.actor` for sync executions (a system action). Default `"system"`. */
  readonly actor?: string;
  /** A default `Retry-After` back-off (ms) for a `429` with no `Retry-After` header. Default 1s. */
  readonly defaultThrottleMs?: number;
}

const DEFAULT_LOOKBACK_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_LIMIT = 50;
const DEFAULT_THROTTLE_MS = 1_000;
const SYNC_EXECUTION_ACTOR = "system";

export class OutboundCallExecutor {
  readonly #protocol: ProtocolClient;
  readonly #credentials: CredentialAccess;
  readonly #store: SyncEventStore;
  readonly #governor: AppLoadGovernor;
  readonly #defaultLimits: OutboundLoadLimits | undefined;
  readonly #lookbackWindowMs: number;
  readonly #lookbackLimit: number;
  readonly #readTraceContext: () => ActiveTraceContext | null;
  readonly #now: () => Date;
  readonly #applyCredential: CredentialApplier;
  readonly #actor: string;
  readonly #defaultThrottleMs: number;

  public constructor(
    protocol: ProtocolClient,
    credentials: CredentialAccess,
    store: SyncEventStore,
    governor: AppLoadGovernor,
    options: OutboundCallExecutorOptions = {},
  ) {
    this.#protocol = protocol;
    this.#credentials = credentials;
    this.#store = store;
    this.#governor = governor;
    this.#defaultLimits = options.defaultLimits;
    this.#lookbackWindowMs = options.lookbackWindowMs ?? DEFAULT_LOOKBACK_WINDOW_MS;
    this.#lookbackLimit = options.lookbackLimit ?? DEFAULT_LOOKBACK_LIMIT;
    this.#readTraceContext = options.readTraceContext ?? getActiveTraceContext;
    this.#now = options.now ?? ((): Date => new Date());
    this.#applyCredential = options.applyCredential ?? defaultApplyCredential;
    this.#actor = options.actor ?? SYNC_EXECUTION_ACTOR;
    this.#defaultThrottleMs = options.defaultThrottleMs ?? DEFAULT_THROTTLE_MS;
  }

  /**
   * Execute one outbound call end to end: idempotency key → bounded dedup →
   * load-slot reservation → authenticated call inside `withCredential` → response
   * classification → exactly one `SyncEvent`. Returns the disposition the ordering
   * queue settles.
   */
  public async execute(call: OutboundCall): Promise<OutboundCallResult> {
    const idempotencyKey = this.#idempotencyKey(call);

    // OC-2 criterion 5: bounded-lookback dedup — a duplicate delivery of an already
    // *successful* write is skipped (a prior *failure* must not suppress its retry).
    if (await this.#isDuplicateOfSuccess(idempotencyKey)) {
      return { outcome: "skipped-duplicate", idempotencyKey };
    }

    // OC-3: reserve a per-app load slot without blocking (crit 5). A ceiling /
    // `Retry-After` wait re-queues the call instead of holding its worker.
    const limits = call.targetAppLimits ?? this.#defaultLimits;
    const acquired = this.#governor.tryAcquire(call.targetAppId, limits);
    if (!acquired.granted) {
      return { outcome: "throttled", retryAfterMs: acquired.retryAfterMs };
    }

    try {
      return await this.#invoke(call, idempotencyKey);
    } finally {
      acquired.release();
    }
  }

  /**
   * Route a `TransformError` (TX-5) through the OC failure path (OC-4 criterion 6):
   * record one `failure` `SyncEvent` — never a silent success — and return a
   * **permanent** disposition (a deterministic transform failure will not fix on
   * retry). Transformation runs before the call, so there is no idempotency key or
   * payload hash. Its `kind` (never a live value) is the non-secret failure note.
   */
  public async recordTransformFailure(
    context: TransformFailureContext,
    error: unknown,
  ): Promise<OutboundCallResult> {
    const kind = isTransformError(error) ? error.kind : "unknown";
    const reason = `transform error: ${kind}`;
    const syncEventId = await this.#record({
      status: "failure",
      mappingId: context.mappingId,
      targetAppId: context.targetAppId,
      sourceNativeId: context.sourceNativeId,
      relatedRuleId: context.relatedRuleId,
      recordLinkId: context.recordLinkId,
      details: reason,
    });
    return {
      outcome: "failure",
      disposition: "permanent",
      idempotencyKey: undefined,
      syncEventId,
      reason,
    };
  }

  #idempotencyKey(call: OutboundCall): string {
    const mappingId = call.operationMapping.mappingId;
    if (call.action === "delete") {
      return computeDeleteIdempotencyKey({
        mappingId,
        sourceNativeId: call.sourceNativeId,
        targetNativeId: call.targetNativeId,
      });
    }
    return computeWriteIdempotencyKey({
      mappingId,
      sourceNativeId: call.sourceNativeId,
      payload: call.payload,
      priorReconciledState: call.priorReconciledState,
    });
  }

  async #isDuplicateOfSuccess(idempotencyKey: string): Promise<boolean> {
    const since = new Date(this.#now().getTime() - this.#lookbackWindowMs);
    const recent = await this.#store.findRecentByIdempotencyKey(idempotencyKey, {
      since,
      limit: this.#lookbackLimit,
    });
    return recent.some((entry) => entry.status === "success");
  }

  async #invoke(call: OutboundCall, idempotencyKey: string): Promise<OutboundCallResult> {
    const built = this.#buildRequest(call, idempotencyKey);
    if (!built.ok) {
      // A config error (unroutable id parameter): permanent — no useful retry.
      const syncEventId = await this.#recordCallFailure(call, idempotencyKey, built.reason);
      return {
        outcome: "failure",
        disposition: "permanent",
        idempotencyKey,
        syncEventId,
        reason: built.reason,
      };
    }
    const request = built.request;

    let response: OutboundResponse;
    try {
      // OC-1 criterion 1: the credential is decrypted and applied, and the call is
      // made, entirely INSIDE `withCredential` — the secret never leaves the scope.
      const credResult = await this.#credentials.withCredential(call.targetAppId, (credential) =>
        this.#protocol.send({
          ...request,
          headers: this.#applyCredential(request.headers, credential.secret),
        }),
      );
      if (credResult.outcome === "invoked") {
        response = credResult.value;
      } else if (credResult.outcome === "no-credential") {
        // A valid public/no-auth app: `fn` was not invoked, so issue the call
        // unauthenticated (no secret to scope).
        response = await this.#protocol.send(request);
      } else {
        // credential-refresh-failure (CD-2 criterion 4): routed through the failure
        // path as permanent — never a stale-token call, never a silent success.
        const reason = `credential refresh failed: ${credResult.reason}`;
        const syncEventId = await this.#recordCallFailure(call, idempotencyKey, reason);
        return {
          outcome: "failure",
          disposition: "permanent",
          idempotencyKey,
          syncEventId,
          reason,
        };
      }
    } catch (error) {
      // No HTTP response — a transport failure (timeout/network): retryable (OC-4 crit 1).
      const reason = `transport failure: ${describeError(error)}`;
      const syncEventId = await this.#recordCallFailure(call, idempotencyKey, reason);
      return { outcome: "failure", disposition: "retryable", idempotencyKey, syncEventId, reason };
    }

    return this.#classifyResponse(call, idempotencyKey, response);
  }

  async #classifyResponse(
    call: OutboundCall,
    idempotencyKey: string,
    response: OutboundResponse,
  ): Promise<OutboundCallResult> {
    const { status } = response;
    const retryAfterMs = parseRetryAfter(response.headers["retry-after"], this.#now());

    if (status >= 200 && status < 300) {
      return this.#recordSuccess(call, idempotencyKey, response);
    }

    // OC-3 criterion 3: honor a `429`/`Retry-After` — back off and re-queue rather
    // than re-hammering. A throttle is not a business failure and records no event.
    if (status === 429) {
      const waitMs = retryAfterMs ?? this.#defaultThrottleMs;
      this.#governor.penalize(call.targetAppId, waitMs);
      return { outcome: "throttled", retryAfterMs: waitMs };
    }

    // A `Retry-After` on a transient (5xx) response feeds the per-app back-off too,
    // so the retry waits it out.
    if (status >= 500) {
      if (retryAfterMs !== undefined) {
        this.#governor.penalize(call.targetAppId, retryAfterMs);
      }
      const reason = `HTTP ${String(status)}`;
      const syncEventId = await this.#recordCallFailure(call, idempotencyKey, reason);
      return { outcome: "failure", disposition: "retryable", idempotencyKey, syncEventId, reason };
    }

    // A 4xx (client error) will not fix itself on retry → permanent.
    const reason = `HTTP ${String(status)}`;
    const syncEventId = await this.#recordCallFailure(call, idempotencyKey, reason);
    return { outcome: "failure", disposition: "permanent", idempotencyKey, syncEventId, reason };
  }

  async #recordSuccess(
    call: OutboundCall,
    idempotencyKey: string,
    response: OutboundResponse,
  ): Promise<OutboundCallResult> {
    // OC-1 criterion 3: for a create, read the target's newly assigned native id
    // from the response via the target resource's `nativeIdRef`, and return it
    // (RL-2 writes the `RecordLink` — OC-5 criterion 3, deferred).
    const createdNativeId =
      call.action === "create"
        ? readNativeId(response.body, call.targetResourceNativeIdRef)
        : undefined;

    const payloadHash = call.action === "delete" ? undefined : computePayloadHash(call.payload);
    const syncEventId = await this.#record({
      status: "success",
      mappingId: call.operationMapping.mappingId,
      targetAppId: call.targetAppId,
      sourceNativeId: call.sourceNativeId,
      relatedRuleId: call.relatedRuleId,
      recordLinkId: call.recordLinkId,
      idempotencyKey,
      payloadHash,
    });

    return {
      outcome: "success",
      idempotencyKey,
      syncEventId,
      // The written representation OC returns for EP/SP + RL-2 (deferred crit 2/3).
      writtenRepresentation: { body: response.body, createdNativeId },
    };
  }

  /** Record one `failure` `SyncEvent` for a resolved call (carries the idempotency key + payload hash). */
  #recordCallFailure(call: OutboundCall, idempotencyKey: string, reason: string): Promise<string> {
    const payloadHash = call.action === "delete" ? undefined : computePayloadHash(call.payload);
    return this.#record({
      status: "failure",
      mappingId: call.operationMapping.mappingId,
      targetAppId: call.targetAppId,
      sourceNativeId: call.sourceNativeId,
      relatedRuleId: call.relatedRuleId,
      recordLinkId: call.recordLinkId,
      idempotencyKey,
      payloadHash,
      details: reason,
    });
  }

  /**
   * Build the {@link OutboundRequest}: fill the path template, place the id
   * parameter for update/delete via `operationMapping.targetIdParamRef`, set the
   * idempotency-key pass-through header when the target API exposes one (OC-2 crit
   * 6), and attach the JSON body for a write. Returns a structured failure when the
   * id parameter cannot be resolved (a config error → permanent).
   */
  #buildRequest(
    call: OutboundCall,
    idempotencyKey: string,
  ):
    | { readonly ok: true; readonly request: OutboundRequest }
    | { readonly ok: false; readonly reason: string } {
    const headers: Record<string, string> = {};
    if (call.operation.idempotencyKeyHeader !== undefined) {
      headers[call.operation.idempotencyKeyHeader] = idempotencyKey;
    }

    let path = call.operation.pathTemplate;
    const query: string[] = [];

    if (call.action === "update" || call.action === "delete") {
      const ref = call.operationMapping.targetIdParamRef;
      if (ref === undefined) {
        return { ok: false, reason: `no targetIdParamRef on the ${call.action} operation mapping` };
      }
      const location = call.operation.parameterLocations[ref];
      if (location === undefined) {
        return { ok: false, reason: `unresolved id parameter '${ref}' on the target operation` };
      }
      const value = call.targetNativeId;
      if (location.in === "path") {
        path = path.replace(`{${location.name}}`, encodeURIComponent(value));
      } else if (location.in === "query") {
        query.push(`${encodeURIComponent(location.name)}=${encodeURIComponent(value)}`);
      } else {
        headers[location.name] = value;
      }
    }

    const url = joinUrl(call.baseUrl, path) + (query.length > 0 ? `?${query.join("&")}` : "");
    const body: JsonValue | undefined = call.action === "delete" ? undefined : call.payload;
    return { ok: true, request: { method: call.operation.method, url, headers, body } };
  }

  /**
   * Append exactly one `sync-execution` `SyncEvent` (OC-5 criterion 1), correlated
   * to the active OTel trace (criterion 4). Metadata only — hashes/ids/status/a
   * short note, never a secret or a live payload value.
   */
  async #record(fields: {
    readonly status: "success" | "failure";
    readonly mappingId: string;
    readonly targetAppId: string;
    readonly sourceNativeId: string;
    readonly relatedRuleId: string | undefined;
    readonly recordLinkId: string | undefined;
    readonly idempotencyKey?: string | undefined;
    readonly payloadHash?: string | undefined;
    readonly details?: string | undefined;
  }): Promise<string> {
    const id = randomUUID();
    const trace = this.#readTraceContext();
    const entry: AuditLogEntry = stripUndefined({
      id,
      type: "sync-execution" as const,
      actor: this.#actor,
      status: fields.status,
      relatedRuleId: fields.relatedRuleId,
      relatedMappingId: fields.mappingId,
      recordLinkId: fields.recordLinkId,
      sourceNativeId: fields.sourceNativeId,
      originAppId: fields.targetAppId,
      idempotencyKey: fields.idempotencyKey,
      payloadHash: fields.payloadHash,
      details: fields.details,
      traceId: trace?.traceId,
      spanId: trace?.spanId,
      timestamp: this.#now(),
    });
    await this.#store.record(entry);
    return id;
  }
}

/** Default auth application: the credential's secret becomes an `Authorization` header (or custom headers). */
function defaultApplyCredential(
  headers: Readonly<Record<string, string>>,
  secret: UsableCredentialSecret,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  switch (secret.type) {
    case "apiKey":
      out["authorization"] = `Bearer ${secret.apiKey}`;
      break;
    case "oauth2":
      out["authorization"] = `Bearer ${secret.accessToken}`;
      break;
    case "basicAuth":
      out["authorization"] =
        `Basic ${Buffer.from(`${secret.username}:${secret.password}`, "utf8").toString("base64")}`;
      break;
    case "custom":
      for (const [key, value] of Object.entries(secret.values)) {
        out[key.toLowerCase()] = value;
      }
      break;
  }
  return out;
}

/** Read a native id (a `field`-kind `IrRefTarget`) out of a response body as a string. */
function readNativeId(body: JsonValue | undefined, ref: IrRefTarget): string | undefined {
  if (body === undefined || ref.kind !== "field") {
    return undefined;
  }
  const read = readPath(body, ref.path);
  if (!read.present) {
    return undefined;
  }
  const value = read.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Join a base URL and a path, tolerating a trailing / on the base and a leading / on the path. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Parse a `Retry-After` header into a millisecond wait: a delta-seconds integer, or
 * an HTTP-date. Returns `undefined` when absent or unparseable.
 */
function parseRetryAfter(headerValue: string | undefined, now: Date): number | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) {
    return undefined;
  }
  return Math.max(0, dateMs - now.getTime());
}

/** A non-secret description of a thrown value for a failure note. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
