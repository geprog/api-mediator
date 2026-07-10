import type { ResourceBindingRefDto, ResourceBindingRefKind } from "@mediator/contracts";
import { assertNever, type IrRefTarget, type IrResourceGroup } from "@mediator/domain";

/**
 * Pure model for the `ResourceBinding` confirmation panel (RB-3): the three
 * visual states a ref can be in, and the IR-derived candidate targets the
 * correction picker offers. No Vue/DOM dependency, so it is unit-testable.
 */

/**
 * A ref's display state (RB-3 criteria 1/4/5):
 * - `not-applicable` — not meaningful for the resource per the app's capabilities;
 * - `unconfirmed` — an applicable, human-unratified heuristic guess (the signal a
 *   Phase-4 rule-enablement UI will consume);
 * - `confirmed` — an applicable ref the operator has ratified.
 */
export type RefState = "confirmed" | "unconfirmed" | "not-applicable";

export function refState(ref: ResourceBindingRefDto): RefState {
  if (!ref.applicable) {
    return "not-applicable";
  }
  return ref.confirmedAt !== null ? "confirmed" : "unconfirmed";
}

/**
 * Whether a plain confirm (PATCH with no `value`) is valid for this ref. The
 * backend rejects confirming a ref with no derived value, so a null-value ref can
 * only be ratified by a correction (RB-2).
 */
export function canConfirm(ref: ResourceBindingRefDto): boolean {
  return ref.applicable && ref.value !== null;
}

/** Human labels for the six ref kinds. */
export const REF_KIND_LABELS: Record<ResourceBindingRefKind, string> = {
  nativeIdRef: "Native id",
  collectionReadRef: "Collection read",
  paginationRef: "Pagination",
  deltaCursorRef: "Delta cursor",
  deltaDeletionRef: "Delta deletion",
  changeTimestampRef: "Change timestamp",
};

/** A one-line human description of an IR ref target, for display. */
export function describeTarget(target: IrRefTarget | null): string {
  if (target === null) {
    return "— no guess —";
  }
  switch (target.kind) {
    case "field":
      return `field: ${target.path}`;
    case "operation":
      return `operation: ${target.operationId}`;
    case "parameter":
      return `parameter: ${target.parameter} (${target.operationId})`;
    default:
      return assertNever(target);
  }
}

/** The IR element kinds a correction can name. */
export type TargetKind = IrRefTarget["kind"];
export const TARGET_KINDS: readonly TargetKind[] = ["field", "operation", "parameter"];

/** The natural target kind to default the correction picker to, per ref kind. */
export function defaultTargetKind(kind: ResourceBindingRefKind): TargetKind {
  switch (kind) {
    case "nativeIdRef":
    case "changeTimestampRef":
      return "field";
    case "collectionReadRef":
      return "operation";
    case "paginationRef":
    case "deltaCursorRef":
    case "deltaDeletionRef":
      return "parameter";
    default:
      return assertNever(kind);
  }
}

/** One selectable correction target: a stable string key, a label, and the target. */
export interface RefTargetOption {
  readonly key: string;
  readonly label: string;
  readonly target: IrRefTarget;
}

/** Correction-target candidates grouped by IR element kind. */
export interface RefTargetOptions {
  field: RefTargetOption[];
  operation: RefTargetOption[];
  parameter: RefTargetOption[];
}

/** A stable key for a target, used as a native `<option>` value. */
export function targetKey(target: IrRefTarget): string {
  switch (target.kind) {
    case "field":
      return `field:${target.path}`;
    case "operation":
      return `operation:${target.operationId}`;
    case "parameter":
      return `parameter:${target.operationId}:${target.parameter}`;
    default:
      return assertNever(target);
  }
}

/** Every field name reachable in a resource group (schemas + operation bodies) — mirrors the backend. */
function collectFieldPaths(group: IrResourceGroup): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const add = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      paths.push(name);
    }
  };
  for (const schema of group.schemas) {
    for (const field of schema.fields) add(field.name);
  }
  for (const operation of group.operations) {
    for (const field of operation.requestSchema?.fields ?? []) add(field.name);
    for (const field of operation.responseSchema?.fields ?? []) add(field.name);
  }
  return paths;
}

/**
 * The correction-target candidates for a resource group, grouped by IR element
 * kind (RB-3 criterion 3 / RB-2 criterion 4): fields, operations, and operation
 * parameters. All are validated server-side on PATCH, so an over-broad list is
 * safe — the picker simply surfaces what the resource's IR contains.
 */
export function buildRefTargetOptions(group: IrResourceGroup | undefined): RefTargetOptions {
  const options: RefTargetOptions = {
    field: [],
    operation: [],
    parameter: [],
  };
  if (group === undefined) {
    return options;
  }

  for (const path of collectFieldPaths(group)) {
    const target: IrRefTarget = { kind: "field", path };
    options.field.push({ key: targetKey(target), label: describeTarget(target), target });
  }

  const seenOperations = new Set<string>();
  for (const operation of group.operations) {
    if (!seenOperations.has(operation.operationId)) {
      seenOperations.add(operation.operationId);
      const target: IrRefTarget = { kind: "operation", operationId: operation.operationId };
      options.operation.push({ key: targetKey(target), label: describeTarget(target), target });
    }
    for (const parameter of operation.parameters) {
      const target: IrRefTarget = {
        kind: "parameter",
        operationId: operation.operationId,
        parameter: parameter.name,
      };
      const key = targetKey(target);
      if (!options.parameter.some((option) => option.key === key)) {
        options.parameter.push({ key, label: describeTarget(target), target });
      }
    }
  }

  return options;
}
