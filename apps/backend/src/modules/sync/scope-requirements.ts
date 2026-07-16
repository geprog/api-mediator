import type { ConfirmableRef, IrOperation, IrResourceGroup } from "@mediator/domain";
import {
  findMappedTargetOperation,
  resolveSingleRecordReadBinding,
  resolveSourcePollOperation,
  scopeParamNamesOf,
  writeRecordIdPathParam,
} from "@mediator/outbound";
import type { ScopeBindingRequirement } from "@mediator/sync-engine";

import { buildTargetLookup } from "./context-builders.js";
import { confirmedValue, findIdentityField, type RuleArtifacts } from "./resolution.js";

/**
 * **SS-5 scope-requirement classification** (`docs/requirements/scoped-resource-sync.md`
 * SS-5.1/5.2; `docs/architecture/data-model.md` `ResourceBinding.scopePathBindings`) —
 * the IR-dependent half of the enablement gate, kept **out** of the pure gate so that
 * stays pure over already-loaded domain objects. It works out, for a rule's loaded
 * {@link RuleArtifacts}, which scope path parameters the operations the rule **actually
 * calls** require — the precomputed {@link ScopeBindingRequirement} list the gate then
 * checks against each side's confirmed `constant` bindings.
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
 *  - **target fetch-and-match collection read** — only when fetch-and-match is the
 *    identity-lookup path (a filtered read's own scope params recur under the same name
 *    on the target write op, so they are covered there). No record-id param.
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
  const collector = new ScopeRequirementCollector();
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

  // ── Target: the fetch-and-match collection read (when that is the lookup path) ─
  const identityField = findIdentityField(artifacts.fieldMappings);
  if (identityField !== undefined) {
    const lookup = buildTargetLookup(artifacts, identityField);
    if (lookup.kind === "fetch-and-match") {
      const matchOperation = findOperationById(
        artifacts.targetGroup,
        lookup.binding.collectionReadOperationId,
      );
      if (matchOperation !== undefined) {
        collector.addAll("target", targetRef, scopeParamNamesOf(matchOperation, undefined));
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
  // parameters (all but the by-id read's own id) must be confirmed.
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

/** Deduplicates scope requirements by `(side, resourceRef, parameterName)`, preserving order. */
class ScopeRequirementCollector {
  readonly #byKey = new Map<string, ScopeBindingRequirement>();

  public addAll(
    side: ScopeBindingRequirement["side"],
    resourceRef: string,
    parameterNames: readonly string[],
  ): void {
    for (const parameterName of parameterNames) {
      const key = JSON.stringify([side, resourceRef, parameterName]);
      if (!this.#byKey.has(key)) {
        this.#byKey.set(key, { parameterName, side, resourceRef });
      }
    }
  }

  public list(): readonly ScopeBindingRequirement[] {
    return [...this.#byKey.values()];
  }
}
