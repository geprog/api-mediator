import type { ApprovedMapping, BackfillMode, SyncRule } from "@mediator/domain";
import type { CounterpartBackfillModeLookup } from "@mediator/outbound";

/**
 * The real {@link CounterpartBackfillModeLookup} the enable action consults for the
 * at-most-one-`push` check (BE-5.3). It follows `ApprovedMapping.counterpartMappingId`
 * to the reverse-direction mapping, then to that mapping's `SyncRule` for the **same**
 * `resourcePairRef` (a `RecordLink`/`SyncFieldState` pair is shared by both directions),
 * and returns that rule's `backfillMode` — so the enable action refuses to let both
 * directions of a bidirectional pair `push` (which would fight over the same records).
 *
 * `undefined` when there is no counterpart (a one-way rule / a consumer-provider
 * mapping has none), no counterpart rule for the pair yet, or the counterpart declares
 * no explicit mode — every one of which is "no counterpart push to conflict with".
 */
export interface CounterpartBackfillModeRepos {
  readonly syncRules: { getById(id: string): Promise<SyncRule | undefined> };
  readonly approvedMappings: { getById(id: string): Promise<ApprovedMapping | undefined> };
  readonly rulesByMapping: {
    listSyncRulesByMapping(approvedMappingId: string): Promise<SyncRule[]>;
  };
}

export class RepoCounterpartBackfillModeLookup implements CounterpartBackfillModeLookup {
  readonly #repos: CounterpartBackfillModeRepos;

  public constructor(repos: CounterpartBackfillModeRepos) {
    this.#repos = repos;
  }

  public async getCounterpartBackfillMode(ruleId: string): Promise<BackfillMode | undefined> {
    const rule = await this.#repos.syncRules.getById(ruleId);
    if (rule === undefined) {
      return undefined;
    }
    const mapping = await this.#repos.approvedMappings.getById(rule.approvedMappingId);
    const counterpartMappingId = mapping?.counterpartMappingId;
    if (counterpartMappingId === undefined || counterpartMappingId === null) {
      return undefined;
    }
    const counterpartRules =
      await this.#repos.rulesByMapping.listSyncRulesByMapping(counterpartMappingId);
    const counterpart = counterpartRules.find(
      (candidate) => candidate.resourcePairRef === rule.resourcePairRef,
    );
    return counterpart?.backfillMode;
  }
}
