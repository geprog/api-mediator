import type { ResourceBinding } from "@mediator/domain";
import type { PollPlan, PollPlanResolution, PollPlanResolver } from "@mediator/sync-engine";

import {
  confirmedValue,
  findIdentityField,
  isRefConfirmed,
  resolveRuleArtifacts,
  type RuleArtifactRepos,
} from "./resolution.js";

/**
 * The **real** {@link PollPlanResolver} the Poller consumes (SP deferred it to the
 * composition seam). It turns a rule id into the transport-agnostic {@link PollPlan}
 * the Poller runs (ids, poll `mode`, delta `cursor`, and the confirmed identity
 * **source** path the pre-enqueue queue key is computed from), or the precise
 * not-pollable reason the Poller records `skipped`.
 *
 * It is the **runtime backstop** (SP-2.5): BE-1's enablement gate already blocks a
 * rule from going live with an unconfirmed required ref, but the resolver refuses
 * anyway — an unconfirmed native-id or poll operation, or a missing identity key, is
 * *used nowhere*. The concrete REST wire binding (pagination/delta conventions) is the
 * separate {@link RepoRestSourceBindingResolver}'s job; this resolver only decides
 * pollability + the mode/cursor/identity-path the Poller needs, mirroring that
 * resolver's delta-vs-full-fetch decision exactly.
 */
export class RepoPollPlanResolver implements PollPlanResolver {
  readonly #repos: RuleArtifactRepos;

  public constructor(repos: RuleArtifactRepos) {
    this.#repos = repos;
  }

  public async resolve(ruleId: string): Promise<PollPlanResolution> {
    const artifacts = await resolveRuleArtifacts(ruleId, this.#repos);
    if (artifacts === undefined) {
      return { pollable: false, reason: "rule-not-found" };
    }

    // BE-1.1 — the hard identity gate: exactly one confirmed identity FieldMapping.
    const identityField = findIdentityField(artifacts.fieldMappings);
    if (identityField === undefined) {
      return { pollable: false, reason: "missing-identity-key" };
    }

    // BE-2.1 — the source native id is required and confirmed (used nowhere unconfirmed).
    if (!isRefConfirmed(artifacts.sourceBinding.nativeIdRef)) {
      return { pollable: false, reason: "unconfirmed-native-id" };
    }

    // A rule is delta-polling iff the source declares `supportsDeltaQuery` AND the
    // resource offers a delta operation (a *present* deltaCursorRef) — mirrors the
    // source binding resolver's `isDeltaPolling` exactly.
    const deltaPolling =
      artifacts.sourceApp.capabilities.supportsDeltaQuery &&
      artifacts.sourceBinding.deltaCursorRef !== undefined;

    // SP-2.5 — the source read operation must resolve from a confirmed ref: the pinned
    // `pollOperationRef`, else the mode's confirmed structured ref (deltaCursorRef for
    // delta, collectionReadRef for full-fetch). An unconfirmed one is used nowhere.
    if (
      !this.#pollOperationConfirmed(
        artifacts.rule.pollOperationRef,
        deltaPolling,
        artifacts.sourceBinding,
      )
    ) {
      return { pollable: false, reason: "unconfirmed-poll-operation" };
    }

    const plan: PollPlan = {
      ruleId: artifacts.rule.id,
      mappingId: artifacts.mapping.id,
      sourceAppId: artifacts.mapping.sourceAppId,
      targetAppId: artifacts.mapping.targetAppId,
      resourcePairRef: artifacts.rule.resourcePairRef,
      mode: deltaPolling ? "delta" : "full-fetch",
      identitySourcePath: identityField.sourcePath,
      cursor: artifacts.rule.cursor ?? undefined,
    };
    return { pollable: true, plan };
  }

  #pollOperationConfirmed(
    pollOperationRef: string | undefined,
    deltaPolling: boolean,
    sourceBinding: ResourceBinding,
  ): boolean {
    // A pinned, non-empty `pollOperationRef` is treated as confirmed (the domain models
    // it as a plain optional string, mirroring the enablement gate).
    if (pollOperationRef !== undefined && pollOperationRef.length > 0) {
      return true;
    }
    return deltaPolling
      ? confirmedValue(sourceBinding.deltaCursorRef) !== undefined
      : confirmedValue(sourceBinding.collectionReadRef) !== undefined;
  }
}
