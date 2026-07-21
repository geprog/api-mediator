import type {
  AdapterBindingHealthDto,
  AdapterBindingStateDto,
  AdapterEndpointStateDto,
  AdapterHealthCompositionRequiredDto,
  AdapterHealthUnhealthyBindingDto,
  AdapterRequestDto,
  AdapterRequestOutcome,
  AdapterUnionConfigDto,
  NotYetMappedConsumerOperationDto,
} from "@mediator/contracts";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMappingStatus,
  AuditLogEntry,
  RegisteredAppStatus,
} from "@mediator/domain";

import { validateBindingHealth } from "../adapter-runtime/serve/planner.js";
import type { AdapterStateReader } from "../../modules/adapter-state.js";

/**
 * The AP-1 / AP-5.3 read-model assembly: turn the primitive {@link AdapterStateReader}
 * reads into the operator-facing adapter-state and health views. Kept out of the route
 * handlers so the derivation is unit-testable against a fake reader, and out of the reader
 * port so the port stays primitive.
 *
 * **Per-binding health is derived here, at read time, from the SAME RP-3 rule the
 * Resolution Planner enforces at request time** ({@link validateBindingHealth}) — a
 * `stale`/`suspended` mapping or a `disabled` backend, never stored per binding (AP-1.4).
 * Everything produced is metadata only: ids, statuses, enum causes, composition config —
 * never a credential, a token, or a payload value (AP-1.5).
 */

/** The AP-1 list view: every endpoint's state + the consumer's unmet needs. */
export interface AdapterStateView {
  readonly endpoints: readonly AdapterEndpointStateDto[];
  readonly notYetMapped: readonly NotYetMappedConsumerOperationDto[];
}

/** Per-assembly memoization of the mapping/backend status reads (one read per unique id). */
interface StatusCaches {
  readonly mapping: Map<string, ApprovedMappingStatus | undefined>;
  readonly backend: Map<string, RegisteredAppStatus | undefined>;
}

function createStatusCaches(): StatusCaches {
  return { mapping: new Map(), backend: new Map() };
}

async function cachedMappingStatus(
  reader: AdapterStateReader,
  mappingId: string,
  caches: StatusCaches,
): Promise<ApprovedMappingStatus | undefined> {
  if (caches.mapping.has(mappingId)) {
    return caches.mapping.get(mappingId);
  }
  const status = await reader.getMappingStatus(mappingId);
  caches.mapping.set(mappingId, status);
  return status;
}

async function cachedBackendStatus(
  reader: AdapterStateReader,
  appId: string,
  caches: StatusCaches,
): Promise<RegisteredAppStatus | undefined> {
  if (caches.backend.has(appId)) {
    return caches.backend.get(appId);
  }
  const status = await reader.getBackendAppStatus(appId);
  caches.backend.set(appId, status);
  return status;
}

/**
 * One binding's read-time health (AP-1.4), from the exact RP-3 planner rule. An absent
 * mapping reads as `archived` (→ `mapping-stale`) and an absent backend as `disabled`
 * (→ `backend-disabled`) — the same fail-loud fallback the serve-time context loader uses,
 * so a missing FK target is never reported as a healthy binding.
 */
async function resolveBindingHealth(
  reader: AdapterStateReader,
  binding: AdapterBinding,
  caches: StatusCaches,
): Promise<AdapterBindingHealthDto> {
  const mappingStatus = await cachedMappingStatus(reader, binding.approvedMappingId, caches);
  const backendStatus = await cachedBackendStatus(reader, binding.backendAppId, caches);
  const cause = validateBindingHealth({
    binding,
    mappingStatus: mappingStatus ?? "archived",
    backendStatus: backendStatus ?? "disabled",
  });
  return cause === undefined ? { ok: true } : { ok: false, cause: cause.cause };
}

/** Map one binding (+ its derived health) to its read DTO (AP-1.1 / AP-1.4). */
function toBindingStateDto(
  binding: AdapterBinding,
  health: AdapterBindingHealthDto,
): AdapterBindingStateDto {
  return {
    id: binding.id,
    backendAppId: binding.backendAppId,
    backendOperationId: binding.backendOperationId,
    role: binding.role,
    status: binding.status,
    ...(binding.executionOrder !== undefined ? { executionOrder: binding.executionOrder } : {}),
    ...(binding.dependsOnBindingId !== undefined
      ? { dependsOnBindingId: binding.dependsOnBindingId }
      : {}),
    health,
  };
}

/** The `collection-union` post-merge config projected for reads, or `null` off a union (AP-1.1). */
function toUnionConfigDto(endpoint: AdapterEndpoint): AdapterUnionConfigDto | null {
  if (endpoint.aggregationStrategy !== "collection-union") {
    return null;
  }
  return {
    dedup: endpoint.postMergeDedup ?? null,
    filters: [...(endpoint.postMergeFilters ?? [])],
    sorts: [...(endpoint.postMergeSorts ?? [])],
    pagination:
      endpoint.postMergePagination === undefined
        ? null
        : {
            convention: endpoint.postMergePagination.convention,
            // The convention is confirmed iff an operator confirmation is stamped (CO-3.5);
            // never surface the `confirmedBy` identity.
            confirmed: endpoint.postMergePagination.confirmedBy !== null,
          },
  };
}

/**
 * Build one endpoint's read DTO with per-binding derived health (AP-1.1 / AP-1.4) and, for a
 * `composition-required` endpoint, the "why" (AP-1.2): which bindings are `proposed` and
 * whether a previous configuration is still serving (the endpoint has `active` bindings).
 */
export async function assembleEndpointState(
  reader: AdapterStateReader,
  endpoint: AdapterEndpoint,
  caches: StatusCaches = createStatusCaches(),
): Promise<AdapterEndpointStateDto> {
  const bindings = await reader.listBindings(endpoint.id);
  const bindingDtos = await Promise.all(
    bindings.map(async (binding) =>
      toBindingStateDto(binding, await resolveBindingHealth(reader, binding, caches)),
    ),
  );
  return {
    id: endpoint.id,
    consumerAppId: endpoint.consumerAppId,
    consumerOperationId: endpoint.consumerOperationId,
    status: endpoint.status,
    aggregationStrategy: endpoint.aggregationStrategy ?? null,
    strictness: endpoint.strictness ?? null,
    cacheTtl: endpoint.cacheTtl ?? null,
    union: toUnionConfigDto(endpoint),
    bindings: bindingDtos,
    compositionRequired:
      endpoint.status === "composition-required"
        ? {
            proposedBindingIds: bindings
              .filter((binding) => binding.status === "proposed")
              .map((binding) => binding.id),
            previousConfigurationServing: bindings.some((binding) => binding.status === "active"),
          }
        : null,
  };
}

/**
 * Assemble every endpoint's read DTO (with per-binding derived health) — the shared basis for
 * both the AP-1 state view and the AP-5.3 health derivation. One `StatusCaches` spans the
 * whole list so each unique mapping/backend status is read once.
 */
export async function assembleEndpointStates(
  reader: AdapterStateReader,
): Promise<AdapterEndpointStateDto[]> {
  const caches = createStatusCaches();
  const endpoints = await reader.listEndpoints();
  return Promise.all(endpoints.map((endpoint) => assembleEndpointState(reader, endpoint, caches)));
}

/**
 * Assemble the whole AP-1 adapter-state view: every endpoint's state + the `not-yet-mapped`
 * consumer operations (AP-1.3) — a consumer operation with no endpoint (`no-endpoint`) or an
 * endpoint with no `active` binding (`no-active-binding`), enumerated from the CONSUMER specs
 * so the operator sees unmet needs, not only endpoints that exist.
 */
export async function assembleAdapterState(reader: AdapterStateReader): Promise<AdapterStateView> {
  const endpointDtos = await assembleEndpointStates(reader);

  // Index endpoint coverage by (consumerAppId → consumerOperationId → hasActiveBinding), so
  // the not-yet-mapped diff is an O(1) lookup per consumer operation (no delimiter keys).
  const coverage = new Map<string, Map<string, boolean>>();
  for (const endpoint of endpointDtos) {
    const byOperation = coverage.get(endpoint.consumerAppId) ?? new Map<string, boolean>();
    const hasActiveBinding = endpoint.bindings.some((binding) => binding.status === "active");
    // A second endpoint row for the same operation should never exist (unique index), but
    // OR the flag defensively rather than clobber a serving endpoint with a non-serving one.
    byOperation.set(
      endpoint.consumerOperationId,
      (byOperation.get(endpoint.consumerOperationId) ?? false) || hasActiveBinding,
    );
    coverage.set(endpoint.consumerAppId, byOperation);
  }

  const notYetMapped: NotYetMappedConsumerOperationDto[] = [];
  for (const operation of await reader.listConsumerOperations()) {
    const hasActiveBinding = coverage
      .get(operation.consumerAppId)
      ?.get(operation.consumerOperationId);
    if (hasActiveBinding === true) {
      continue;
    }
    notYetMapped.push({
      consumerAppId: operation.consumerAppId,
      consumerOperationId: operation.consumerOperationId,
      reason: hasActiveBinding === undefined ? "no-endpoint" : "no-active-binding",
    });
  }

  return { endpoints: endpointDtos, notYetMapped };
}

/** The AP-5.3 health conditions derived purely from the assembled endpoint DTOs. */
export interface AdapterHealthConditions {
  readonly compositionRequired: readonly AdapterHealthCompositionRequiredDto[];
  readonly unhealthyBindings: readonly AdapterHealthUnhealthyBindingDto[];
}

/**
 * Derive the operator-actionable health conditions from the assembled endpoints (AP-5.3):
 * endpoints in `composition-required`, and `active` bindings eliminated at read time by an
 * unhealthy mapping/backend (`mapping-stale` — the concept's tight-threshold alert — plus
 * `mapping-suspended`/`backend-disabled`). The `mediator-transform-error` occurrences come
 * from the audit history separately (they are request outcomes, not endpoint state).
 */
export function deriveHealthConditions(
  endpoints: readonly AdapterEndpointStateDto[],
): AdapterHealthConditions {
  const compositionRequired: AdapterHealthCompositionRequiredDto[] = [];
  const unhealthyBindings: AdapterHealthUnhealthyBindingDto[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.status === "composition-required" && endpoint.compositionRequired !== null) {
      compositionRequired.push({
        endpointId: endpoint.id,
        consumerAppId: endpoint.consumerAppId,
        consumerOperationId: endpoint.consumerOperationId,
        proposedBindingIds: endpoint.compositionRequired.proposedBindingIds,
        previousConfigurationServing: endpoint.compositionRequired.previousConfigurationServing,
      });
    }
    for (const binding of endpoint.bindings) {
      if (binding.status === "active" && !binding.health.ok) {
        unhealthyBindings.push({
          endpointId: endpoint.id,
          bindingId: binding.id,
          backendAppId: binding.backendAppId,
          cause: binding.health.cause,
        });
      }
    }
  }
  return { compositionRequired, unhealthyBindings };
}

/**
 * Project one `adapter-request` audit row to its wire DTO (AP-5.1) — **metadata only**
 * (AP-5.4): the outcome (`status` + derived `outcome`), `cause`, `degraded`, the
 * endpoint/binding ids, actor, a short `details` note, and `traceId`/`spanId`. A served
 * request carries a `status`; an operator-action row (compose/enable/disable) carries none,
 * so its `outcome` is `other`. Reads no payload value, no token, no credential material.
 */
export function toAdapterRequestDto(entry: AuditLogEntry): AdapterRequestDto {
  const degraded = entry.degraded ?? false;
  const outcome: AdapterRequestOutcome =
    entry.status === "failure"
      ? "failure"
      : entry.status === "success"
        ? degraded
          ? "degraded"
          : "success"
        : "other";
  return {
    id: entry.id,
    outcome,
    status: entry.status ?? null,
    cause: entry.cause ?? null,
    degraded,
    relatedEndpointId: entry.relatedEndpointId ?? null,
    relatedBindingId: entry.relatedBindingId ?? null,
    actor: entry.actor,
    details: entry.details ?? null,
    traceId: entry.traceId ?? null,
    spanId: entry.spanId ?? null,
    timestamp: entry.timestamp.toISOString(),
  };
}
