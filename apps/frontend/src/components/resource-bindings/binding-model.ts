import type {
  ResourceBindingRefDto,
  ResourceBindingRefKind,
  ResourceBindingScopeDto,
} from "@mediator/contracts";
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

/**
 * A scope path-parameter binding's display state (SS-6.2). A `constant` scope
 * entry has only two states — a scope binding is never `not-applicable` (it exists
 * only because the resource's IR carries that non-record-id path parameter, SS-2):
 * - `unconfirmed` — a derived, human-unratified entry (the SS-5 gate blocker);
 * - `confirmed` — the operator supplied a literal and ratified it.
 */
export type ScopeBindingState = "confirmed" | "unconfirmed";

export function scopeBindingState(scope: ResourceBindingScopeDto): ScopeBindingState {
  return scope.confirmedAt !== null ? "confirmed" : "unconfirmed";
}

/**
 * Whether a scope constant may be supplied + confirmed (SS-6.2). Unlike a ref
 * (which ratifies a derived IR pointer), a scope constant is a literal the operator
 * **types in**, so the guard is on the *typed value*, not on a derived guess: the
 * server rejects confirming an empty value (SS-3.3), so the affordance is disabled
 * until a non-blank value is entered. The value is sent as entered (SS-6.5); this
 * only decides whether the confirm action is offered.
 */
export function canSupplyScope(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * A scope binding's fill-source kind (SS-9.2), mirroring the domain/DTO discriminant:
 * `constant` (an operator literal), `record-derived` (filled per record from the source
 * resource's captured scope), or `scope-link` (Layer 3 — resolved through a `ScopeLink`).
 */
export type ScopeBindingKind = "constant" | "record-derived" | "scope-link";

/**
 * The kinds an operator can actually confirm a scope binding **into** in Layer 2 —
 * `scope-link` is a Layer-3 fill source and is offered only as a disabled option
 * ({@link SCOPE_KIND_OPTIONS}).
 */
export type SelectableScopeBindingKind = "constant" | "record-derived";

/** One kind-selector option (SS-9.2): the kind, a glossary-exact label, and whether it is selectable. */
export interface ScopeKindOption {
  readonly kind: ScopeBindingKind;
  readonly label: string;
  /** `scope-link` is disabled — a Layer-3 fill source not built yet (SS-9.2). */
  readonly disabled: boolean;
}

/**
 * The three fill-source kinds the SS-9.2 kind selector presents. `constant` and
 * `record-derived` are selectable now; `scope-link` is shown **disabled** and labeled
 * as Layer-3/not-yet-available so the operator sees the full choice without being able
 * to pick an unbuilt kind. Labels keep the glossary term verbatim.
 */
export const SCOPE_KIND_OPTIONS: readonly ScopeKindOption[] = [
  { kind: "constant", label: "constant", disabled: false },
  { kind: "record-derived", label: "record-derived", disabled: false },
  { kind: "scope-link", label: "scope-link (Layer 3 — not yet available)", disabled: true },
];

/**
 * Whether a `record-derived` scope binding may be supplied + confirmed (SS-9.2): a
 * non-blank `sourceScopeKey` must be selected/entered. The server 400s an empty key
 * (SS-8), so the confirm affordance stays disabled until one is chosen — mirroring
 * {@link canSupplyScope} for the constant value. This only decides whether the confirm
 * action is offered; the per-rule check that the key names a real source component is
 * the SS-9 enablement gate's job, not the client's.
 */
export function canSupplyScopeKey(sourceScopeKey: string): boolean {
  return sourceScopeKey.trim().length > 0;
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
