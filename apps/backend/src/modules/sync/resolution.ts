import { fieldResourceRef } from "@mediator/domain";
import type {
  ApiSpec,
  ApprovedMapping,
  ConfirmableRef,
  FieldMapping,
  IrRefTarget,
  IrResourceGroup,
  OperationMapping,
  RegisteredApp,
  ResourceBinding,
  SyncRule,
} from "@mediator/domain";

/**
 * **Shared rule-artifact resolution** — the persisted-state → in-memory-object load
 * every sync composition adapter (the pipeline context loader, the poll-plan
 * resolver, the enable resolver) performs before it can turn a `SyncRule` into an
 * executable plan. It loads the rule, its `ApprovedMapping` + `FieldMapping`s +
 * `OperationMapping`s, both sides' `ApiSpec.parsedIR` group + `ResourceBinding` +
 * `RegisteredApp`, and resolves the canonical A/B assignment and the source/target
 * resource refs from the rule's `resourcePairRef`.
 *
 * It is deliberately **direction-scoped by the mapping**: `ApprovedMapping` is
 * one-directional (`sourceAppId → targetAppId`), so "source"/"target" here mean the
 * rule's own poll/write direction, while `appAId`/`appBId` are the direction-agnostic
 * canonical assignment the `RecordLink`/`SyncFieldState`/stage contexts key on.
 */

/** The narrow reader ports the resolution needs (the real `@mediator/db` repos satisfy them). */
export interface RuleArtifactRepos {
  readonly syncRules: { getById(id: string): Promise<SyncRule | undefined> };
  readonly approvedMappings: { getById(id: string): Promise<ApprovedMapping | undefined> };
  readonly mappingArtifacts: {
    listFieldMappings(mappingId: string): Promise<FieldMapping[]>;
    listOperationMappings(mappingId: string): Promise<OperationMapping[]>;
  };
  readonly apiSpecs: {
    getById(id: string): Promise<ApiSpec | undefined>;
    listByAppId(appId: string): Promise<ApiSpec[]>;
  };
  readonly resourceBindings: { listByApiSpecId(apiSpecId: string): Promise<ResourceBinding[]> };
  readonly registeredApps: { getById(id: string): Promise<RegisteredApp | undefined> };
}

/** Everything a sync adapter needs, loaded and direction-resolved for one rule. */
export interface RuleArtifacts {
  readonly rule: SyncRule;
  readonly mapping: ApprovedMapping;
  readonly fieldMappings: readonly FieldMapping[];
  readonly operationMappings: readonly OperationMapping[];
  readonly sourceApp: RegisteredApp;
  readonly targetApp: RegisteredApp;
  /** The source app's reachable base URL (guaranteed present — a base URL-less app does not resolve). */
  readonly sourceBaseUrl: string;
  /** The target app's reachable base URL (guaranteed present). */
  readonly targetBaseUrl: string;
  readonly sourceSpec: ApiSpec;
  readonly targetSpec: ApiSpec;
  readonly sourceGroup: IrResourceGroup;
  readonly targetGroup: IrResourceGroup;
  readonly sourceBinding: ResourceBinding;
  readonly targetBinding: ResourceBinding;
  readonly sourceResourceRef: string;
  readonly targetResourceRef: string;
  /** Canonical A/B app assignment for `resourcePairRef` (ordered by a stable key, not by direction). */
  readonly appAId: string;
  readonly appBId: string;
}

/** One side of a canonical `resourcePairRef` token: `appId:resourceRef`. */
export interface ResourcePairSide {
  readonly appId: string;
  readonly resourceRef: string;
}

/**
 * Parse a canonical `resourcePairRef` (`appId:resourceRef|appId:resourceRef`, ordered
 * by a stable lexicographic key — `derive.ts` `canonicalResourcePairRef`) into its two
 * sides. `a` is the first token (canonical app A), `b` the second (app B). `appId` is
 * UUID-shaped (no `:`) and `resourceRef` is a path noun (no `:`/`|`), so the first `:`
 * and the single `|` split unambiguously.
 */
export function parseResourcePairRef(
  ref: string,
): { readonly a: ResourcePairSide; readonly b: ResourcePairSide } | undefined {
  const tokens = ref.split("|");
  if (tokens.length !== 2) {
    return undefined;
  }
  const a = parseSide(tokens[0]);
  const b = parseSide(tokens[1]);
  return a !== undefined && b !== undefined ? { a, b } : undefined;
}

function parseSide(token: string | undefined): ResourcePairSide | undefined {
  if (token === undefined) {
    return undefined;
  }
  const colon = token.indexOf(":");
  if (colon <= 0 || colon >= token.length - 1) {
    return undefined;
  }
  return { appId: token.slice(0, colon), resourceRef: token.slice(colon + 1) };
}

/** A ref is confirmed iff present with **both** confirmation stamps set (mirrors the gate/resolvers). */
export function isRefConfirmed(ref: ConfirmableRef | undefined): boolean {
  return ref !== undefined && ref.confirmedBy !== null && ref.confirmedAt !== null;
}

/** The confirmed ref's value, or `undefined` when absent/unconfirmed — never a guess. */
export function confirmedValue(ref: ConfirmableRef | undefined): IrRefTarget | undefined {
  return isRefConfirmed(ref) ? ref?.value : undefined;
}

/** A confirmed `field`-kind ref's path, else `undefined`. */
export function confirmedFieldPath(ref: ConfirmableRef | undefined): string | undefined {
  const value = confirmedValue(ref);
  return value?.kind === "field" ? value.path : undefined;
}

/**
 * The mapping's single confirmed identity `FieldMapping` (`isIdentityKey = true`), or
 * `undefined` when there is not exactly one — the record-merge-prevention gate the
 * enablement check enforces (BE-1.1). Zero → duplicates; more than one → silent
 * merge; either is a non-resolution here.
 */
export function findIdentityField(
  fieldMappings: readonly FieldMapping[],
): FieldMapping | undefined {
  const identity = fieldMappings.filter((field) => field.isIdentityKey === true);
  return identity.length === 1 ? identity[0] : undefined;
}

/**
 * The subset of a mapping's `FieldMapping`s that belong to **one** resource pair.
 *
 * An `ApprovedMapping` covers N resource pairs (`docs/architecture/data-model.md`
 * `SyncRule`: "one `SyncRule` per mapped resource pair … a mapping covering four
 * resource pairs yields four independently enable-able rules"), and a `FieldMapping`
 * row carries no pair reference — its resource-qualified `sourcePath`/`targetPath`
 * (`issues/title`) are what say which pair it belongs to. Without this filter every
 * rule under a multi-pair mapping receives *every* pair's fields, so a `users→members`
 * pairing would be transformed into an `issues→tasks` write, seeded as `SyncFieldState`
 * on the wrong link, and compared by conflict detection against a field the record
 * does not have.
 *
 * **Tolerant on purpose, in the safe direction:** a field whose paths carry no
 * resource qualification cannot be attributed to any pair, so it is **retained**
 * (the long-standing behavior — the Phase-4 SU-6 capstone and much of the unit-test
 * corpus seed bare paths). Only a field that positively identifies itself as
 * belonging to a *different* pair is excluded, so this can never drop a field a rule
 * legitimately needs.
 *
 * The cost of that tolerance is over-retention on a **mixed-qualification** mapping:
 * an unqualified field is retained for *every* pair, so on a mapping that covers
 * N > 1 pairs and qualifies only some of its fields, the unqualified one is
 * transformed into every pair's write — the exact cross-pair leak the filter exists
 * to stop. This is not producible today (a real `ApprovedMapping` is assembled with
 * every path qualified, so a multi-pair mapping is uniformly qualified and the
 * unqualified corpus is all single-pair), which is why the tolerance is kept rather
 * than hardened into a rejection. A producer that starts emitting mixed
 * qualification would have to revisit it.
 */
export function fieldMappingsForResourcePair(
  fieldMappings: readonly FieldMapping[],
  sourceResourceRef: string,
  targetResourceRef: string,
): readonly FieldMapping[] {
  return fieldMappings.filter((field) => {
    const source = fieldResourceRef(field.sourcePath);
    const target = fieldResourceRef(field.targetPath);
    const sourceForeign = source !== undefined && source !== sourceResourceRef;
    const targetForeign = target !== undefined && target !== targetResourceRef;
    return !sourceForeign && !targetForeign;
  });
}

function findGroup(spec: ApiSpec, resourceRef: string): IrResourceGroup | undefined {
  return spec.parsedIR.find((group) => group.resourceRef === resourceRef);
}

function findBinding(
  bindings: readonly ResourceBinding[],
  resourceRef: string,
): ResourceBinding | undefined {
  return bindings.find((binding) => binding.resourceRef === resourceRef);
}

/**
 * Resolve a rule id into its {@link RuleArtifacts}, or `undefined` when any required
 * artifact is missing (rule/mapping/spec/group/binding/app absent, an unparseable or
 * degenerate self-pair `resourcePairRef`, or a base URL-less source/target app). Never
 * fabricates a binding — the per-ref confirmation checks are the caller's (the source
 * binding resolver / enablement gate), decided over the returned `ResourceBinding`s.
 *
 * `mappingOverride` (SL-8.5) resolves the rule's artifacts against a **specific** mapping
 * instead of the rule's currently-persisted `approvedMappingId`. The successor-adoption seeding
 * backfill passes the **successor** mapping (committed at approval), so the seed reads the
 * successor's fields/spec-version/bindings without waiting for the adoption transaction's
 * re-point to commit — the re-point moves only `approvedMappingId`, and this bypasses that read.
 * The override must be a mapping for this rule's directional pair (its `sourceAppId`/`targetAppId`
 * matching the rule's `resourcePairRef` sides); a mismatch returns `undefined` exactly as a
 * degenerate ref does. Omitted → the rule's persisted mapping is loaded (every other caller).
 */
export async function resolveRuleArtifacts(
  ruleId: string,
  repos: RuleArtifactRepos,
  mappingOverride?: ApprovedMapping,
): Promise<RuleArtifacts | undefined> {
  const rule = await repos.syncRules.getById(ruleId);
  if (rule === undefined) {
    return undefined;
  }
  const mapping = mappingOverride ?? (await repos.approvedMappings.getById(rule.approvedMappingId));
  if (mapping === undefined) {
    return undefined;
  }
  const sides = parseResourcePairRef(rule.resourcePairRef);
  if (sides === undefined) {
    return undefined;
  }
  // A self-pair (same app both sides) cannot be disambiguated by app id — refuse.
  const source =
    sides.a.appId === mapping.sourceAppId
      ? sides.a
      : sides.b.appId === mapping.sourceAppId
        ? sides.b
        : undefined;
  const target =
    sides.a.appId === mapping.targetAppId
      ? sides.a
      : sides.b.appId === mapping.targetAppId
        ? sides.b
        : undefined;
  if (source === undefined || target === undefined) {
    return undefined;
  }
  if (mapping.sourceAppId === mapping.targetAppId && source.resourceRef === target.resourceRef) {
    return undefined;
  }

  const [sourceApp, targetApp, sourceSpec, targetSpec] = await Promise.all([
    repos.registeredApps.getById(mapping.sourceAppId),
    repos.registeredApps.getById(mapping.targetAppId),
    repos.apiSpecs.getById(mapping.sourceSpecId),
    repos.apiSpecs.getById(mapping.targetSpecId),
  ]);
  const sourceBaseUrl = sourceApp?.baseUrl;
  const targetBaseUrl = targetApp?.baseUrl;
  if (
    sourceApp === undefined ||
    targetApp === undefined ||
    sourceBaseUrl === undefined ||
    targetBaseUrl === undefined
  ) {
    // A sync side is a PROVIDER with a reachable base URL; absent → cannot poll/write.
    return undefined;
  }
  if (sourceSpec === undefined || targetSpec === undefined) {
    return undefined;
  }
  const sourceGroup = findGroup(sourceSpec, source.resourceRef);
  const targetGroup = findGroup(targetSpec, target.resourceRef);
  if (sourceGroup === undefined || targetGroup === undefined) {
    return undefined;
  }

  const [fieldMappings, operationMappings, sourceBindings, targetBindings] = await Promise.all([
    repos.mappingArtifacts.listFieldMappings(mapping.id),
    repos.mappingArtifacts.listOperationMappings(mapping.id),
    repos.resourceBindings.listByApiSpecId(mapping.sourceSpecId),
    repos.resourceBindings.listByApiSpecId(mapping.targetSpecId),
  ]);
  const sourceBinding = findBinding(sourceBindings, source.resourceRef);
  const targetBinding = findBinding(targetBindings, target.resourceRef);
  if (sourceBinding === undefined || targetBinding === undefined) {
    return undefined;
  }

  return {
    rule,
    mapping,
    // Scope the mapping's fields to THIS rule's resource pair — a multi-pair mapping
    // must not feed a foreign pair's fields into this rule's transform/identity path.
    fieldMappings: fieldMappingsForResourcePair(
      fieldMappings,
      source.resourceRef,
      target.resourceRef,
    ),
    operationMappings,
    sourceApp,
    targetApp,
    sourceBaseUrl,
    targetBaseUrl,
    sourceSpec,
    targetSpec,
    sourceGroup,
    targetGroup,
    sourceBinding,
    targetBinding,
    sourceResourceRef: source.resourceRef,
    targetResourceRef: target.resourceRef,
    appAId: sides.a.appId,
    appBId: sides.b.appId,
  };
}
