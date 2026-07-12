import type { ApiSpec, MappingProposal, MappingProposalItem } from "@mediator/domain";
import { FakeProvider, type LLMMappingProvider } from "@mediator/llm";

import {
  ApprovalService,
  EscapeHatchService,
  ProposalReadService,
  type EscapeHatchWriter,
  type ProposalReader,
} from "../modules/approval/index.js";
import { FakeApprovalPersistence } from "../modules/approval/approval.testkit.js";
import type { SpecReader } from "../modules/persistence.js";

/**
 * Test fakes for the Phase-3 Review & Approval HTTP API (RA-1..RA-5). They back
 * the read side (`ProposalReadService`) and the escape hatch (`EscapeHatchService`)
 * over the **same** in-memory {@link FakeApprovalPersistence} the `ApprovalService`
 * mutations use, so one seed (`seedSpec`/`seedProposal`/`seedApprovedMapping`) feeds
 * every RA route and every assertion reads one store.
 *
 * The reader/writer fakes **faithfully mirror** the real `MappingProposalRepository`
 * /`ApiSpecRepository` observable semantics (absent-key `undefined`, `listItems`
 * filtered by `proposalId`, `addItems` insert + `setShortlistResult` replace) so a
 * bug that would surface against Postgres is not masked here.
 *
 * A `*.testkit.ts` file: type-checked, excluded from `dist`, never collected as a
 * Vitest suite.
 */

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}

/** A pooled proposal reader over the shared {@link FakeApprovalPersistence} maps. */
class FakeProposalReader implements ProposalReader {
  public constructor(private readonly persistence: FakeApprovalPersistence) {}

  public listBySourceSpecId(specId: string): Promise<MappingProposal[]> {
    return Promise.resolve(
      [...this.persistence.proposals.values()]
        .filter((proposal) => proposal.sourceSpecId === specId)
        .map(clone),
    );
  }

  public getById(id: string): Promise<MappingProposal | undefined> {
    return Promise.resolve(cloneOrUndefined(this.persistence.proposals.get(id)));
  }

  public listItems(proposalId: string): Promise<MappingProposalItem[]> {
    return Promise.resolve(
      [...this.persistence.items.values()]
        .filter((item) => item.proposalId === proposalId)
        .map(clone),
    );
  }

  public getItemById(itemId: string): Promise<MappingProposalItem | undefined> {
    return Promise.resolve(cloneOrUndefined(this.persistence.items.get(itemId)));
  }
}

/** A pooled spec reader over the shared {@link FakeApprovalPersistence} specs. */
class FakeApprovalSpecReader implements SpecReader {
  public constructor(private readonly persistence: FakeApprovalPersistence) {}

  public getById(id: string): Promise<ApiSpec | undefined> {
    return Promise.resolve(cloneOrUndefined(this.persistence.specs.get(id)));
  }

  public listByAppId(appId: string): Promise<ApiSpec[]> {
    return Promise.resolve(
      [...this.persistence.specs.values()].filter((spec) => spec.appId === appId).map(clone),
    );
  }
}

/**
 * The escape-hatch attach over the shared maps: mirrors `addItems` (insert) +
 * `setShortlistResult` (replace the proposal's jsonb) as one synchronous unit.
 */
class FakeEscapeHatchWriter implements EscapeHatchWriter {
  public constructor(private readonly persistence: FakeApprovalPersistence) {}

  public attach(input: Parameters<EscapeHatchWriter["attach"]>[0]): Promise<void> {
    for (const item of input.items) {
      this.persistence.items.set(item.id, clone(item));
    }
    const proposal = this.persistence.proposals.get(input.proposalId);
    if (proposal !== undefined) {
      this.persistence.proposals.set(input.proposalId, {
        ...proposal,
        shortlistResult: clone(input.shortlistResult),
      });
    }
    return Promise.resolve();
  }
}

/** Options for {@link buildApprovalApiDeps}. */
export interface ApprovalApiTestOptions {
  /** Override the escape hatch's LLM provider (default: an unscripted `FakeProvider`). */
  readonly provider?: LLMMappingProvider;
  /** The `reviewRequired` threshold RA-1 derives against (default `0.7`). */
  readonly reviewThreshold?: number;
  /** Corrective-retry cap for the escape hatch's detail call (default `0`: one attempt). */
  readonly maxRetries?: number;
}

/** The three RA services built over one shared {@link FakeApprovalPersistence}. */
export interface ApprovalApiDeps {
  readonly proposalReadService: ProposalReadService;
  readonly approvalService: ApprovalService;
  readonly escapeHatchService: EscapeHatchService;
}

/**
 * Build the RA services over a shared {@link FakeApprovalPersistence}. The escape
 * hatch reuses the real `@mediator/mapping-engine` detail path driven by the
 * injected {@link FakeProvider} — no live LLM.
 */
export function buildApprovalApiDeps(
  persistence: FakeApprovalPersistence,
  options: ApprovalApiTestOptions = {},
): ApprovalApiDeps {
  const proposals = new FakeProposalReader(persistence);
  const specs = new FakeApprovalSpecReader(persistence);
  const provider = options.provider ?? new FakeProvider();
  return {
    approvalService: new ApprovalService({ unitOfWork: persistence }),
    proposalReadService: new ProposalReadService({
      proposals,
      specs,
      reviewThreshold: options.reviewThreshold ?? 0.7,
    }),
    escapeHatchService: new EscapeHatchService({
      proposals,
      specs,
      detection: {
        provider,
        maxRetries: options.maxRetries ?? 0,
        promptVersion: "test-prompt-v1",
      },
      writer: new FakeEscapeHatchWriter(persistence),
    }),
  };
}
