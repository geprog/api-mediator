import {
  ambiguousMatchListResponseSchema,
  configureSyncRuleResponseSchema,
  confirmScopeIdentityKeyResponseSchema,
  createRecordLinkResponseSchema,
  createScopeLinkResponseSchema,
  deadLetterQueueResponseSchema,
  disableSyncRuleResponseSchema,
  enableSyncRuleResponseSchema,
  parkedConflictListResponseSchema,
  parkedContainerLinkListResponseSchema,
  replayParkedWriteResponseSchema,
  resolveParkedConflictResponseSchema,
  scopeIdentityKeyDerivationResponseSchema,
  scopeLinkCandidateContextResponseSchema,
  syncEventListResponseSchema,
  syncRuleListResponseSchema,
  unlinkRecordResponseSchema,
  unlinkScopeLinkResponseSchema,
  type AmbiguousMatchListResponse,
  type ConfigureSyncRuleRequest,
  type ConfigureSyncRuleResponse,
  type ConfirmScopeIdentityKeyRequest,
  type ConfirmScopeIdentityKeyResponse,
  type CreateRecordLinkRequest,
  type CreateRecordLinkResponse,
  type CreateScopeLinkRequest,
  type CreateScopeLinkResponse,
  type DeadLetterQueueResponse,
  type DisableSyncRuleResponse,
  type EnableSyncRuleRequest,
  type EnableSyncRuleResponse,
  type ParkedConflictListResponse,
  type ParkedContainerLinkListResponse,
  type ReplayParkedWriteResponse,
  type ResolveParkedConflictRequest,
  type ResolveParkedConflictResponse,
  type ScopeIdentityKeyDerivationResponse,
  type ScopeLinkCandidateContextResponse,
  type SyncEventListResponse,
  type SyncEventQuery,
  type SyncRuleListResponse,
  type UnlinkRecordResponse,
  type UnlinkScopeLinkResponse,
} from "@mediator/contracts";

import { apiRequest } from "./client.js";

/**
 * The Phase-4 Sync HTTP API client (SA-1..SA-5). Each function is a one-liner over
 * {@link apiRequest} that validates the response against its `@mediator/contracts`
 * schema at the boundary. Every sync invariant (the enablement gate, backfill,
 * loop prevention, conflict/park handling, role gating OA-2) is enforced
 * **server-side**; these are thin calls. No request or response carries credential
 * material or a live payload value (`docs/architecture/security.md`).
 */

// ── SA-2: read rule state + the sync audit log ───────────────────────────────

/** `GET /api/sync-rules` (SA-2.1/2.2) — every rule with its status + gate + lag. */
export function listSyncRules(): Promise<SyncRuleListResponse> {
  return apiRequest("/api/sync-rules", { method: "GET" }, syncRuleListResponseSchema);
}

/** `GET /api/sync-events` (SA-2.3) — the sync audit log filtered by rule/record/status. */
export function listSyncEvents(query: SyncEventQuery = {}): Promise<SyncEventListResponse> {
  const params = new URLSearchParams();
  if (query.ruleId !== undefined) params.set("ruleId", query.ruleId);
  if (query.recordLinkId !== undefined) params.set("recordLinkId", query.recordLinkId);
  if (query.sourceNativeId !== undefined) params.set("sourceNativeId", query.sourceNativeId);
  if (query.status !== undefined) params.set("status", query.status);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return apiRequest(
    qs === "" ? "/api/sync-events" : `/api/sync-events?${qs}`,
    { method: "GET" },
    syncEventListResponseSchema,
  );
}

// ── SA-1: configure / enable / disable a rule ────────────────────────────────

/** `PATCH /api/sync-rules/:id/config` (SA-1.1) — set a disabled rule's execution options. */
export function configureSyncRule(
  ruleId: string,
  request: ConfigureSyncRuleRequest,
): Promise<ConfigureSyncRuleResponse> {
  return apiRequest(
    `/api/sync-rules/${encodeURIComponent(ruleId)}/config`,
    { method: "PATCH", body: request },
    configureSyncRuleResponseSchema,
  );
}

/**
 * `POST /api/sync-rules/:id/enable` (SA-1.2/1.3) — enable through the gate. A
 * gate-passing enable returns `202` with the `accepted` body; a blocked enable
 * returns `422` and surfaces as an {@link import("./errors.js").ApiError} (the UI
 * gates the enable action on an already-satisfied checklist, so a 422 only ever
 * arises from a concurrent change and is reported as an error).
 */
export function enableSyncRule(
  ruleId: string,
  request: EnableSyncRuleRequest,
): Promise<EnableSyncRuleResponse> {
  return apiRequest(
    `/api/sync-rules/${encodeURIComponent(ruleId)}/enable`,
    { method: "POST", body: request },
    enableSyncRuleResponseSchema,
  );
}

/** `POST /api/sync-rules/:id/disable` (SA-1.4) — stop polling; execution state retained. */
export function disableSyncRule(ruleId: string): Promise<DisableSyncRuleResponse> {
  return apiRequest(
    `/api/sync-rules/${encodeURIComponent(ruleId)}/disable`,
    { method: "POST" },
    disableSyncRuleResponseSchema,
  );
}

// ── SA-3: manual link / unlink + the ambiguous-match queue ───────────────────

/** `GET /api/record-links/ambiguous-matches` (SA-3.3) — the ambiguous-match queue. */
export function listAmbiguousMatches(limit?: number): Promise<AmbiguousMatchListResponse> {
  const qs = limit !== undefined ? `?limit=${String(limit)}` : "";
  return apiRequest(
    `/api/record-links/ambiguous-matches${qs}`,
    { method: "GET" },
    ambiguousMatchListResponseSchema,
  );
}

/** `POST /api/record-links` (SA-3.1) — manually link a source record to a target record. */
export function createRecordLink(
  request: CreateRecordLinkRequest,
): Promise<CreateRecordLinkResponse> {
  return apiRequest(
    "/api/record-links",
    { method: "POST", body: request },
    createRecordLinkResponseSchema,
  );
}

/** `DELETE /api/record-links/:id` (SA-3.2) — sever a `RecordLink`. */
export function unlinkRecord(linkId: string): Promise<UnlinkRecordResponse> {
  return apiRequest(
    `/api/record-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
    unlinkRecordResponseSchema,
  );
}

// ── SA-4: the parked-conflict queue + resolution ─────────────────────────────

/** `GET /api/parked-conflicts` (SA-4.1) — the open parked-conflict queue. */
export function listParkedConflicts(limit?: number): Promise<ParkedConflictListResponse> {
  const qs = limit !== undefined ? `?limit=${String(limit)}` : "";
  return apiRequest(
    `/api/parked-conflicts${qs}`,
    { method: "GET" },
    parkedConflictListResponseSchema,
  );
}

/** `POST /api/parked-conflicts/:id/resolve` (SA-4.2/4.3) — resolve one parked conflict. */
export function resolveParkedConflict(
  id: string,
  request: ResolveParkedConflictRequest,
): Promise<ResolveParkedConflictResponse> {
  return apiRequest(
    `/api/parked-conflicts/${encodeURIComponent(id)}/resolve`,
    { method: "POST", body: request },
    resolveParkedConflictResponseSchema,
  );
}

// ── SA-5: the dead-letter queue + replay a parked write ──────────────────────

/** `GET /api/dead-letter-writes` (SA-5.1) — the parked-write (dead-letter) queue. */
export function listDeadLetterWrites(limit?: number): Promise<DeadLetterQueueResponse> {
  const qs = limit !== undefined ? `?limit=${String(limit)}` : "";
  return apiRequest(
    `/api/dead-letter-writes${qs}`,
    { method: "GET" },
    deadLetterQueueResponseSchema,
  );
}

/** `POST /api/dead-letter-writes/:id/replay` (SA-5.2) — replay a parked write. */
export function replayParkedWrite(id: string): Promise<ReplayParkedWriteResponse> {
  return apiRequest(
    `/api/dead-letter-writes/${encodeURIComponent(id)}/replay`,
    { method: "POST" },
    replayParkedWriteResponseSchema,
  );
}

// ── SS-15: scope identity key (SS-15.4) + container linking (SS-11.5/11.6, SS-15.5) ──

/** `GET /api/scope-identity-key?resourcePairRef=…` (SS-15.4) — the derive-then-correct candidate. */
export function deriveScopeIdentityKey(
  resourcePairRef: string,
): Promise<ScopeIdentityKeyDerivationResponse> {
  return apiRequest(
    `/api/scope-identity-key?resourcePairRef=${encodeURIComponent(resourcePairRef)}`,
    { method: "GET" },
    scopeIdentityKeyDerivationResponseSchema,
  );
}

/** `POST /api/scope-identity-key` (SS-15.4) — confirm/correct the value-preserving pairing. */
export function confirmScopeIdentityKey(
  request: ConfirmScopeIdentityKeyRequest,
): Promise<ConfirmScopeIdentityKeyResponse> {
  return apiRequest(
    "/api/scope-identity-key",
    { method: "POST", body: request },
    confirmScopeIdentityKeyResponseSchema,
  );
}

/** `GET /api/scope-links/parked` (SS-11.5) — the parked container-linking queue. */
export function listParkedContainerLinks(limit?: number): Promise<ParkedContainerLinkListResponse> {
  const qs = limit !== undefined ? `?limit=${String(limit)}` : "";
  return apiRequest(
    `/api/scope-links/parked${qs}`,
    { method: "GET" },
    parkedContainerLinkListResponseSchema,
  );
}

/** `GET /api/scope-links/candidates?resourcePairRef=…` (SS-15.5) — per-pair target linking context. */
export function getScopeLinkCandidateContext(
  resourcePairRef: string,
): Promise<ScopeLinkCandidateContextResponse> {
  return apiRequest(
    `/api/scope-links/candidates?resourcePairRef=${encodeURIComponent(resourcePairRef)}`,
    { method: "GET" },
    scopeLinkCandidateContextResponseSchema,
  );
}

/** `POST /api/scope-links` (SS-11.6) — manually link two containers. */
export function createScopeLink(request: CreateScopeLinkRequest): Promise<CreateScopeLinkResponse> {
  return apiRequest(
    "/api/scope-links",
    { method: "POST", body: request },
    createScopeLinkResponseSchema,
  );
}

/** `DELETE /api/scope-links/:id` (SS-11.6) — sever a `ScopeLink`. */
export function unlinkScopeLink(id: string): Promise<UnlinkScopeLinkResponse> {
  return apiRequest(
    `/api/scope-links/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    unlinkScopeLinkResponseSchema,
  );
}
