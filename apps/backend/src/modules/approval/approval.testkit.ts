import type { MappingArtifacts } from "@mediator/db";
import {
  stripUndefined,
  type ApiSpec,
  type ApprovedMapping,
  type AuditLogEntry,
  type DomainEventEnvelope,
  type FieldMapping,
  type MappingProposal,
  type MappingProposalItem,
  type MappingProposalStatus,
  type OperationMapping,
  type ParameterMapping,
} from "@mediator/domain";

import type { ApprovalTxStores, ApprovalUnitOfWork } from "./persistence.js";

/**
 * In-memory {@link ApprovalUnitOfWork} for the Approval Service unit tests. It
 * **faithfully mirrors** the real `@mediator/db` repositories' observable
 * semantics — insert-vs-update, the `stripUndefined` NULL→absent collapse of every
 * nullable column, the item mapper's null-vs-absent `transformSuggestion`
 * reconstruction, the `getActiveByDirectionalSpecPair` `status='active'` filter,
 * and `replaceChildren`'s delete-then-insert — so a bug that would surface against
 * Postgres is not masked here. `run` snapshots all stores and rolls them back on a
 * thrown error, mirroring the transaction rollback that gives AS-3 its atomicity.
 *
 * A `*.testkit.ts` file: type-checked, excluded from `dist`, never collected as a
 * Vitest suite.
 */

// ── mapper-faithful normalizers (NULL/undefined → absent key) ─────────────────

function normalizeApprovedMapping(mapping: ApprovedMapping): ApprovedMapping {
  return stripUndefined({
    ...mapping,
    counterpartMappingId: mapping.counterpartMappingId ?? undefined,
  });
}

function normalizeFieldMapping(field: FieldMapping): FieldMapping {
  return stripUndefined({
    ...field,
    transformConfig: field.transformConfig ?? undefined,
    phase: field.phase ?? undefined,
    isIdentityKey: field.isIdentityKey ?? undefined,
    targetLookupParamRef: field.targetLookupParamRef ?? undefined,
    conflictPolicy: field.conflictPolicy ?? undefined,
  });
}

function normalizeOperationMapping(operation: OperationMapping): OperationMapping {
  return stripUndefined({
    ...operation,
    targetIdParamRef: operation.targetIdParamRef ?? undefined,
  });
}

function normalizeParameterMapping(parameter: ParameterMapping): ParameterMapping {
  return stripUndefined({
    ...parameter,
    transform: parameter.transform ?? undefined,
    transformConfig: parameter.transformConfig ?? undefined,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface Snapshot {
  proposals: Map<string, MappingProposal>;
  items: Map<string, MappingProposalItem>;
  approvedMappings: Map<string, ApprovedMapping>;
  fieldMappings: FieldMapping[];
  operationMappings: OperationMapping[];
  parameterMappings: ParameterMapping[];
  auditEntries: AuditLogEntry[];
  events: DomainEventEnvelope[];
}

export class FakeApprovalPersistence implements ApprovalUnitOfWork {
  public readonly proposals = new Map<string, MappingProposal>();
  public readonly items = new Map<string, MappingProposalItem>();
  public readonly specs = new Map<string, ApiSpec>();
  public approvedMappings = new Map<string, ApprovedMapping>();
  public fieldMappings: FieldMapping[] = [];
  public operationMappings: OperationMapping[] = [];
  public parameterMappings: ParameterMapping[] = [];
  public auditEntries: AuditLogEntry[] = [];
  public events: DomainEventEnvelope[] = [];

  public seedSpec(spec: ApiSpec): void {
    this.specs.set(spec.id, clone(spec));
  }

  public seedProposal(proposal: MappingProposal, items: readonly MappingProposalItem[]): void {
    this.proposals.set(proposal.id, clone(proposal));
    for (const item of items) {
      this.items.set(item.id, clone(item));
    }
  }

  public seedApprovedMapping(
    mapping: ApprovedMapping,
    artifacts: Partial<MappingArtifacts> = {},
  ): void {
    this.approvedMappings.set(mapping.id, normalizeApprovedMapping(clone(mapping)));
    for (const field of artifacts.fieldMappings ?? []) {
      this.fieldMappings.push(normalizeFieldMapping(clone(field)));
    }
    for (const operation of artifacts.operationMappings ?? []) {
      this.operationMappings.push(normalizeOperationMapping(clone(operation)));
    }
    for (const parameter of artifacts.parameterMappings ?? []) {
      this.parameterMappings.push(normalizeParameterMapping(clone(parameter)));
    }
  }

  #snapshot(): Snapshot {
    return {
      proposals: new Map([...this.proposals].map(([id, value]) => [id, clone(value)])),
      items: new Map([...this.items].map(([id, value]) => [id, clone(value)])),
      approvedMappings: new Map(
        [...this.approvedMappings].map(([id, value]) => [id, clone(value)]),
      ),
      fieldMappings: this.fieldMappings.map(clone),
      operationMappings: this.operationMappings.map(clone),
      parameterMappings: this.parameterMappings.map(clone),
      auditEntries: this.auditEntries.map(clone),
      events: this.events.map(clone),
    };
  }

  #restore(snapshot: Snapshot): void {
    this.proposals.clear();
    for (const [id, value] of snapshot.proposals) this.proposals.set(id, value);
    this.items.clear();
    for (const [id, value] of snapshot.items) this.items.set(id, value);
    this.approvedMappings = snapshot.approvedMappings;
    this.fieldMappings = snapshot.fieldMappings;
    this.operationMappings = snapshot.operationMappings;
    this.parameterMappings = snapshot.parameterMappings;
    this.auditEntries = snapshot.auditEntries;
    this.events = snapshot.events;
  }

  public async run<T>(work: (stores: ApprovalTxStores) => Promise<T>): Promise<T> {
    const snapshot = this.#snapshot();
    try {
      return await work(this.#stores());
    } catch (error) {
      this.#restore(snapshot);
      throw error;
    }
  }

  #stores(): ApprovalTxStores {
    return {
      proposals: {
        getById: (id) => Promise.resolve(this.#cloneOrUndefined(this.proposals.get(id))),
        listItems: (proposalId) =>
          Promise.resolve(
            [...this.items.values()].filter((item) => item.proposalId === proposalId).map(clone),
          ),
        getItemById: (itemId) => Promise.resolve(this.#cloneOrUndefined(this.items.get(itemId))),
        updateStatus: (id, status) => Promise.resolve(this.#updateStatus(id, status)),
        updateItemReview: (item) => Promise.resolve(this.#updateItemReview(item)),
      },
      specs: {
        getById: (id) => Promise.resolve(this.#cloneOrUndefined(this.specs.get(id))),
      },
      approvedMappings: {
        getActiveByDirectionalSpecPair: (sourceSpecId, targetSpecId) =>
          Promise.resolve(
            this.#cloneOrUndefined(
              [...this.approvedMappings.values()].find(
                (mapping) =>
                  mapping.sourceSpecId === sourceSpecId &&
                  mapping.targetSpecId === targetSpecId &&
                  mapping.status === "active",
              ),
            ),
          ),
        insert: (mapping) => {
          const stored = normalizeApprovedMapping(clone(mapping));
          this.approvedMappings.set(stored.id, stored);
          return Promise.resolve(clone(stored));
        },
        update: (mapping) => {
          if (!this.approvedMappings.has(mapping.id)) return Promise.resolve(undefined);
          const stored = normalizeApprovedMapping(clone(mapping));
          this.approvedMappings.set(stored.id, stored);
          return Promise.resolve(clone(stored));
        },
        setCounterpart: (id, counterpartMappingId) => {
          const stored = this.approvedMappings.get(id);
          if (stored !== undefined) {
            this.approvedMappings.set(
              id,
              normalizeApprovedMapping({
                ...stored,
                counterpartMappingId: counterpartMappingId ?? undefined,
              }),
            );
          }
          return Promise.resolve();
        },
      },
      artifacts: {
        listFieldMappings: (mappingId) =>
          Promise.resolve(this.fieldMappings.filter((f) => f.mappingId === mappingId).map(clone)),
        listOperationMappings: (mappingId) =>
          Promise.resolve(
            this.operationMappings.filter((o) => o.mappingId === mappingId).map(clone),
          ),
        listParameterMappings: (mappingId) => {
          const opIds = new Set(
            this.operationMappings.filter((o) => o.mappingId === mappingId).map((o) => o.id),
          );
          return Promise.resolve(
            this.parameterMappings.filter((p) => opIds.has(p.operationMappingId)).map(clone),
          );
        },
        replaceChildren: (mappingId, artifacts) => {
          const opIds = new Set(
            this.operationMappings.filter((o) => o.mappingId === mappingId).map((o) => o.id),
          );
          this.fieldMappings = this.fieldMappings.filter((f) => f.mappingId !== mappingId);
          this.operationMappings = this.operationMappings.filter((o) => o.mappingId !== mappingId);
          // Cascade parameter_mapping when its operation_mapping is deleted.
          this.parameterMappings = this.parameterMappings.filter(
            (p) => !opIds.has(p.operationMappingId),
          );
          this.fieldMappings.push(
            ...artifacts.fieldMappings.map((f) => normalizeFieldMapping(clone(f))),
          );
          this.operationMappings.push(
            ...artifacts.operationMappings.map((o) => normalizeOperationMapping(clone(o))),
          );
          this.parameterMappings.push(
            ...artifacts.parameterMappings.map((p) => normalizeParameterMapping(clone(p))),
          );
          return Promise.resolve();
        },
      },
      audit: {
        insert: (entry) => {
          this.auditEntries.push(clone(entry));
          return Promise.resolve();
        },
      },
      emit: (event) => {
        this.events.push(clone(event));
        return Promise.resolve();
      },
    };
  }

  #cloneOrUndefined<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : clone(value);
  }

  #updateStatus(id: string, status: MappingProposalStatus): MappingProposal | undefined {
    const stored = this.proposals.get(id);
    if (stored === undefined) return undefined;
    const updated: MappingProposal = { ...stored, status };
    this.proposals.set(id, updated);
    return clone(updated);
  }

  /**
   * Mirror `MappingProposalRepository.updateItemReview`: write only the four
   * mutable review columns and reconstruct the domain item exactly as the mapper
   * does — `target_ref` NULL → absent, and `transform_suggestion` NULL is domain
   * `null` for a mapped item but **absent** for an `unmapped` one.
   */
  #updateItemReview(item: MappingProposalItem): MappingProposalItem | undefined {
    const stored = this.items.get(item.id);
    if (stored === undefined) return undefined;
    const targetRefColumn = item.targetRef ?? null;
    const transformColumn = item.transformSuggestion ?? null;
    const unmappedColumn = item.unmapped;
    const updated = stripUndefined({
      ...stored,
      targetRef: targetRefColumn ?? undefined,
      transformSuggestion:
        transformColumn !== null ? transformColumn : unmappedColumn ? undefined : null,
      unmapped: unmappedColumn,
      reviewState: item.reviewState,
    });
    this.items.set(item.id, updated);
    return clone(updated);
  }
}
