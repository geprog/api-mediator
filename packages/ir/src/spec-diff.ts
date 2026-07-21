import type {
  Ir,
  IrField,
  IrOperation,
  IrParameter,
  IrParameterLocation,
  IrResourceGroup,
  IrSchema,
} from "@mediator/domain";

/**
 * **SL-1 — the `SpecDiff` engine: additive/breaking classification between two IR
 * versions of the same `ApiSpec`.** The spec-level counterpart of
 * `scope-revalidation.ts` (SS-16): SS-16 re-checks the *operational artifacts* a
 * spec change touches, this classifies *every structural change* the change makes so
 * the Phase-6 lifecycle can pick a reaction (`docs/architecture/extensibility.md`
 * *Spec update lifecycle* step 2; `docs/glossary.md` `SpecDiff`).
 *
 * Pure and total — no I/O, no persistence, no clock, no id minting. It **returns** a
 * {@link SpecDiff}; the caller (`SpecRegistry` version-advance) computes it once and
 * hands it to the additive (SL-2/SL-3) and breaking (SL-4/SL-6) reactions, which
 * *read* it rather than re-diffing (SL-1.6 — one classification, many consumers).
 *
 * ## Protocol-agnostic (SL-1.4)
 *
 * It walks the shared {@link Ir} (resource groups → operations → schemas), never the
 * raw OpenAPI document — the same IR every downstream component reasons over. There
 * is no OpenAPI-specific logic here; a future non-REST Spec Adapter that produces the
 * same IR gets the same diff for free (`docs/architecture/extensibility.md`
 * *Beyond REST/OpenAPI*).
 *
 * ## The classification, and why the default is breaking (SL-1.2 / SL-1.3)
 *
 * `docs/architecture/extensibility.md` fixes the two buckets:
 *
 * - **Additive** — a new operation, a new *optional* field, a new schema/resource
 *   group. Nothing existing is affected, so an active mapping's referenced elements
 *   are provably unchanged and re-pinning it onto the new version is safe.
 * - **Breaking** — a removed operation/field, a renamed field, a changed type, a
 *   field that became **required** when it was not before.
 *
 * Everything else is **breaking by default (SL-1.3)**: a change is emitted as
 * `additive` only when this walk can *prove* it additive (a genuinely-new element
 * that leaves every prior element untouched). The asymmetry is deliberate — a false
 * "breaking" costs a needless scoped re-review (safe), while a false "additive" would
 * silently re-pin a live mapping onto an element that actually changed (unsafe). So a
 * relaxed-required field, an operation whose duplicate `operationId` cannot be paired,
 * a swapped request body — none provably additive — are all breaking.
 *
 * A **renamed field** is not special-cased: a rename is indistinguishable from a
 * removal plus an addition (the same stance `scope-revalidation.ts` takes), and its
 * *removal* half is already breaking — which is exactly the required signal. Guessing
 * the correspondence would re-point a mapping at a different element.
 *
 * Only structural shape is compared — presence, name, type, required-ness, method,
 * path. Human-text (`summary`/`description`) and single-value hints
 * (`enumValues`/`default`/`example`) are ignored: they never change what element a
 * mapping references, and the IR carries no live payload values, so every `reason`
 * string here is a structural identifier safe to log.
 */

// ── The SpecDiff domain type ──────────────────────────────────────────────────

/** Whether a single change is safe to re-pin over (`additive`) or not (`breaking`). */
export type SpecChangeClassification = "additive" | "breaking";

/**
 * The specific shape a {@link SpecChange} describes. A string-literal union (not a
 * message) so a downstream reaction can route on the exact change and a test can
 * assert it. The classification is carried separately because it is not a pure
 * function of the kind: `field-added`/`parameter-added` are additive when optional
 * and breaking when required, and a `response-body-changed` addition is additive
 * while its removal/swap is breaking.
 */
export type SpecChangeKind =
  | "resource-group-added"
  | "resource-group-removed"
  | "operation-added"
  | "operation-removed"
  | "operation-signature-changed"
  | "operation-ambiguous"
  | "parameter-added"
  | "parameter-removed"
  | "parameter-type-changed"
  | "parameter-requiredness-changed"
  | "request-body-changed"
  | "response-body-changed"
  | "schema-added"
  | "schema-removed"
  | "field-added"
  | "field-removed"
  | "field-type-changed"
  | "field-requiredness-changed";

/**
 * Where in the IR a change happened, carried at the granularity a downstream
 * reaction joins on: `ResourceBinding`/`SyncRule` refs name operations as
 * `resourceRef/operationId` and `FieldMapping` paths name fields within a
 * `resourceRef`, so a change entry carries exactly enough locality (SL-1.2) to
 * decide which `ApprovedMapping`s reference the changed element. A discriminated
 * union on `level` so an impossible locality (a field change with no schema) is
 * unrepresentable.
 */
export type SpecChangeLocation =
  | { readonly level: "resource"; readonly resourceRef: string }
  | { readonly level: "operation"; readonly resourceRef: string; readonly operationId: string }
  | {
      readonly level: "parameter";
      readonly resourceRef: string;
      readonly operationId: string;
      readonly parameterName: string;
      readonly parameterLocation: IrParameterLocation;
    }
  | { readonly level: "schema"; readonly resourceRef: string; readonly schemaName: string }
  | {
      readonly level: "field";
      readonly resourceRef: string;
      readonly schemaName: string;
      readonly fieldName: string;
    };

/** One classified change between two IR versions. */
export interface SpecChange {
  readonly kind: SpecChangeKind;
  readonly classification: SpecChangeClassification;
  readonly location: SpecChangeLocation;
  /** A structural, secret-free explanation (identifiers/types only) for audit + review UI. */
  readonly reason: string;
}

/**
 * The classification of the changes between two versions of one `ApiSpec` lineage
 * (`docs/glossary.md` `SpecDiff`). `classification` is the **overall** verdict —
 * `breaking` iff any individual change is breaking — that decides which reaction
 * runs; `changes` is the per-change detail that scopes it. An empty `changes` list
 * with `classification: "additive"` is a structurally-identical re-parse (e.g. only
 * descriptions changed): safe to re-pin, nothing to analyze.
 */
export interface SpecDiff {
  readonly classification: SpecChangeClassification;
  readonly changes: readonly SpecChange[];
}

// ── The diff ──────────────────────────────────────────────────────────────────

/**
 * **SL-1.2/1.3/1.4 — classify every structural change from `oldIr` to `newIr`.** The
 * `SpecRegistry.diffSpec` interface (`docs/architecture/overview.md`), over the IR.
 *
 * `oldIr` is the currently-active version's IR, `newIr` the freshly-ingested one.
 * The result's `classification` is `breaking` iff at least one change is breaking.
 */
export function diffSpec(oldIr: Ir, newIr: Ir): SpecDiff {
  const changes: SpecChange[] = [];
  const oldGroups = indexBy(oldIr, (group) => group.resourceRef);
  const newGroups = indexBy(newIr, (group) => group.resourceRef);

  // Resource groups: removed (breaking) and matched (recurse), in old-then-new order.
  for (const oldGroup of oldIr) {
    const newGroup = newGroups.get(oldGroup.resourceRef);
    if (newGroup === undefined) {
      changes.push({
        kind: "resource-group-removed",
        classification: "breaking",
        location: { level: "resource", resourceRef: oldGroup.resourceRef },
        reason: `resource group '${oldGroup.resourceRef}' was removed`,
      });
      continue;
    }
    diffGroup(oldGroup, newGroup, changes);
  }
  for (const newGroup of newIr) {
    if (oldGroups.has(newGroup.resourceRef)) continue;
    changes.push({
      kind: "resource-group-added",
      classification: "additive",
      location: { level: "resource", resourceRef: newGroup.resourceRef },
      reason: `resource group '${newGroup.resourceRef}' was added`,
    });
  }

  const classification: SpecChangeClassification = changes.some(
    (change) => change.classification === "breaking",
  )
    ? "breaking"
    : "additive";
  return { classification, changes };
}

// ── Resource group internals ──────────────────────────────────────────────────

function diffGroup(
  oldGroup: IrResourceGroup,
  newGroup: IrResourceGroup,
  changes: SpecChange[],
): void {
  diffOperations(oldGroup, newGroup, changes);
  diffSchemas(oldGroup, newGroup, changes);
}

/**
 * Operations are keyed by `operationId` — the id `OperationMapping.sourceOperationRef`
 * / `ResourceBinding` refs join on (a synthetic `"{method} {path}"` when the source
 * omits one, which is itself stable across re-parses). A new id is additive, a removed
 * id is breaking, and a matched id's *signature* (method, path, parameters, request/
 * response body reference) is compared for a change.
 *
 * `operationId` is not guaranteed unique (SI-1 crit 8). When a bucket holds more than
 * one operation the two sides cannot be paired reliably, so — conservatively (SL-1.3)
 * — the buckets are compared as canonical multisets and any difference is one
 * `operation-ambiguous` **breaking** change rather than a guessed pairing.
 */
function diffOperations(
  oldGroup: IrResourceGroup,
  newGroup: IrResourceGroup,
  changes: SpecChange[],
): void {
  const resourceRef = newGroup.resourceRef;
  const oldBuckets = bucketBy(oldGroup.operations, (operation) => operation.operationId);
  const newBuckets = bucketBy(newGroup.operations, (operation) => operation.operationId);

  for (const [operationId, olds] of oldBuckets) {
    const news = newBuckets.get(operationId);
    if (news === undefined) {
      changes.push({
        kind: "operation-removed",
        classification: "breaking",
        location: { level: "operation", resourceRef, operationId },
        reason: `operation '${operationId}' was removed from resource '${resourceRef}'`,
      });
      continue;
    }
    const [oldOp] = olds;
    const [newOp] = news;
    if (olds.length === 1 && news.length === 1 && oldOp !== undefined && newOp !== undefined) {
      diffOperation(resourceRef, oldOp, newOp, changes);
      continue;
    }
    if (!multisetsEqual(olds.map(operationSignature), news.map(operationSignature))) {
      changes.push({
        kind: "operation-ambiguous",
        classification: "breaking",
        location: { level: "operation", resourceRef, operationId },
        reason: `operation '${operationId}' has a duplicate id whose set of signatures changed and cannot be paired`,
      });
    }
  }

  for (const [operationId] of newBuckets) {
    if (oldBuckets.has(operationId)) continue;
    changes.push({
      kind: "operation-added",
      classification: "additive",
      location: { level: "operation", resourceRef, operationId },
      reason: `operation '${operationId}' was added to resource '${resourceRef}'`,
    });
  }
}

function diffOperation(
  resourceRef: string,
  oldOp: IrOperation,
  newOp: IrOperation,
  changes: SpecChange[],
): void {
  const operationId = newOp.operationId;
  if (oldOp.method !== newOp.method || oldOp.path !== newOp.path) {
    changes.push({
      kind: "operation-signature-changed",
      classification: "breaking",
      location: { level: "operation", resourceRef, operationId },
      reason: `operation '${operationId}' changed its method/path (${oldOp.method} ${oldOp.path} → ${newOp.method} ${newOp.path})`,
    });
  }
  diffParameters(resourceRef, operationId, oldOp.parameters, newOp.parameters, changes);
  diffBodyReference(
    resourceRef,
    operationId,
    "request",
    oldOp.requestSchema,
    newOp.requestSchema,
    changes,
  );
  diffBodyReference(
    resourceRef,
    operationId,
    "response",
    oldOp.responseSchema,
    newOp.responseSchema,
    changes,
  );
}

/**
 * Parameters are matched by `(location, name)` — the same pair the IR keys them by. A
 * removed parameter and a type change are breaking; a required-ness change either way
 * is breaking (a newly-required input breaks callers; a relaxed one is not provably
 * additive — SL-1.3); a *new* parameter is additive only when optional, breaking when
 * required.
 */
function diffParameters(
  resourceRef: string,
  operationId: string,
  oldParams: readonly IrParameter[],
  newParams: readonly IrParameter[],
  changes: SpecChange[],
): void {
  const oldByKey = indexBy(oldParams, parameterKey);
  const newByKey = indexBy(newParams, parameterKey);

  for (const parameter of oldParams) {
    if (newByKey.has(parameterKey(parameter))) continue;
    changes.push({
      kind: "parameter-removed",
      classification: "breaking",
      location: parameterChangeLocation(resourceRef, operationId, parameter),
      reason: `parameter '${parameter.location} ${parameter.name}' was removed from operation '${operationId}'`,
    });
  }

  for (const parameter of newParams) {
    const previous = oldByKey.get(parameterKey(parameter));
    if (previous === undefined) {
      changes.push({
        kind: "parameter-added",
        classification: parameter.required ? "breaking" : "additive",
        location: parameterChangeLocation(resourceRef, operationId, parameter),
        reason: parameter.required
          ? `required parameter '${parameter.location} ${parameter.name}' was added to operation '${operationId}'`
          : `optional parameter '${parameter.location} ${parameter.name}' was added to operation '${operationId}'`,
      });
      continue;
    }
    if (previous.type !== parameter.type) {
      changes.push({
        kind: "parameter-type-changed",
        classification: "breaking",
        location: parameterChangeLocation(resourceRef, operationId, parameter),
        reason: `parameter '${parameter.location} ${parameter.name}' of operation '${operationId}' changed type (${previous.type ?? "?"} → ${parameter.type ?? "?"})`,
      });
    }
    if (previous.required !== parameter.required) {
      changes.push({
        kind: "parameter-requiredness-changed",
        classification: "breaking",
        location: parameterChangeLocation(resourceRef, operationId, parameter),
        reason: `parameter '${parameter.location} ${parameter.name}' of operation '${operationId}' changed required-ness (${String(previous.required)} → ${String(parameter.required)})`,
      });
    }
  }
}

/**
 * An operation's request/response body is compared by the *name* of the schema it
 * references. The body's **fields** are diffed once by {@link diffSchemas} (the schema
 * set includes every operation body), so this only catches a change of *which* schema
 * an operation returns/accepts — a swap, an added body, a removed body — which the
 * field-level pass alone would miss. An inline (anonymous) body carries a synthetic
 * name stable across re-parses of the same operation, so this correctly reports "no
 * body-reference change" for it and leaves its field changes to the schema pass.
 *
 * Adding a **response** body where there was none is additive (a caller simply gets
 * more); every other body-reference change — a new request body (a new input), a
 * removed body, a swapped body — is breaking (SL-1.3).
 */
function diffBodyReference(
  resourceRef: string,
  operationId: string,
  phase: "request" | "response",
  oldSchema: IrSchema | undefined,
  newSchema: IrSchema | undefined,
  changes: SpecChange[],
): void {
  const oldName = oldSchema?.name;
  const newName = newSchema?.name;
  if (oldName === newName) return;

  const kind: SpecChangeKind =
    phase === "request" ? "request-body-changed" : "response-body-changed";
  const location: SpecChangeLocation = { level: "operation", resourceRef, operationId };

  if (oldName === undefined && newName !== undefined) {
    const additive = phase === "response";
    changes.push({
      kind,
      classification: additive ? "additive" : "breaking",
      location,
      reason: `operation '${operationId}' gained a ${phase} body ('${newName}')`,
    });
    return;
  }
  if (oldName !== undefined && newName === undefined) {
    changes.push({
      kind,
      classification: "breaking",
      location,
      reason: `operation '${operationId}' lost its ${phase} body ('${oldName}')`,
    });
    return;
  }
  changes.push({
    kind,
    classification: "breaking",
    location,
    reason: `operation '${operationId}' swapped its ${phase} body ('${oldName ?? "?"}' → '${newName ?? "?"}')`,
  });
}

/**
 * The field-bearing schema set of a resource group = its named component `schemas`
 * plus every operation's inline request/response body, de-duplicated by name. A named
 * body and its `group.schemas` entry share a name (the IR builder caches one object),
 * so they collapse to one entry — the whole field surface is diffed exactly once.
 */
function diffSchemas(
  oldGroup: IrResourceGroup,
  newGroup: IrResourceGroup,
  changes: SpecChange[],
): void {
  const resourceRef = newGroup.resourceRef;
  const oldSchemas = collectSchemas(oldGroup);
  const newSchemas = collectSchemas(newGroup);

  for (const [schemaName, oldSchema] of oldSchemas) {
    const newSchema = newSchemas.get(schemaName);
    if (newSchema === undefined) {
      changes.push({
        kind: "schema-removed",
        classification: "breaking",
        location: { level: "schema", resourceRef, schemaName },
        reason: `schema '${schemaName}' was removed from resource '${resourceRef}'`,
      });
      continue;
    }
    diffFields(resourceRef, schemaName, oldSchema.fields, newSchema.fields, changes);
  }

  for (const [schemaName] of newSchemas) {
    if (oldSchemas.has(schemaName)) continue;
    changes.push({
      kind: "schema-added",
      classification: "additive",
      location: { level: "schema", resourceRef, schemaName },
      reason: `schema '${schemaName}' was added to resource '${resourceRef}'`,
    });
  }
}

/**
 * Fields matched by name within a schema. A removed field is breaking (and is the
 * breaking half of a rename); a type change is breaking; a required-ness change either
 * way is breaking (newly-required breaks writers; relaxed-required is not provably
 * additive — SL-1.3); a *new* field is additive only when optional, breaking when
 * required (a new required field is not provably additive).
 */
function diffFields(
  resourceRef: string,
  schemaName: string,
  oldFields: readonly IrField[],
  newFields: readonly IrField[],
  changes: SpecChange[],
): void {
  const oldByName = indexBy(oldFields, (field) => field.name);
  const newByName = indexBy(newFields, (field) => field.name);

  for (const field of oldFields) {
    if (newByName.has(field.name)) continue;
    changes.push({
      kind: "field-removed",
      classification: "breaking",
      location: { level: "field", resourceRef, schemaName, fieldName: field.name },
      reason: `field '${field.name}' was removed from schema '${schemaName}'`,
    });
  }

  for (const field of newFields) {
    const previous = oldByName.get(field.name);
    if (previous === undefined) {
      changes.push({
        kind: "field-added",
        classification: field.required ? "breaking" : "additive",
        location: { level: "field", resourceRef, schemaName, fieldName: field.name },
        reason: field.required
          ? `required field '${field.name}' was added to schema '${schemaName}'`
          : `optional field '${field.name}' was added to schema '${schemaName}'`,
      });
      continue;
    }
    if (previous.type !== field.type) {
      changes.push({
        kind: "field-type-changed",
        classification: "breaking",
        location: { level: "field", resourceRef, schemaName, fieldName: field.name },
        reason: `field '${field.name}' of schema '${schemaName}' changed type (${previous.type} → ${field.type})`,
      });
    }
    if (previous.required !== field.required) {
      changes.push({
        kind: "field-requiredness-changed",
        classification: "breaking",
        location: { level: "field", resourceRef, schemaName, fieldName: field.name },
        reason: `field '${field.name}' of schema '${schemaName}' changed required-ness (${String(previous.required)} → ${String(field.required)})`,
      });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectSchemas(group: IrResourceGroup): Map<string, IrSchema> {
  const schemas = new Map<string, IrSchema>();
  for (const schema of group.schemas) {
    schemas.set(schema.name, schema);
  }
  for (const operation of group.operations) {
    if (operation.requestSchema !== undefined) {
      schemas.set(operation.requestSchema.name, operation.requestSchema);
    }
    if (operation.responseSchema !== undefined) {
      schemas.set(operation.responseSchema.name, operation.responseSchema);
    }
  }
  return schemas;
}

/** The `(location, name)` match key for a parameter — a visible-delimited pair, never NUL. */
function parameterKey(parameter: IrParameter): string {
  return `${parameter.location} ${parameter.name}`;
}

function parameterChangeLocation(
  resourceRef: string,
  operationId: string,
  parameter: IrParameter,
): SpecChangeLocation {
  return {
    level: "parameter",
    resourceRef,
    operationId,
    parameterName: parameter.name,
    parameterLocation: parameter.location,
  };
}

/**
 * A deterministic canonical signature of an operation — method, path, sorted
 * parameters, and request/response body names — used only to compare un-pairable
 * duplicate-`operationId` buckets as multisets. Visible delimiters, never NUL.
 */
function operationSignature(operation: IrOperation): string {
  const params = operation.parameters
    .map(
      (parameter) =>
        `${parameter.location} ${parameter.name}:${parameter.type ?? ""}:${String(parameter.required)}`,
    )
    .sort();
  return [
    `${operation.method} ${operation.path}`,
    `params=[${params.join(",")}]`,
    `request=${operation.requestSchema?.name ?? ""}`,
    `response=${operation.responseSchema?.name ?? ""}`,
  ].join("|");
}

/** Whether two string arrays are equal as multisets (order-independent). */
function multisetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** Index items by a derived key (last write wins — the IR has no duplicate keys here). */
function indexBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    index.set(key(item), item);
  }
  return index;
}

/** Group items into buckets by a derived key, preserving first-appearance key order. */
function bucketBy<T>(items: Iterable<T>, key: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const bucketKey = key(item);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [item]);
    } else {
      bucket.push(item);
    }
  }
  return buckets;
}
