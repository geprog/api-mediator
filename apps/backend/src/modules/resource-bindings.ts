import type {
  ResourceBindingRefKind,
  UpdateResourceBindingRefRequest,
  UpdateResourceBindingRequest,
  UpdateScopeBindingRequest,
  UpdateScopeConstantBindingRequest,
  UpdateScopeRecordDerivedBindingRequest,
  UpdateScopeScopeLinkBindingRequest,
  UpdateSourceScopeRefRequest,
} from "@mediator/contracts";
import type { ResourceBindingRefPatch, ScopePathBindingPatch } from "@mediator/db";
import {
  assertNever,
  isValuePreservingScopeTransform,
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
 * - `nativeIdRef` / `recordAddressRef` / `collectionReadRef` / `paginationRef` —
 *   always meaningful. `recordAddressRef` (SS-19) is not capability-gated: whether a
 *   resource addresses records container-relatively is a property of *that resource's*
 *   operations, not of the app's declared `capabilities`, so it is derived only where
 *   the IR shows evidence (RB-1) and is simply absent otherwise.
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
    case "recordAddressRef":
    case "collectionReadRef":
    case "paginationRef":
      return true;
    default:
      return assertNever(refKind);
  }
}

/** The outcome of a confirm/correct, carrying what the DTO needs beyond the binding. */
export interface ConfirmResult {
  readonly binding: ResourceBinding;
  readonly capabilities: AppCapabilities;
  /** The app owning the binding's spec — the SS-18.4 selector context is resolved per app. */
  readonly appId: string;
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
 * discriminated union of per-target patch shapes, each confirmed **in isolation** —
 * confirming one never touches another:
 *
 * - an **operational-ref** patch (`refKind`) — one of the six refs (RB-2, crit 3);
 * - a **scope-binding** patch (`parameterName`) — one scope path-parameter, itself
 *   discriminated on `kind`: a `constant` (SS-3, crit 2) or a `record-derived` (SS-8);
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

      // The patch shapes are mutually exclusive by construction: `parameterName`
      // addresses a scope binding (SS-3 constant / SS-8 record-derived, then told apart
      // by `kind`), `components` the whole `sourceScopeRef` (SS-7), and `refKind` an
      // operational ref (RB-2).
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

      return { binding: updated, capabilities: app.capabilities, appId: app.id };
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
   * Supply + confirm one scope path-parameter binding. A **discriminated confirm**, one
   * branch per fill source (SS-9.2's kind selector on the wire):
   *
   * - no `kind` key — the `constant` confirm via {@link #constantScopePatch} (SS-3),
   *   the unchanged Layer-1 shape;
   * - `kind: "record-derived"` — {@link #recordDerivedScopePatch} (SS-8);
   * - `kind: "scope-link"` — {@link #scopeLinkScopePatch} (SS-12 / SS-18.4), the Layer-3
   *   fill source this slice makes selectable.
   *
   * All three are **per parameter** — the repository rewrites only the one matching entry
   * of the `jsonb` collection, leaving every sibling scope entry, all operational refs,
   * and the `sourceScopeRef` untouched (SS-3.2).
   *
   * All three share the SS-3.4/SS-8 rule that `parameterName` must be an existing derived
   * scope entry of the resource (`ResourceBinding.scopePathBindings`, the IR-derived
   * scope set of SS-2), checked here before any kind-specific validation.
   */
  async #confirmScopeBinding(
    stores: TxStores,
    binding: ResourceBinding,
    request: UpdateScopeBindingRequest,
    operatorIdentity: string,
  ): Promise<ResourceBinding> {
    // SS-3.4 / SS-8: the parameter must be a derived scope entry of the resource.
    const entry = (binding.scopePathBindings ?? []).find(
      (candidate) => candidate.parameterName === request.parameterName,
    );
    if (entry === undefined) {
      throw new BadRequestError(
        `'${request.parameterName}' is not a scope path parameter of this resource.`,
        [{ path: "parameterName", message: "not a derived scope parameter of the resource" }],
      );
    }

    const patch = !("kind" in request)
      ? this.#constantScopePatch(request, operatorIdentity)
      : request.kind === "record-derived"
        ? this.#recordDerivedScopePatch(request, operatorIdentity)
        : this.#scopeLinkScopePatch(request, operatorIdentity);

    const updated = await stores.resourceBindings.updateScopePathBinding(binding.id, patch);
    if (updated === undefined) {
      throw new NotFoundError(`ResourceBinding ${binding.id} not found.`);
    }
    return updated;
  }

  /**
   * The `constant` scope confirm (SS-3): sets `value` and stamps
   * `confirmedBy`/`confirmedAt` in one action (crit 1). An empty/absent `value` is
   * rejected — a scope binding cannot be confirmed into use without a value (crit 3);
   * the supplied `value` is a **free literal**, never IR-validated (crit 4, contrast an
   * operational ref's IR-pointer value).
   */
  #constantScopePatch(
    request: UpdateScopeConstantBindingRequest,
    operatorIdentity: string,
  ): ScopePathBindingPatch {
    // SS-3 crit 3: an empty/absent value cannot be confirmed into use.
    const value = request.value;
    if (value === undefined || value.length === 0) {
      throw new BadRequestError(
        `Scope parameter '${request.parameterName}' cannot be confirmed without a value.`,
        [{ path: "value", message: "a scope constant requires a non-empty value" }],
      );
    }
    return {
      kind: "constant",
      parameterName: request.parameterName,
      value,
      confirmedBy: operatorIdentity,
      confirmedAt: new Date(),
    };
  }

  /**
   * The `record-derived` scope confirm (SS-8): sets the entry's `sourceScopeKey`
   * (+ optional value-preserving `transform`) and stamps `confirmedBy`/`confirmedAt`
   * in one action — the entry's `kind` flips from its SS-2-default `constant` to
   * `record-derived`, dropping the stale literal. Validations:
   *
   * - **crit 1** — an empty/absent `sourceScopeKey` is rejected (the confirmed⇒required
   *   invariant): a `record-derived` binding cannot be confirmed without naming which
   *   captured-scope component fills the parameter. It is **not** validated against the
   *   source resource's `sourceScopeRef` here — that is cross-resource + per-rule, which
   *   the SS-9 gate checks, not this per-binding confirm.
   * - **crit 3** — a present `transform` must be **value-preserving**
   *   ({@link isValuePreservingScopeTransform}, mirroring the identity-key rule exactly:
   *   `transform.kind === "rename"`); a value-altering one is rejected — the captured
   *   scope is a routing/identity key that must round-trip.
   *
   * Selecting `record-derived` **is** the operator's shared-value-space assertion
   * (crit 4), recorded by stamping the confirmation.
   */
  #recordDerivedScopePatch(
    request: UpdateScopeRecordDerivedBindingRequest,
    operatorIdentity: string,
  ): ScopePathBindingPatch {
    // SS-8 crit 1: a record-derived binding cannot be confirmed without a sourceScopeKey.
    const sourceScopeKey = request.sourceScopeKey;
    if (sourceScopeKey === undefined || sourceScopeKey.length === 0) {
      throw new BadRequestError(
        `Scope parameter '${request.parameterName}' cannot be confirmed record-derived without a sourceScopeKey.`,
        [{ path: "sourceScopeKey", message: "a record-derived binding requires a sourceScopeKey" }],
      );
    }

    // SS-8 crit 3: a present transform must be value-preserving (rename), exactly as an
    // identity key (AS-5) — a value-altering transform would break scope round-tripping.
    const transform = request.transform;
    if (transform !== undefined && !isValuePreservingScopeTransform(transform)) {
      throw new BadRequestError(
        `Scope parameter '${request.parameterName}' cannot use a value-altering transform: a captured scope must round-trip.`,
        [
          {
            path: "transform",
            message: "a record-derived transform must be value-preserving (rename)",
          },
        ],
      );
    }

    return {
      kind: "record-derived",
      parameterName: request.parameterName,
      sourceScopeKey,
      ...(transform !== undefined ? { transform } : {}),
      confirmedBy: operatorIdentity,
      confirmedAt: new Date(),
    };
  }

  /**
   * The **`scope-link`** scope confirm (SS-12 / SS-18.4, Layer 3): sets the entry's
   * `scopeKeyRef` — which component of the resolved `ScopeLink`'s target-side
   * `appXScopeKey` fills this parameter — flipping the entry's `kind` from its SS-2
   * default `constant` and dropping the stale literal, exactly as the `record-derived`
   * confirm does.
   *
   * **It is the one scope confirm that routinely writes a NULL confirmation pair.**
   * SS-18.4 has *selecting* `scope-link` write the binding **unconfirmed**, with a
   * separate operator action confirming it, so the request's `confirm` flag decides:
   * absent/`false` records the choice (`confirmedBy`/`confirmedAt` null — used nowhere:
   * `resolveScopeLinkScopeValues` skips unconfirmed entries and the SS-15 gate still
   * blocks the rule), `true` stamps the confirmation. Nothing here ever confirms
   * implicitly (SS-18.8).
   *
   * Validations:
   *
   * - **the confirmed⇒required invariant** — an empty/absent `scopeKeyRef` is rejected
   *   (mirroring `record-derived`'s empty-`sourceScopeKey` rejection): a `scope-link`
   *   binding without one names no container key and could never fill its parameter.
   *   It is **not** resolved against a live `ScopeLink` here — that is per-rule and
   *   per-record, which the SS-15 gate and the SS-12 resolver do, not this per-binding
   *   confirm.
   * - **no transform** — a `scope-link` binding carries none by construction (the
   *   value-space bridge is the `ScopeLink` itself, SS-12), and the `.strict()` request
   *   schema rejects one on the wire, so there is nothing to validate here.
   *
   * Whether `scope-link` is *offered* for this resource at all is the SS-18.4 selector's
   * question (a proposed `ScopeCorrespondence` must exist), surfaced to the client as
   * `ResourceBindingDto.scopeLinkAvailable`. It is deliberately **not** re-checked here:
   * the correspondence is per **resource pair** while a binding is per resource, so a
   * binding-scoped confirm is the wrong place to adjudicate it — the SS-15 gate, which
   * has the rule in hand, refuses to enable a rule whose correspondence is missing or
   * unconfirmed. A `scope-link` entry written without one is therefore inert, never unsafe.
   */
  #scopeLinkScopePatch(
    request: UpdateScopeScopeLinkBindingRequest,
    operatorIdentity: string,
  ): ScopePathBindingPatch {
    const scopeKeyRef = request.scopeKeyRef;
    if (scopeKeyRef === undefined || scopeKeyRef.length === 0) {
      throw new BadRequestError(
        `Scope parameter '${request.parameterName}' cannot be set scope-link without a scopeKeyRef.`,
        [{ path: "scopeKeyRef", message: "a scope-link binding requires a scopeKeyRef" }],
      );
    }
    // SS-18.4 — selecting the kind writes it UNCONFIRMED; only an explicit confirm stamps.
    const confirmed = request.confirm === true;
    return {
      kind: "scope-link",
      parameterName: request.parameterName,
      scopeKeyRef,
      confirmedBy: confirmed ? operatorIdentity : null,
      confirmedAt: confirmed ? new Date() : null,
    };
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

/**
 * The response representation's top-level fields (union across response schemas).
 * Exported so the SS-18 scope-identity-key derivation proposes a `targetFieldPath`
 * against the **same** field set {@link responseFieldPathExists} validates an
 * operator's correction against — one definition, two ends of the same pairing.
 */
export function responseRepresentationFields(group: IrResourceGroup): IrField[] {
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
