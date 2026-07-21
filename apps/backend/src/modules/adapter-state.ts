import {
  AdapterCompositionRepository,
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  RegisteredAppRepository,
  type AdapterRequestQuery,
  type Database,
} from "@mediator/db";
import type {
  AdapterBinding,
  AdapterEndpoint,
  ApprovedMappingStatus,
  AuditLogEntry,
  RegisteredAppStatus,
} from "@mediator/domain";

/**
 * The **read** persistence seam for the Phase-5 adapter operator surface (AP-1 adapter
 * state, AP-5 request history + health). Read-only, pooled — the mirror of the
 * `AppReader`/`SpecReader`/`BindingReader` ports in {@link module:persistence}: routes hold
 * no persistence of their own, so the unit tests drive the whole surface with in-memory
 * fakes. The health/coverage **derivation** is not here — it lives in the HTTP layer
 * (`http/operator/adapter-state-view.ts`), reusing the Resolution Planner's RP-3 rule — so
 * this port stays a set of narrow primitive reads.
 */

/** One consumer operation declared by an active CONSUMER spec (AP-1.3 enumeration). */
export interface ConsumerOperationRef {
  readonly consumerAppId: string;
  readonly consumerOperationId: string;
}

/**
 * The primitive reads AP-1 (state) and AP-5 (health) compose over: every `AdapterEndpoint`
 * and its bindings, the per-binding `ApprovedMapping` / backend-app status the read-time
 * health derivation consults (AP-1.4), and the full set of CONSUMER-spec operations the
 * `not-yet-mapped` enumeration diffs against (AP-1.3). Never returns credential material or
 * a payload value — it returns only ids, statuses, and composition config (AP-1.5).
 */
export interface AdapterStateReader {
  listEndpoints(): Promise<readonly AdapterEndpoint[]>;
  getEndpointById(id: string): Promise<AdapterEndpoint | undefined>;
  listBindings(endpointId: string): Promise<readonly AdapterBinding[]>;
  /** The `ApprovedMapping.status` a binding points at, or `undefined` if the mapping is gone. */
  getMappingStatus(mappingId: string): Promise<ApprovedMappingStatus | undefined>;
  /** The backend `RegisteredApp.status`, or `undefined` if the app is gone. */
  getBackendAppStatus(appId: string): Promise<RegisteredAppStatus | undefined>;
  /** Every consumer operation declared across all active CONSUMER specs (AP-1.3). */
  listConsumerOperations(): Promise<readonly ConsumerOperationRef[]>;
}

/**
 * The AP-5.1 read side of the `adapter-request` audit log — filtered by
 * endpoint/binding/time/status/cause, bounded by `limit`. Metadata only (AP-5.4): the
 * underlying `audit_log` schema cannot hold a payload value or an adapter token.
 */
export interface AdapterRequestHistoryReader {
  query(query: AdapterRequestQuery): Promise<readonly AuditLogEntry[]>;
}

/** The `@mediator/db`-backed {@link AdapterStateReader}; all state comes from persisted rows. */
export class DbAdapterStateReader implements AdapterStateReader {
  public constructor(private readonly db: Database) {}

  public listEndpoints(): Promise<AdapterEndpoint[]> {
    return new AdapterCompositionRepository(this.db).listEndpoints();
  }

  public getEndpointById(id: string): Promise<AdapterEndpoint | undefined> {
    return new AdapterCompositionRepository(this.db).getEndpointById(id);
  }

  public listBindings(endpointId: string): Promise<AdapterBinding[]> {
    return new AdapterCompositionRepository(this.db).listBindings(endpointId);
  }

  public async getMappingStatus(mappingId: string): Promise<ApprovedMappingStatus | undefined> {
    const mapping = await new ApprovedMappingRepository(this.db).getById(mappingId);
    return mapping?.status;
  }

  public async getBackendAppStatus(appId: string): Promise<RegisteredAppStatus | undefined> {
    const app = await new RegisteredAppRepository(this.db).getById(appId);
    return app?.status;
  }

  /**
   * Enumerate every consumer operation of every **active** CONSUMER spec — the universe the
   * AP-1.3 `not-yet-mapped` report diffs the endpoints against. Deduped per app (two active
   * CONSUMER specs declaring the same `resourceRef/operationId` yield one entry), keyed by a
   * nested app→operationRef `Set` so no delimiter is ever concatenated into a key.
   */
  public async listConsumerOperations(): Promise<ConsumerOperationRef[]> {
    const apps = await new RegisteredAppRepository(this.db).list();
    const specReader = new ApiSpecRepository(this.db);
    const result: ConsumerOperationRef[] = [];
    for (const app of apps) {
      const specs = await specReader.listByAppId(app.id);
      const seen = new Set<string>();
      for (const spec of specs) {
        if (spec.role !== "CONSUMER" || spec.status !== "active") {
          continue;
        }
        for (const group of spec.parsedIR) {
          for (const operation of group.operations) {
            const operationRef = `${group.resourceRef}/${operation.operationId}`;
            if (seen.has(operationRef)) {
              continue;
            }
            seen.add(operationRef);
            result.push({ consumerAppId: app.id, consumerOperationId: operationRef });
          }
        }
      }
    }
    return result;
  }
}

/** The `@mediator/db`-backed {@link AdapterRequestHistoryReader}. */
export class DbAdapterRequestHistoryReader implements AdapterRequestHistoryReader {
  public constructor(private readonly db: Database) {}

  public query(query: AdapterRequestQuery): Promise<AuditLogEntry[]> {
    return new AuditLogRepository(this.db).queryAdapterRequests(query);
  }
}
