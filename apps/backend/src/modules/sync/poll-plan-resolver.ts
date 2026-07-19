import type {
  ResourceBinding,
  ScopeCorrespondence,
  ScopeLink,
  SourceScopeRef,
} from "@mediator/domain";
import { resolveScopeLinkScopeValues, targetScopeKeyOf } from "@mediator/outbound";
import type {
  CrossScopePollPlan,
  PerScopePollPlan,
  PollPlanCommon,
  PollPlanResolution,
  PollPlanResolver,
  PollScope,
  PollScopeUnresolved,
} from "@mediator/sync-engine";

import { hasConfirmedScopePathBinding } from "./container-routing.js";
import { derivePollScopeMode } from "./poll-scope-mode.js";
import {
  confirmedValue,
  findIdentityField,
  isRefConfirmed,
  resolveRuleArtifacts,
  type RuleArtifactRepos,
  type RuleArtifacts,
} from "./resolution.js";

/**
 * The narrow scope-resolution reader ports the per-scope plan (SS-13.2/13.4) needs, on
 * top of {@link RuleArtifactRepos}: the pair's `ScopeCorrespondence` (its
 * `sourceContainerRef` decides enumerated-vs-pinned, SS-13.5) and its established
 * `ScopeLink`s (the scope set — SS-11). The real `@mediator/db` repos satisfy them.
 */
export interface ScopeResolutionRepos {
  readonly scopeCorrespondences: {
    getByResourcePair(resourcePairRef: string): Promise<ScopeCorrespondence | undefined>;
  };
  readonly scopeLinks: {
    listByCorrespondence(scopeCorrespondenceId: string): Promise<ScopeLink[]>;
  };
}

/**
 * The **real** {@link PollPlanResolver} the Poller consumes (SP deferred it to the
 * composition seam). It turns a rule id into the transport-agnostic `PollPlan` the
 * Poller runs, or the precise not-pollable reason the Poller records `skipped`.
 *
 * It is the **runtime backstop** (SP-2.5): BE-1's enablement gate already blocks a
 * rule from going live with an unconfirmed required ref, but the resolver refuses
 * anyway. The concrete REST wire binding (pagination/delta conventions) is the
 * separate {@link RepoRestSourceBindingResolver}'s job; this resolver decides
 * pollability + the mode/cursor/identity-path the Poller needs.
 *
 * **SS-13 — poll-enumeration mode (derive-then-correct).** It also decides the plan's
 * `scopeMode` (SS-13.5): the mode is *derived* from the source's container binding
 * (`derivePollScopeMode`) and the operator **override** (`SyncRule.pollScopeMode`) is
 * honored when set — mirroring its existing derive-then-decide for delta-vs-full-fetch.
 *  - **cross-scope** (SS-13.1) → the single-cursor plan, unchanged from SS-8.
 *  - **per-scope** (SS-13.2/13.4) → the resolved `ScopeLink`s become the plan's `scopes`
 *    (each with the container's scope-path-param fill from its source-side scope key),
 *    and any `ScopeLink` whose source-side fill does not resolve is surfaced as an
 *    `unresolvedScopes` entry the Poller parks — never a guessed container (fail-loud).
 */
export class RepoPollPlanResolver implements PollPlanResolver {
  readonly #repos: RuleArtifactRepos;
  readonly #scopeRepos: ScopeResolutionRepos;

  public constructor(repos: RuleArtifactRepos, scopeRepos: ScopeResolutionRepos) {
    this.#repos = repos;
    this.#scopeRepos = scopeRepos;
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

    // SS-13.5 — derive the poll-enumeration mode from the source container binding, and
    // honor the operator override (`SyncRule.pollScopeMode`) when set.
    const correspondence = await this.#scopeRepos.scopeCorrespondences.getByResourcePair(
      artifacts.rule.resourcePairRef,
    );
    const effectiveMode =
      artifacts.rule.pollScopeMode ?? derivePollScopeMode(artifacts.sourceBinding, correspondence);

    const common = buildCommon(artifacts, deltaPolling ? "delta" : "full-fetch", identityField);

    if (effectiveMode === "cross-scope") {
      // SS-13.1 — the SS-8 single-cursor plan, unchanged.
      const plan: CrossScopePollPlan = {
        ...common,
        scopeMode: "cross-scope",
        cursor: artifacts.rule.cursor ?? undefined,
      };
      return { pollable: true, plan };
    }

    // SS-13.2/13.4 — per-scope: resolve the scope set from the pair's `ScopeLink`s.
    const plan: PerScopePollPlan = {
      ...common,
      scopeMode: "per-scope",
      ...(await this.#resolveScopes(
        artifacts,
        effectiveMode === "per-scope-pinned",
        correspondence,
      )),
    };
    return { pollable: true, plan };
  }

  /**
   * SS-13.2/13.4 — resolve the rule's scope set from the established `ScopeLink`s under
   * the pair's `ScopeCorrespondence`. `pinnedOnly` (per-scope-pinned, SS-13.4) restricts
   * to `constant`/`manual` links; otherwise (per-scope-enumerated, SS-13.2) every active
   * link is polled. Each scope's `fillValues` come from the link's **source-side** scope
   * key run through the source read's `scope-link` bindings (SS-12's container fill,
   * source side). A link whose source-side fill does not resolve — or a pair with no
   * `ScopeCorrespondence` — is surfaced as `unresolvedScopes` the Poller parks (fail-loud,
   * never a guessed container — SS-11.5 / SS-12.6).
   */
  async #resolveScopes(
    artifacts: RuleArtifacts,
    pinnedOnly: boolean,
    correspondence: ScopeCorrespondence | undefined,
  ): Promise<{
    readonly scopes: readonly PollScope[];
    readonly unresolvedScopes: readonly PollScopeUnresolved[];
  }> {
    if (correspondence === undefined) {
      return {
        scopes: [],
        unresolvedScopes: [
          {
            container: artifacts.rule.resourcePairRef,
            reason:
              "no ScopeCorrespondence for the pair — confirm the scope identity key and link containers",
          },
        ],
      };
    }
    const links = await this.#scopeRepos.scopeLinks.listByCorrespondence(correspondence.id);
    const scopes: PollScope[] = [];
    const unresolvedScopes: PollScopeUnresolved[] = [];
    const bindings = artifacts.sourceBinding.scopePathBindings ?? [];
    for (const link of links) {
      if (link.status !== "active") {
        continue; // an archived link is not polled (its records route deletes via scopeRef).
      }
      if (pinnedOnly && link.establishedBy !== "constant" && link.establishedBy !== "manual") {
        continue; // SS-13.4 — pinned mode polls only operator-pinned links.
      }
      const sourceScopeKey = targetScopeKeyOf(link, artifacts.sourceApp.id);
      if (sourceScopeKey === undefined) {
        unresolvedScopes.push({
          container: link.id,
          reason: `ScopeLink ${link.id} does not address source app ${artifacts.sourceApp.id}`,
        });
        continue;
      }
      const fillValues = resolveScopeLinkScopeValues(bindings, sourceScopeKey);
      if (fillValues.size === 0) {
        unresolvedScopes.push({
          container: link.id,
          reason: `source scope path parameters did not resolve for ScopeLink ${link.id}`,
        });
        continue;
      }
      scopes.push({ scopeLinkId: link.id, fillValues });
    }
    return { scopes, unresolvedScopes };
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

/** The transport-agnostic fields every plan shares (SP-2/SP-3), independent of scope mode. */
function buildCommon(
  artifacts: RuleArtifacts,
  mode: "delta" | "full-fetch",
  identityField: { readonly sourcePath: string },
): PollPlanCommon {
  const sourceScopeRef = confirmedSourceScopeRef(artifacts.sourceBinding);
  // SS-14 — carry the TARGET resource's scope path bindings only when the rule is **scoped**
  // (a confirmed record-derived/scope-link container binding), so the pre-link queue key is
  // scope-qualified (SS-14.2) and an unresolved container parks (SS-14.3). Absent → non-scoped
  // rule → the resolver keeps the exact byte-for-byte key.
  const targetScopePathBindings = artifacts.targetBinding.scopePathBindings ?? [];
  const scoped = hasConfirmedScopePathBinding(targetScopePathBindings);
  return {
    ruleId: artifacts.rule.id,
    mappingId: artifacts.mapping.id,
    sourceAppId: artifacts.mapping.sourceAppId,
    targetAppId: artifacts.mapping.targetAppId,
    resourcePairRef: artifacts.rule.resourcePairRef,
    mode,
    identitySourcePath: identityField.sourcePath,
    ...(sourceScopeRef !== undefined ? { sourceScopeRef } : {}),
    ...(scoped ? { targetScopePathBindings } : {}),
  };
}

/**
 * The source resource's `sourceScopeRef` when it is **confirmed** (both
 * `confirmedBy`/`confirmedAt` set), else `undefined`. An unconfirmed ref is used nowhere
 * (SS-7.4), so the Poller captures no scope and constant / non-scoped rules are
 * unaffected. The ref's own schema guarantees at least one component when present.
 */
function confirmedSourceScopeRef(sourceBinding: ResourceBinding): SourceScopeRef | undefined {
  const ref = sourceBinding.sourceScopeRef;
  if (ref === undefined || ref.confirmedBy === null || ref.confirmedAt === null) {
    return undefined;
  }
  return ref;
}
