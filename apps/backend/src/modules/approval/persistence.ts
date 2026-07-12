import type { Database, MappingArtifacts } from "@mediator/db";
import {
  ApiSpecRepository,
  ApprovedMappingRepository,
  AuditLogRepository,
  MappingArtifactsRepository,
  MappingProposalRepository,
  tx,
} from "@mediator/db";
import type { EventBus } from "@mediator/event-bus";
import type {
  ApiSpec,
  ApprovedMapping,
  AuditLogEntry,
  DomainEventEnvelope,
  FieldMapping,
  MappingProposal,
  MappingProposalItem,
  MappingProposalStatus,
  OperationMapping,
  ParameterMapping,
} from "@mediator/domain";

/**
 * The persistence seam for the Approval Service (AS-1..AS-6). Unlike the
 * registration slice's split of pooled readers vs. transactional writers, the
 * Approval Service does **all** of its reads and writes inside **one**
 * transaction: the AS-3 edit-path validation is a precondition of assembly, so it
 * must read the proposal/items/specs/counterpart in the *same* atomic unit that
 * writes the `ApprovedMapping` and emits `MappingApproved` — a validation failure
 * then rolls the whole thing back and commits nothing (AS-3 criterion 5, AS-6
 * criterion 6). The `emit` is pre-bound to the open transaction so the
 * `MappingApproved` outbox row commits or rolls back with the mapping (AS-6
 * criterion 5), exactly as `SpecIngested` does.
 *
 * The ports are narrow interfaces (not the concrete `@mediator/db` repositories)
 * so the service is unit-testable against in-memory fakes that faithfully mirror
 * the real Drizzle repositories' semantics.
 */

// ── Transactional ports ──────────────────────────────────────────────────────

export interface ProposalTxRepo {
  getById(id: string): Promise<MappingProposal | undefined>;
  listItems(proposalId: string): Promise<MappingProposalItem[]>;
  getItemById(itemId: string): Promise<MappingProposalItem | undefined>;
  updateStatus(id: string, status: MappingProposalStatus): Promise<MappingProposal | undefined>;
  updateItemReview(item: MappingProposalItem): Promise<MappingProposalItem | undefined>;
}

export interface SpecTxReader {
  getById(id: string): Promise<ApiSpec | undefined>;
}

export interface ApprovedMappingTxRepo {
  getActiveByDirectionalSpecPair(
    sourceSpecId: string,
    targetSpecId: string,
  ): Promise<ApprovedMapping | undefined>;
  insert(mapping: ApprovedMapping): Promise<ApprovedMapping>;
  update(mapping: ApprovedMapping): Promise<ApprovedMapping | undefined>;
  setCounterpart(id: string, counterpartMappingId: string | null): Promise<void>;
}

export interface MappingArtifactsTxRepo {
  listFieldMappings(mappingId: string): Promise<FieldMapping[]>;
  listOperationMappings(mappingId: string): Promise<OperationMapping[]>;
  listParameterMappings(mappingId: string): Promise<ParameterMapping[]>;
  replaceChildren(mappingId: string, artifacts: MappingArtifacts): Promise<void>;
}

export interface AuditTxRepo {
  insert(entry: AuditLogEntry): Promise<void>;
}

/**
 * The repositories + event emit available inside one approve/decide transaction.
 * `emit` is already bound to the open transaction (transactional outbox), so
 * callers just hand it a domain event.
 */
export interface ApprovalTxStores {
  readonly proposals: ProposalTxRepo;
  readonly specs: SpecTxReader;
  readonly approvedMappings: ApprovedMappingTxRepo;
  readonly artifacts: MappingArtifactsTxRepo;
  readonly audit: AuditTxRepo;
  emit(event: DomainEventEnvelope): Promise<void>;
}

/** Runs `work` inside a database transaction with a fully-built {@link ApprovalTxStores}. */
export interface ApprovalUnitOfWork {
  run<T>(work: (stores: ApprovalTxStores) => Promise<T>): Promise<T>;
}

// ── Postgres-backed implementation ───────────────────────────────────────────

/**
 * The real {@link ApprovalUnitOfWork}: opens a `@mediator/db` transaction and
 * builds an {@link ApprovalTxStores} whose repositories and event emit all run on
 * that one transaction handle, so the whole approve — validation reads,
 * `ApprovedMapping` write, and `MappingApproved` emit — is a single atomic unit.
 */
export class DbApprovalUnitOfWork implements ApprovalUnitOfWork {
  readonly #db: Database;
  readonly #eventBus: EventBus;

  public constructor(db: Database, eventBus: EventBus) {
    this.#db = db;
    this.#eventBus = eventBus;
  }

  public run<T>(work: (stores: ApprovalTxStores) => Promise<T>): Promise<T> {
    return tx(this.#db, (txn) =>
      work({
        proposals: new MappingProposalRepository(txn),
        specs: new ApiSpecRepository(txn),
        approvedMappings: new ApprovedMappingRepository(txn),
        artifacts: new MappingArtifactsRepository(txn),
        audit: new AuditLogRepository(txn),
        emit: (event) => this.#eventBus.emit(event, txn),
      }),
    );
  }
}
