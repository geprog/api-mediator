import type {
  ResourceBindingRefKind,
  UpdateResourceBindingRefRequest,
  UpdateResourceBindingRequest,
  UpdateScopeBindingRequest,
  UpdateSourceScopeRefRequest,
} from "@mediator/contracts";
import type { ResourceBindingRefPatch } from "@mediator/db";
import {
  assertNever,
  type ApiSpec,
  type AppCapabilities,
  type IrField,
  type IrRefTarget,
  type IrResourceGroup,
  type ResourceBinding,
} from "@mediator/domain";

import { BadRequestError, NotFoundError } from "../app-errors.js";
import type { TxStores, UnitOfWork } from "./persistence.js";

/**
 * Whether a `ResourceBinding` ref is **meaningful** for its resource given the
 * owning app's `capabilities` (RB-1 derivation gating / RB-2 crit 5 / RB-3 crit
 * 5). The single source of truth for both the DTO's `applicable` flag and the
 * "a not-meaningful ref is never confirmed into use" rejection:
 *
 * - `changeTimestampRef` — only when the app declares `supportsChangeTimestamps`.
 * - `deltaCursorRef` / `deltaDeletionRef` — only when it declares `supportsDeltaQuery`.
 * - `nativeIdRef` / `collectionReadRef` / `paginationRef` — always meaningful.
 */
export function refApplicable(
  refKind: ResourceBindingRefKind,
  capabilities: AppCapabilities,
): boolean {
  switch (refKind) {
    case "changeTimestampRef":
      return capabilities.supportsChangeTimestamps;
    case "deltaCursorRef":
    case "deltaDeletionRef":
      return capabilities.supportsDeltaQuery;
    case "nativeIdRef":
    case "collectionReadRef":
    case "paginationRef":
      return true;
    default:
      return assertNever(refKind);
  }
}

/** The outcome of a confirm/correct, carrying the capabilities the DTO needs. */
export interface ConfirmResult {
  readonly binding: ResourceBinding;
  readonly capabilities: AppCapabilities;
}

/** Confirms/corrects one `ResourceBinding` ref (RB-2). */
export interface BindingConfirmer {
  confirmOrCorrect(
    bindingId: string,
    request: UpdateResourceBindingRequest,
    operatorIdentity: string,
  ): Promise<ConfirmResult>;
}

export interface ResourceBindingServiceDeps {
  readonly unitOfWork: UnitOfWork;
}

/**
 * Confirm or correct a single `ResourceBinding` binding. The PATCH request is a
 * discriminated union of three per-target patch shapes, each confirmed **in
 * isolation** — confirming one never touches another:
 *
 * - an **operational-ref** patch (`refKind`) — one of the six refs (RB-2, crit 3);
 * - a **scope-binding** patch (`parameterName`) — one scope path-parameter
 *   `constant` (SS-3, crit 2);
 * - a **`sourceScopeRef`** patch (`components`) — the whole record-scope-capture
 *   ref, confirmed as one (SS-7, crit 2).
 *
 * Runs inside one transaction so the read (binding → spec → app), validation, and
 * write are atomic. `app.capabilities` is loaded for every shape: the ref path
 * needs it for the applicability check, and all return it in {@link ConfirmResult}
 * for the DTO.
 */
export class ResourceBindingService implements BindingConfirmer {
  readonly #unitOfWork: UnitOfWork;

  public constructor(deps: ResourceBindingServiceDeps) {
    this.#unitOfWork = deps.unitOfWork;
  }

  public confirmOrCorrect(
    bindingId: string,
    request: UpdateResourceBindingRequest,
    operatorIdentity: string,
  ): Promise<ConfirmResult> {
    return this.#unitOfWork.run(async (stores) => {
      const binding = await stores.resourceBindings.getById(bindingId);
      if (binding === undefined) {
        throw new NotFoundError(`ResourceBinding ${bindingId} not found.`);
      }
      const spec = await stores.apiSpecs.getById(binding.apiSpecId);
      if (spec === undefined) {
        throw new NotFoundError(`ApiSpec ${binding.apiSpecId} not found.`);
      }
      const app = await stores.registeredApps.getById(spec.appId);
      if (app === undefined) {
        throw new NotFoundError(`RegisteredApp ${spec.appId} not found.`);
      }

      // The three patch shapes are mutually exclusive by construction:
      // `parameterName` addresses a scope binding (SS-3), `components` the whole
      // `sourceScopeRef` (SS-7), and `refKind` an operational ref (RB-2).
      const updated =
        "parameterName" in request
          ? await this.#confirmScopeBinding(stores, binding, request, operatorIdentity)
          : "components" in request
            ? await this.#confirmSourceScopeRef(stores, binding, spec, request, operatorIdentity)
            : await this.#confirmRef(
                stores,
                binding,
                spec,
                app.capabilities,
                request,
                operatorIdentity,
              );

      return { binding: updated, capabilities: app.capabilities };
    });
  }

  /** Confirm/correct one operational ref (RB-2). */
  async #confirmRef(
    stores: TxStores,
    binding: ResourceBinding,
    spec: ApiSpec,
    capabilities: AppCapabilities,
    request: UpdateResourceBindingRefRequest,
    operatorIdentity: string,
  ): Promise<ResourceBinding> {
    // RB-2 crit 5: a not-meaningful ref is never confirmed into use.
    if (!refApplicable(request.refKind, capabilities)) {
      throw new BadRequestError(
        `Ref '${request.refKind}' is not applicable for this resource: the app's capabilities do not enable it.`,
        [{ path: "refKind", message: "not applicable for this resource per the app capabilities" }],
      );
    }

    const group = spec.parsedIR.find((candidate) => candidate.resourceRef === binding.resourceRef);

    if (request.value !== undefined) {
      // RB-2 crit 4: a correction must name an element present in the IR.
      if (group === undefined || !targetExistsInGroup(group, request.value)) {
        throw new BadRequestError("The correction target is not present in this resource's IR.", [
          { path: "value", message: "field/parameter/operation not found in the resource IR" },
        ]);
      }
    } else if (binding[request.refKind] === undefined) {
      // Nothing to confirm: no derived value and no correction supplied.
      throw new BadRequestError(
        `Ref '${request.refKind}' has no derived value to confirm; supply a correction value.`,
        [{ path: "refKind", message: "no derived value to confirm" }],
      );
    }

    const patch: ResourceBindingRefPatch = {
      [request.refKind]: {
        ...(request.value !== undefined ? { value: request.value } : {}),
        confirmedBy: operatorIdentity,
        confirmedAt: new Date(),
      },
    };
    const updated = await stores.resourceBindings.update(binding.id, patch);
    if (updated === undefined) {
      throw new NotFoundError(`ResourceBinding ${binding.id} not found.`);
    }
    return updated;
  }

  /**
   * Supply + confirm one scope path-parameter `constant` (SS-3). Sets `value` and
   * stamps `confirmedBy`/`confirmedAt` in one action (crit 1). Validations:
   *
   * - **crit 3** — an empty/absent `value` is rejected: a scope binding cannot be
   *   confirmed into use without a value.
   * - **crit 4** — `parameterName` must be an existing derived scope entry of the
   *   resource (`ResourceBinding.scopePathBindings`, the IR-derived scope set of
   *   SS-2); the supplied `value` itself is a **free literal**, never IR-validated
   *   (contrast an operational ref's IR-pointer value).
   *
   * The repository rewrites only that one entry of the `jsonb` collection, so the
   * confirmation is per parameter (crit 2) and no operational ref is touched.
   */
  async #confirmScopeBinding(
    stores: TxStores,
    binding: ResourceBinding,
    request: UpdateScopeBindingRequest,
    operatorIdentity: string,
  ): Promise<ResourceBinding> {
    // SS-3 crit 3: an empty/absent value cannot be confirmed into use.
    const value = request.value;
    if (value === undefined || value.length === 0) {
      throw new BadRequestError(
        `Scope parameter '${request.parameterName}' cannot be confirmed without a value.`,
        [{ path: "value", message: "a scope constant requires a non-empty value" }],
      );
    }

    // SS-3 crit 4: the parameter must be a derived scope entry of the resource;
    // the value is a free literal (never IR-validated).
    const entry = (binding.scopePathBindings ?? []).find(
      (candidate) => candidate.parameterName === request.parameterName,
    );
    if (entry === undefined) {
      throw new BadRequestError(
        `'${request.parameterName}' is not a scope path parameter of this resource.`,
        [{ path: "parameterName", message: "not a derived scope parameter of the resource" }],
      );
    }

    const updated = await stores.resourceBindings.updateScopePathBinding(binding.id, {
      parameterName: request.parameterName,
      value,
      confirmedBy: operatorIdentity,
      confirmedAt: new Date(),
    });
    if (updated === undefined) {
      throw new NotFoundError(`ResourceBinding ${binding.id} not found.`);
    }
    return updated;
  }

  /**
   * Confirm/correct the whole `sourceScopeRef` (SS-7). The operator supplies the
   * full component set (add / remove / rename components, set each `fieldPath`) and
   * it is stamped `confirmedBy`/`confirmedAt` in one action (crit 2). Validations:
   *
   * - **crit 3 (absent, not confirmed-empty)** — an empty component set is
   *   rejected: an absent `sourceScopeRef` is modeled by the ref not existing, so a
   *   *confirmed* one must name at least one component.
   * - **crit 2 (real field path)** — each component's `fieldPath` must resolve
   *   against the resource's **response** schema ({@link responseFieldPathExists}),
   *   as RB-2 validates a ref target; an absent path is rejected. Duplicate
   *   component keys are rejected (they key the captured-scope map).
   *
   * The repository replaces the whole `source_scope_ref` column, so the operational
   * refs and the scope-path bindings are untouched.
   */
  async #confirmSourceScopeRef(
    stores: TxStores,
    binding: ResourceBinding,
    spec: ApiSpec,
    request: UpdateSourceScopeRefRequest,
    operatorIdentity: string,
  ): Promise<ResourceBinding> {
    // SS-7 crit 3: an empty set is an absent ref, not a confirmable one.
    if (request.components.length === 0) {
      throw new BadRequestError("A sourceScopeRef must name at least one scope component.", [
        { path: "components", message: "supply at least one { key, fieldPath } component" },
      ]);
    }

    // Component keys are the captured-scope map keys — they must be unique.
    const keys = new Set<string>();
    for (const component of request.components) {
      if (keys.has(component.key)) {
        throw new BadRequestError(`Duplicate scope component key '${component.key}'.`, [
          { path: "components", message: `duplicate component key '${component.key}'` },
        ]);
      }
      keys.add(component.key);
    }

    // SS-7 crit 2: every fieldPath must be a real path into the response schema.
    const group = spec.parsedIR.find((candidate) => candidate.resourceRef === binding.resourceRef);
    for (const component of request.components) {
      if (group === undefined || !responseFieldPathExists(group, component.fieldPath)) {
        throw new BadRequestError(
          `Scope component fieldPath '${component.fieldPath}' is not a field path of this resource's response schema.`,
          [{ path: "components", message: "fieldPath not found in the resource response schema" }],
        );
      }
    }

    const updated = await stores.resourceBindings.updateSourceScopeRef(binding.id, {
      components: request.components.map((component) => ({
        key: component.key,
        fieldPath: component.fieldPath,
      })),
      confirmedBy: operatorIdentity,
      confirmedAt: new Date(),
    });
    if (updated === undefined) {
      throw new NotFoundError(`ResourceBinding ${binding.id} not found.`);
    }
    return updated;
  }
}

/**
 * Whether `target` names a field/parameter/operation that exists in `group`'s IR
 * (RB-2 crit 4). A `field` target's `path` is checked against the union of the
 * group's schema fields and its operations' request/response schema fields; an
 * `operation`/`parameter` target is checked against the group's operations.
 */
function targetExistsInGroup(group: IrResourceGroup, target: IrRefTarget): boolean {
  switch (target.kind) {
    case "operation":
      return group.operations.some((operation) => operation.operationId === target.operationId);
    case "parameter":
      return group.operations.some(
        (operation) =>
          operation.operationId === target.operationId &&
          operation.parameters.some((parameter) => parameter.name === target.parameter),
      );
    case "field":
      return collectGroupFieldNames(group).has(target.path);
    default:
      return assertNever(target);
  }
}

/** Every field name reachable in a resource group (schemas + operation bodies). */
function collectGroupFieldNames(group: IrResourceGroup): Set<string> {
  const names = new Set<string>();
  for (const schema of group.schemas) {
    for (const field of schema.fields) names.add(field.name);
  }
  for (const operation of group.operations) {
    for (const field of operation.requestSchema?.fields ?? []) names.add(field.name);
    for (const field of operation.responseSchema?.fields ?? []) names.add(field.name);
  }
  return names;
}

/**
 * Whether `fieldPath` is a real field path into the resource's **response** schema
 * (SS-7 crit 2) — a `sourceScopeRef` component's `fieldPath` reads a source record's
 * scope, so it must resolve against what the resource returns. A dotted path
 * (`repository.owner`) descends through the response representation's typed fields:
 * each non-leaf segment must name a field whose type resolves to a schema the group
 * knows, and the leaf must be a field of the schema reached. A flat path
 * (`project_id`) need only be a top-level response field. Field detail beyond a
 * cross-resource summary is unavailable (the IR flattens top-level only), so a path
 * that would need to descend *past* a summary-only schema resolves to false —
 * conservative, and operator-correctable.
 */
function responseFieldPathExists(group: IrResourceGroup, fieldPath: string): boolean {
  const segments = fieldPath.split(".").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;

  let currentFields: readonly IrField[] | undefined = responseRepresentationFields(group);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || currentFields === undefined) return false;
    const field = currentFields.find((candidate) => candidate.name === segment);
    if (field === undefined) return false;
    if (i === segments.length - 1) return true;
    // A non-leaf segment must descend into a named object schema.
    currentFields = groupSchemaFields(group, field.type);
  }
  return false;
}

/** The response representation's top-level fields (union across response schemas). */
function responseRepresentationFields(group: IrResourceGroup): IrField[] {
  const byName = new Map<string, IrField>();
  for (const operation of group.operations) {
    for (const field of operation.responseSchema?.fields ?? []) {
      if (!byName.has(field.name)) byName.set(field.name, field);
    }
  }
  // Fall back to the group's primary schemas when no operation declares a response
  // body (defensive — the scenario resources always carry a read response).
  if (byName.size === 0) {
    for (const schema of group.schemas) {
      for (const field of schema.fields) if (!byName.has(field.name)) byName.set(field.name, field);
    }
  }
  return [...byName.values()];
}

/**
 * The typed fields of a schema the group knows by name (a primary schema, which
 * carries field types), else `undefined` — a cross-resource **summary** carries no
 * types, so a path cannot descend through it (only its top-level names are known,
 * which suffices for a *leaf*, handled by {@link responseFieldPathExists}). A leaf
 * whose parent is a summary schema is validated against the summary's names.
 */
function groupSchemaFields(group: IrResourceGroup, type: string): IrField[] | undefined {
  if (type.endsWith("[]")) return undefined;
  const named = group.schemas.find((schema) => schema.name === type);
  if (named !== undefined) return named.fields;
  const summary = group.crossResourceRefs.find((ref) => ref.name === type);
  if (summary !== undefined) {
    // Summaries carry only names; synthesize name-only fields so a leaf resolves,
    // while a further descent (needing types) falls through to `undefined`.
    return summary.fields.map((name) => ({ name, type: "unknown", required: false }));
  }
  return undefined;
}
