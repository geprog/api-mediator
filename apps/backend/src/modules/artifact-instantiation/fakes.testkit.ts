import type { DownstreamArtifactOps } from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMapping,
  FieldMapping,
  GraphEdge,
  MappingVariant,
  OperationMapping,
  SyncRule,
} from "@mediator/domain";

/**
 * An in-memory {@link DownstreamArtifactOps} that **faithfully mirrors** the real
 * `DownstreamArtifactRepository`'s idempotent semantics (per the project's
 * "fakes must mirror real repos" discipline), so a unit test that passes here
 * would pass the live-DB integration test too:
 *
 * - `insertSyncRuleIfAbsent` / `insertAdapterBindingIfAbsent` / `upsertGraphEdge`
 *   model `ON CONFLICT DO NOTHING`: a second write with the same natural key is a
 *   no-op that **keeps the existing row** (its id and any state untouched).
 * - `ensureAdapterEndpoint` models get-or-create: it returns the existing endpoint
 *   (never a duplicate) on a natural-key hit, otherwise inserts the candidate.
 * - `activateAdapterEndpointForSingleBinding` / `markAdapterEndpointCompositionRequired`
 *   model the real guarded `UPDATE ... WHERE status = ?`: each transitions the stored
 *   endpoint only from its allowed source status and is a no-op otherwise, so the CO-1
 *   idempotency/never-reset guards behave identically to the live DB.
 *
 * Composite keys use `JSON.stringify([...])` so a natural key stays collision-free
 * even when a component (the canonical `resourcePairRef`) itself contains
 * separators — exactly the tuple-equality the real UNIQUE indexes provide.
 *
 * The `calls` counters exist so a test can assert that instantiation touches ONLY
 * the database ops (no outbound call / no polling — there is no network surface on
 * this interface at all).
 */
export class FakeDownstreamArtifactOps implements DownstreamArtifactOps {
  readonly #syncRules = new Map<string, SyncRule>();
  readonly #endpoints = new Map<string, AdapterEndpoint>();
  readonly #bindings = new Map<string, AdapterBinding>();
  readonly #edges = new Map<string, GraphEdge>();

  public readonly calls = {
    insertSyncRuleIfAbsent: 0,
    ensureAdapterEndpoint: 0,
    insertAdapterBindingIfAbsent: 0,
    listAdapterBindingsByEndpoint: 0,
    activateAdapterEndpointForSingleBinding: 0,
    markAdapterEndpointCompositionRequired: 0,
    upsertGraphEdge: 0,
  };

  public insertSyncRuleIfAbsent(rule: SyncRule): Promise<void> {
    this.calls.insertSyncRuleIfAbsent += 1;
    const key = JSON.stringify([rule.approvedMappingId, rule.resourcePairRef]);
    if (!this.#syncRules.has(key)) {
      this.#syncRules.set(key, rule);
    }
    return Promise.resolve();
  }

  public ensureAdapterEndpoint(candidate: AdapterEndpoint): Promise<AdapterEndpoint> {
    this.calls.ensureAdapterEndpoint += 1;
    const key = JSON.stringify([candidate.consumerAppId, candidate.consumerOperationId]);
    const existing = this.#endpoints.get(key);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    this.#endpoints.set(key, candidate);
    return Promise.resolve(candidate);
  }

  public insertAdapterBindingIfAbsent(binding: AdapterBinding): Promise<void> {
    this.calls.insertAdapterBindingIfAbsent += 1;
    const key = JSON.stringify([
      binding.adapterEndpointId,
      binding.backendAppId,
      binding.backendOperationId,
      binding.approvedMappingId,
    ]);
    if (!this.#bindings.has(key)) {
      this.#bindings.set(key, binding);
    }
    return Promise.resolve();
  }

  public listAdapterBindingsByEndpoint(adapterEndpointId: string): Promise<AdapterBinding[]> {
    this.calls.listAdapterBindingsByEndpoint += 1;
    return Promise.resolve(
      [...this.#bindings.values()].filter(
        (binding) => binding.adapterEndpointId === adapterEndpointId,
      ),
    );
  }

  public activateAdapterEndpointForSingleBinding(
    adapterEndpointId: string,
  ): Promise<AdapterEndpoint> {
    this.calls.activateAdapterEndpointForSingleBinding += 1;
    // Mirrors the real guarded UPDATE: promote ONLY a still-neutral
    // `composition-required` endpoint to the single-binding serving defaults;
    // `cacheTtl` stays absent (no caching). Any other status is a no-op.
    return Promise.resolve(
      this.#transitionEndpoint(adapterEndpointId, (endpoint) =>
        endpoint.status === "composition-required"
          ? {
              id: endpoint.id,
              consumerAppId: endpoint.consumerAppId,
              consumerOperationId: endpoint.consumerOperationId,
              status: "active",
              aggregationStrategy: "single",
              strictness: "degraded",
            }
          : endpoint,
      ),
    );
  }

  public markAdapterEndpointCompositionRequired(
    adapterEndpointId: string,
  ): Promise<AdapterEndpoint> {
    this.calls.markAdapterEndpointCompositionRequired += 1;
    // Mirrors the real guarded UPDATE: move ONLY an `active` endpoint to
    // `composition-required`, changing `status` alone (serving config untouched).
    return Promise.resolve(
      this.#transitionEndpoint(adapterEndpointId, (endpoint) =>
        endpoint.status === "active" ? { ...endpoint, status: "composition-required" } : endpoint,
      ),
    );
  }

  /** Apply a status transition to the stored endpoint with the given id (found by id). */
  #transitionEndpoint(
    adapterEndpointId: string,
    transition: (endpoint: AdapterEndpoint) => AdapterEndpoint,
  ): AdapterEndpoint {
    for (const [key, endpoint] of this.#endpoints) {
      if (endpoint.id === adapterEndpointId) {
        const next = transition(endpoint);
        this.#endpoints.set(key, next);
        return next;
      }
    }
    throw new Error("adapter_endpoint not found after a CO-1 status transition");
  }

  public upsertGraphEdge(edge: GraphEdge): Promise<void> {
    this.calls.upsertGraphEdge += 1;
    const key = JSON.stringify([edge.sourceNodeId, edge.targetNodeId, edge.type]);
    if (!this.#edges.has(key)) {
      this.#edges.set(key, edge);
    }
    return Promise.resolve();
  }

  // ── Inspection / seeding ───────────────────────────────────────────────────

  /** Seed an already-instantiated endpoint (for reuse / duplication tests). */
  public seedEndpoint(endpoint: AdapterEndpoint): void {
    const key = JSON.stringify([endpoint.consumerAppId, endpoint.consumerOperationId]);
    this.#endpoints.set(key, endpoint);
  }

  /**
   * Seed an already-attached binding (for CO-1 prior-binding / operator-`disabled`
   * tests). Keyed by the same natural key the real UNIQUE index uses, so a later
   * `insertAdapterBindingIfAbsent` for the same key is the no-op it is in Postgres.
   */
  public seedBinding(binding: AdapterBinding): void {
    const key = JSON.stringify([
      binding.adapterEndpointId,
      binding.backendAppId,
      binding.backendOperationId,
      binding.approvedMappingId,
    ]);
    this.#bindings.set(key, binding);
  }

  public get syncRules(): SyncRule[] {
    return [...this.#syncRules.values()];
  }
  public get endpoints(): AdapterEndpoint[] {
    return [...this.#endpoints.values()];
  }
  public get bindings(): AdapterBinding[] {
    return [...this.#bindings.values()];
  }
  public get edges(): GraphEdge[] {
    return [...this.#edges.values()];
  }
}

// ── Small domain fixtures ──────────────────────────────────────────────────────

/** A minimal `ApprovedMapping` for the given variant/apps/specs (defaults are stable). */
export function approvedMappingFixture(overrides: {
  readonly id: string;
  readonly variant: MappingVariant;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  readonly sourceSpecId?: string;
  readonly targetSpecId?: string;
}): ApprovedMapping {
  return {
    id: overrides.id,
    sourceSpecId: overrides.sourceSpecId ?? `${overrides.sourceAppId}-spec`,
    targetSpecId: overrides.targetSpecId ?? `${overrides.targetAppId}-spec`,
    sourceAppId: overrides.sourceAppId,
    targetAppId: overrides.targetAppId,
    variant: overrides.variant,
    approvedBy: "operator",
    approvedAt: new Date("2026-07-12T00:00:00.000Z"),
    status: "active",
  };
}

/** A minimal peer-peer `FieldMapping` (`resourceRef/field` paths). */
export function fieldMappingFixture(input: {
  readonly id: string;
  readonly mappingId: string;
  readonly sourcePath: string;
  readonly targetPath: string;
}): FieldMapping {
  return {
    id: input.id,
    mappingId: input.mappingId,
    sourcePath: input.sourcePath,
    targetPath: input.targetPath,
    transform: "rename",
  };
}

/** A minimal `OperationMapping` (`resourceRef/operationId` refs). */
export function operationMappingFixture(input: {
  readonly id: string;
  readonly mappingId: string;
  readonly sourceOperationRef: string;
  readonly targetOperationRef: string;
  readonly action?: OperationMapping["action"];
}): OperationMapping {
  return {
    id: input.id,
    mappingId: input.mappingId,
    sourceOperationRef: input.sourceOperationRef,
    targetOperationRef: input.targetOperationRef,
    action: input.action ?? "read",
  };
}

/** A deterministic, monotonic id factory for tests (`id-1`, `id-2`, …). */
export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return (): string => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}
