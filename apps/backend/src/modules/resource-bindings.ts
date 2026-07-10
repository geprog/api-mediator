import type { ResourceBindingRefKind, UpdateResourceBindingRequest } from "@mediator/contracts";
import type { ResourceBindingRefPatch } from "@mediator/db";
import {
  assertNever,
  type AppCapabilities,
  type IrRefTarget,
  type IrResourceGroup,
  type ResourceBinding,
} from "@mediator/domain";

import { BadRequestError, NotFoundError } from "../app-errors.js";
import type { UnitOfWork } from "./persistence.js";

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
 * Confirm or correct a single `ResourceBinding` ref (RB-2). Per-ref: confirming
 * one ref never touches another (crit 3). Runs inside one transaction so the
 * read (binding → spec → app), validation, and write are atomic.
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

      // RB-2 crit 5: a not-meaningful ref is never confirmed into use.
      if (!refApplicable(request.refKind, app.capabilities)) {
        throw new BadRequestError(
          `Ref '${request.refKind}' is not applicable for this resource: the app's capabilities do not enable it.`,
          [
            {
              path: "refKind",
              message: "not applicable for this resource per the app capabilities",
            },
          ],
        );
      }

      const group = spec.parsedIR.find(
        (candidate) => candidate.resourceRef === binding.resourceRef,
      );

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
      const updated = await stores.resourceBindings.update(bindingId, patch);
      if (updated === undefined) {
        throw new NotFoundError(`ResourceBinding ${bindingId} not found.`);
      }
      return { binding: updated, capabilities: app.capabilities };
    });
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
