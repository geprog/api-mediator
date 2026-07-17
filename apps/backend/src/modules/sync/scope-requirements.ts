import type {
  ConfirmableRef,
  IrOperation,
  IrResourceGroup,
  ResourceBinding,
  ScopeRecordDerivedBinding,
} from "@mediator/domain";
import {
  findMappedTargetOperation,
  resolveSingleRecordReadBinding,
  resolveSourcePollOperation,
  scopeParamNamesOf,
  writeRecordIdPathParam,
} from "@mediator/outbound";
import type { EnablementSide, ScopeBindingRequirement } from "@mediator/sync-engine";

import { buildTargetLookup } from "./context-builders.js";
import { confirmedValue, findIdentityField, type RuleArtifacts } from "./resolution.js";

/**
 * **SS-5 / SS-9 scope-requirement classification** (`docs/requirements/
 * scoped-resource-sync.md` SS-5.1/5.2, SS-9.1; `docs/architecture/data-model.md`
 * `ResourceBinding.scopePathBindings` + `sourceScopeRef`) — the IR-dependent half of the
 * enablement gate, kept **out** of the pure gate so that stays pure over already-loaded
 * domain objects. It works out, for a rule's loaded {@link RuleArtifacts}, which scope
 * path parameters the operations the rule **actually calls** require — the precomputed
 * {@link ScopeBindingRequirement} list the gate then checks against each side's bindings.
 *
 * ## `constant` vs `record-derived` per parameter (SS-9)
 *
 * The record-id-vs-scope classification is unchanged; what a required scope parameter
 * *needs* depends on its confirmed fill-source **kind** on the attributed side's
 * `ResourceBinding.scopePathBindings`. A parameter with a `record-derived` entry (SS-8)
 * emits a `record-derived` {@link ScopeBindingRequirement} carrying the entry's
 * `sourceScopeKey` and the **source** resource's ref — so the gate checks the source
 * `sourceScopeRef` component + the target binding are both confirmed (SS-9.1), attributed
 * to the right sides (source `sourceScopeRef` on the source binding; the `record-derived`
 * scope binding on the target binding). A parameter that is (still) `constant`-kind —
 * including a derived-unconfirmed default — keeps its existing SS-5 `constant` requirement.
 * A `record-derived` binding only matters for the operations that actually carry that
 * scope param, exactly as `constant` does.
 *
 * ## The operations a rule actually calls (SS-5.1/5.2) and their record-id parameter
 *
 * The **required scope params of an operation = its path params MINUS its record-id
 * param**, attributed to that operation's side. The record-id determination is the
 * **same one the SS-4 resolver uses** — this module reuses the resolver's own helpers
 * ({@link resolveSourcePollOperation}, {@link findMappedTargetOperation},
 * {@link writeRecordIdPathParam}, {@link resolveSingleRecordReadBinding}) and the shared
 * {@link scopeParamNamesOf} subtract primitive — so the gate's required set matches what
 * the resolver fills exactly (never a param the resolver never fills → unenablable; never
 * one the resolver leaves as `{…}` → runtime `{owner}` failure):
 *
 *  - **source poll operation** (`pollOperationRef`) — a collection/delta read, no
 *    record-id path parameter → every path param is scope.
 *  - **source backfill collection read** (`collectionReadRef`) — enumerated; included
 *    under the same condition BE-2.2 requires the ref (full-fetch always, a delta rule
 *    only when backfill runs). No record-id param → every path param is scope.
 *  - **target identity-lookup collection read** — whenever the identity-lookup path
 *    ISSUES a target collection read, i.e. for BOTH `fetch-and-match` AND `filtered-read`
 *    (a filtered read runs `GET <collectionRead>?<lookupParam>=…`). Both resolve that
 *    same collection read through `resolveSourceReadBinding` and fill its scope from the
 *    **target** binding (`target-identity-lookup.ts`), so an asymmetrically-scoped target
 *    (SS-2.4 — scoped collection read but id-only writes) would otherwise enable and then
 *    throw on every lookup. No record-id param → every path param is scope. (`none`/
 *    manual-only issues no target collection read → no requirement.)
 *  - **target create / update / delete** for what the rule propagates — record-id param
 *    is `OperationMapping.targetIdParamRef`-if-path on update/delete, **absent** on a
 *    create (so all its path params are scope, e.g. Vikunja `PUT /projects/{id}/tasks`).
 *  - **target single-record read** — only when the rule needs it (a PUT-shaped update's
 *    read-carry, CF-5; or `targetDriftCheck = read-before-write`, CF-6). Record-id param
 *    is the by-id read's own id parameter (when in the path).
 *
 * SS-5.3 falls out naturally: an operation whose only path parameter is the record id has
 * an empty path-params-minus-id set, so it contributes no requirement.
 *
 * The result is deduplicated — a scope parameter recurs under the same name across a
 * resource's operations (`docs/architecture/data-model.md` `ResourceBinding`), so the
 * same `(side, resourceRef, parameterName)` requirement is emitted once.
 */
export function computeRequiredScopeBindings(
  artifacts: RuleArtifacts,
  options: { readonly backfillSkipped: boolean },
): readonly ScopeBindingRequirement[] {
  const collector = new ScopeRequirementCollector(artifacts);
  const sourceRef = artifacts.sourceResourceRef;
  const targetRef = artifacts.targetResourceRef;

  const deltaPolling =
    artifacts.sourceApp.capabilities.supportsDeltaQuery &&
    artifacts.sourceBinding.deltaCursorRef !== undefined;

  // ── Source: the poll operation (steady-state read) — every path param is scope ──
  const pollOperation = resolveSourcePollOperation({
    rule: artifacts.rule,
    sourceGroup: artifacts.sourceGroup,
    sourceBinding: artifacts.sourceBinding,
    sourceCapabilities: artifacts.sourceApp.capabilities,
  });
  if (pollOperation !== undefined) {
    collector.addAll("source", sourceRef, scopeParamNamesOf(pollOperation, undefined));
  }

  // ── Source: the backfill collection read (enumeration) ─────────────────────────
  // Mirrors BE-2.2's `collectionReadRef` demand: a full-fetch rule always enumerates via
  // the collection read; a delta rule enumerates it only when the backfill actually runs.
  if (!deltaPolling || !options.backfillSkipped) {
    const collectionReadOperation = confirmedOperation(
      artifacts.sourceBinding.collectionReadRef,
      artifacts.sourceGroup,
    );
    if (collectionReadOperation !== undefined) {
      collector.addAll("source", sourceRef, scopeParamNamesOf(collectionReadOperation, undefined));
    }
  }

  // ── Target: the identity-lookup collection read (fetch-and-match OR filtered-read) ─
  // Both lookup paths ISSUE the target collection read (filtered-read as
  // `GET <collectionRead>?<lookupParam>=…`), resolved through the SAME
  // `resolveSourceReadBinding` that fills its scope from the target binding — so either
  // requires the collection read's scope params. A `none`/manual-only path issues none.
  const identityField = findIdentityField(artifacts.fieldMappings);
  if (identityField !== undefined) {
    const lookup = buildTargetLookup(artifacts, identityField);
    if (lookup.kind === "fetch-and-match" || lookup.kind === "filtered-read") {
      const lookupReadOperation = findOperationById(
        artifacts.targetGroup,
        lookup.binding.collectionReadOperationId,
      );
      if (lookupReadOperation !== undefined) {
        collector.addAll("target", targetRef, scopeParamNamesOf(lookupReadOperation, undefined));
      }
    }
  }

  // ── Target: the create/update/delete ops for what the rule propagates ─────────
  const deletePropagation = artifacts.rule.deletePropagation ?? "ignore";
  let firstUpdateMethod: IrOperation["method"] | undefined;
  for (const operationMapping of artifacts.operationMappings) {
    const action = operationMapping.action;
    const propagated =
      action === "create" ||
      action === "update" ||
      (action === "delete" && deletePropagation === "propagate");
    if (!propagated) {
      continue;
    }
    const operation = findMappedTargetOperation(operationMapping, artifacts.targetGroup);
    if (operation === undefined) {
      continue;
    }
    if (action === "update" && firstUpdateMethod === undefined) {
      // The pipeline's write shape comes from the FIRST resolving update op (CF-5).
      firstUpdateMethod = operation.method;
    }
    const recordIdParam = writeRecordIdPathParam(operationMapping, operation);
    collector.addAll("target", targetRef, scopeParamNamesOf(operation, recordIdParam));
  }

  // ── Target: the single-record read (only when the rule needs it) ──────────────
  // A PUT-shaped update read-carries the target's current record (CF-5); a
  // `read-before-write` drift check reads it up front (CF-6). Either way its scope path
  // parameters (all but the by-id read's own id) must be confirmed. The PUT arm is an
  // intentional CONSERVATIVE SUPERSET: it fires whenever the first resolving update op is
  // PUT, even if a run never actually withholds a field (so never read-carries) — this
  // can only over-require a scope the resolver would fill anyway, never fabricate a URL.
  const needsSingleRecordRead =
    (artifacts.rule.targetDriftCheck ?? "none") === "read-before-write" ||
    firstUpdateMethod === "put";
  if (needsSingleRecordRead) {
    const readBinding = resolveSingleRecordReadBinding(
      artifacts.targetGroup,
      artifacts.targetBinding,
    );
    if (readBinding !== undefined) {
      const readOperation = findOperationById(artifacts.targetGroup, readBinding.readOperationId);
      if (readOperation !== undefined) {
        const recordIdParam = singleRecordReadIdParam(readOperation, readBinding.idParamRef);
        collector.addAll("target", targetRef, scopeParamNamesOf(readOperation, recordIdParam));
      }
    }
  }

  return collector.list();
}

/** The IR operation a confirmed `operation`-kind ref names, or `undefined` (absent/unconfirmed). */
function confirmedOperation(
  ref: ConfirmableRef | undefined,
  group: IrResourceGroup,
): IrOperation | undefined {
  const value = confirmedValue(ref);
  return value?.kind === "operation" ? findOperationById(group, value.operationId) : undefined;
}

function findOperationById(group: IrResourceGroup, operationId: string): IrOperation | undefined {
  return group.operations.find((operation) => operation.operationId === operationId);
}

/**
 * The single-record read's **record-id** path parameter — the by-id read's own id — or
 * `undefined` when that id parameter is not in the path (a query/header id leaves every
 * path param as scope). Mirrors {@link resolveSingleRecordRead}'s
 * `idLocation.in === "path"` gate so the gate's scope set matches the read the resolver
 * fills.
 */
function singleRecordReadIdParam(operation: IrOperation, idParamRef: string): string | undefined {
  const parameter = operation.parameters.find((param) => param.name === idParamRef);
  return parameter?.location === "path" ? idParamRef : undefined;
}

/** The confirmed-or-not `record-derived` entry for `parameterName` on a binding, or `undefined`. */
function findRecordDerivedScopeEntry(
  binding: ResourceBinding,
  parameterName: string,
): ScopeRecordDerivedBinding | undefined {
  return (binding.scopePathBindings ?? []).find(
    (entry): entry is ScopeRecordDerivedBinding =>
      entry.kind === "record-derived" && entry.parameterName === parameterName,
  );
}

/**
 * Deduplicates scope requirements by `(side, resourceRef, parameterName)`, preserving
 * order. For each collected parameter it resolves the requirement **kind** from the
 * attributed side's `ResourceBinding.scopePathBindings` (SS-9): a `record-derived` entry
 * yields a `record-derived` requirement carrying the entry's `sourceScopeKey` + the polled
 * source resource's ref (so the gate can check the source `sourceScopeRef`); anything else
 * — including a derived-unconfirmed default `constant` — yields the SS-5 `constant`
 * requirement unchanged.
 */
class ScopeRequirementCollector {
  readonly #byKey = new Map<string, ScopeBindingRequirement>();
  readonly #sourceBinding: ResourceBinding;
  readonly #targetBinding: ResourceBinding;
  readonly #sourceResourceRef: string;

  public constructor(artifacts: RuleArtifacts) {
    this.#sourceBinding = artifacts.sourceBinding;
    this.#targetBinding = artifacts.targetBinding;
    this.#sourceResourceRef = artifacts.sourceResourceRef;
  }

  public addAll(
    side: EnablementSide,
    resourceRef: string,
    parameterNames: readonly string[],
  ): void {
    const binding = side === "source" ? this.#sourceBinding : this.#targetBinding;
    for (const parameterName of parameterNames) {
      const key = JSON.stringify([side, resourceRef, parameterName]);
      if (this.#byKey.has(key)) {
        continue;
      }
      const recordDerived = findRecordDerivedScopeEntry(binding, parameterName);
      this.#byKey.set(
        key,
        recordDerived !== undefined
          ? {
              kind: "record-derived",
              parameterName,
              side,
              resourceRef,
              sourceResourceRef: this.#sourceResourceRef,
              sourceScopeKey: recordDerived.sourceScopeKey,
            }
          : { kind: "constant", parameterName, side, resourceRef },
      );
    }
  }

  public list(): readonly ScopeBindingRequirement[] {
    return [...this.#byKey.values()];
  }
}
