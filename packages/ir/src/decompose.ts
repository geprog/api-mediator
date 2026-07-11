import type {
  Ir,
  IrField,
  IrHttpMethod,
  IrOperation,
  IrParameter,
  IrParameterLocation,
  IrResourceGroup,
  IrSchema,
  IrSchemaSummary,
} from "@mediator/domain";
import { stripUndefined } from "@mediator/domain";

import {
  asRecord,
  getArray,
  getBoolean,
  getRecord,
  getString,
  refName,
  resolvePointer,
  type JsonObject,
} from "./json.js";

/**
 * Decompose a **bundled** OpenAPI document (all `$ref`s local, per
 * {@link ../build-ir}) into the domain {@link Ir} (mapping-engine.md
 * "Spec decomposition"):
 *
 * 1. Operations are grouped into resource groups by their **path resource
 *    noun** — the last non-parameter path segment — so a spec's real resources
 *    fall into fine, cleanly separated groups (`issues`, `comments`, `labels`,
 *    …) rather than collapsing under one coarse `tags` blob. Action sub-paths
 *    (single write verbs like `.../{id}/lock`) merge into their parent resource,
 *    and paths with no usable noun fall back to the `tags`/path-prefix heuristic
 *    (see {@link groupOperations}).
 * 2. Each operation records method, path, summary/description, parameters, and
 *    its inline-flattened request/response schemas plus its `operationId`.
 * 3. A group's referenced component schemas are flattened to top-level fields;
 *    schemas referenced only *by a field* of those (i.e. belonging to another
 *    resource) are emitted as lightweight {@link IrSchemaSummary} cross-resource
 *    references rather than fully expanded.
 *
 * The function never throws on schema-level messiness — it produces a best-effort
 * IR and resolves refs itself with cycle guards, so no unresolved `$ref` survives
 * into the output (SI-1 crit 1).
 */
export function decomposeDocument(root: JsonObject): Ir {
  const context: Context = { root };
  const rawOperations = collectOperations(root);
  return groupOperations(rawOperations).map((group) =>
    decomposeGroup(group.resourceRef, group.operations, context),
  );
}

/** Flatten `paths` into the operations to group, in stable document order. */
function collectOperations(root: JsonObject): RawOperation[] {
  const collected: RawOperation[] = [];
  const paths = getRecord(root, "paths");
  if (!paths) return collected;
  for (const [path, node] of Object.entries(paths)) {
    const pathItem = asRecord(node);
    if (!pathItem) continue;
    const pathParameters = getArray(pathItem, "parameters") ?? [];
    for (const method of HTTP_METHODS) {
      const operation = getRecord(pathItem, method);
      if (!operation) continue;
      collected.push({ method, path, operation, pathParameters, noun: resourceNounOf(path) });
    }
  }
  return collected;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface Context {
  readonly root: JsonObject;
}

interface RawOperation {
  readonly method: IrHttpMethod;
  readonly path: string;
  readonly operation: JsonObject;
  readonly pathParameters: readonly unknown[];
  /** The operation's resource noun (last non-parameter segment), or `undefined`. */
  readonly noun: string | undefined;
}

/** An operation paired with its group key (resource noun or fallback). */
interface KeyedOperation {
  readonly operation: RawOperation;
  readonly key: string;
}

/** One resolved resource group: its stable `resourceRef` and its operations. */
interface GroupedOperations {
  readonly resourceRef: string;
  readonly operations: RawOperation[];
}

/** A schema resolved to its object form, with the component name if it had one. */
interface ResolvedBody {
  /** The component-schema name, or `undefined` for an inline (anonymous) body. */
  readonly name: string | undefined;
  readonly schema: JsonObject;
  /** Synthetic name used when {@link name} is absent (inline bodies). */
  readonly fallbackName: string;
}

interface GroupState {
  /** Names of component schemas used directly as a request/response body. */
  readonly primaryNames: Set<string>;
  /** Flattened primary schemas, keyed by name (the group's `schemas`). */
  readonly primarySchemas: Map<string, IrSchema>;
  /** Schemas referenced by a field of a primary schema: name → its `$ref`. */
  readonly fieldReferences: Map<string, string>;
}

const HTTP_METHODS: readonly IrHttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
];

const PARAMETER_LOCATIONS: readonly IrParameterLocation[] = ["path", "query", "header", "cookie"];

const MAX_REF_DEPTH = 16;

// ── Resource grouping ────────────────────────────────────────────────────────

/**
 * Group operations into resource-level IR units by their **path resource noun**,
 * merging action sub-paths into their parent resource (mapping-engine.md "Spec
 * decomposition"). Grouping by the noun keeps a spec's real resources cleanly
 * separated (`issues`, `comments`, `labels`, `milestones`, …) instead of letting
 * one coarse `tags` value collapse dozens of unrelated operations into a single
 * blob — which starved mapping-detection recall and bloated prompts:
 *
 * 1. **Resource noun** of an operation = its last non-parameter path segment
 *    (`{…}` segments are parameters). `GET /repos/{owner}/{repo}/issues` and
 *    `GET /repos/{owner}/{repo}/issues/{index}` both have noun `issues`;
 *    `.../issues/{index}/comments` has noun `comments`; `.../{index}/lock` has
 *    noun `lock`.
 * 2. Operations are grouped by that noun across the whole spec.
 * 3. A noun-group is a **real resource** when it has at least one collection-list
 *    GET — a GET whose own resource noun equals the group noun (grouping is by
 *    noun, so any GET in the group qualifies). A group with none is an **action**
 *    (single write verbs like `lock`, `unlock`, `pin`, `start`, `stop`) and each
 *    of its operations is merged into its **parent noun** — the last non-parameter
 *    segment before the operation's own noun (`POST .../issues/{index}/lock` →
 *    `issues`). An operation with no parent noun keeps its own noun as its group.
 * 4. Each group's `resourceRef` is its noun, and groups plus their operations
 *    preserve document order (first appearance), so `resourceRef`s are stable
 *    across re-parses of the same document (SI-1 crit 6).
 * 5. A path with **no usable noun** (e.g. a single `/`, or an RPC-style flat API)
 *    falls back to the legacy `tags`/path-prefix heuristic ({@link fallbackRef}),
 *    so non-RESTful specs still group sensibly and odd paths never crash.
 */
function groupOperations(rawOperations: readonly RawOperation[]): GroupedOperations[] {
  const keyed: KeyedOperation[] = rawOperations.map((operation) => ({
    operation,
    key: operation.noun ?? fallbackRef(operation.operation, operation.path),
  }));

  // A key is a real resource iff some operation under it is a collection-list
  // GET — a GET whose resource noun equals the key. Fallback keys (noun-less
  // paths) never satisfy this and so are treated as actions with no parent,
  // which keeps them as their own group.
  const realKeys = new Set<string>();
  for (const { operation, key } of keyed) {
    if (operation.method === "get" && operation.noun === key) realKeys.add(key);
  }

  const order: string[] = [];
  const operationsByRef = new Map<string, RawOperation[]>();
  for (const { operation, key } of keyed) {
    const resourceRef = realKeys.has(key) ? key : (parentNounOf(operation.path) ?? key);
    let list = operationsByRef.get(resourceRef);
    if (!list) {
      list = [];
      operationsByRef.set(resourceRef, list);
      order.push(resourceRef);
    }
    list.push(operation);
  }

  return order.map((resourceRef) => ({
    resourceRef,
    operations: operationsByRef.get(resourceRef) ?? [],
  }));
}

/** A path's resource noun: its last non-parameter segment, or `undefined`. */
function resourceNounOf(path: string): string | undefined {
  const segments = pathSegments(path);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && !isParameterSegment(segment)) return segment;
  }
  return undefined;
}

/** The last non-parameter segment *before* a path's resource noun, if any. */
function parentNounOf(path: string): string | undefined {
  const segments = pathSegments(path);
  let nounIndex = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && !isParameterSegment(segment)) {
      nounIndex = i;
      break;
    }
  }
  for (let i = nounIndex - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && !isParameterSegment(segment)) return segment;
  }
  return undefined;
}

/**
 * The legacy fallback `resourceRef` for an operation whose path yields no noun:
 * its first `tags` entry, else the first non-parameter path segment, else
 * `"default"`. Both are stable across re-parses (SI-1 crit 6).
 */
function fallbackRef(operation: JsonObject, path: string): string {
  const tags = getArray(operation, "tags");
  if (tags) {
    for (const tag of tags) {
      if (typeof tag === "string" && tag.length > 0) return tag;
    }
  }
  const segment = pathSegments(path).find((part) => !isParameterSegment(part));
  return segment ?? "default";
}

function isParameterSegment(segment: string): boolean {
  return segment.startsWith("{");
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function decomposeGroup(
  resourceRef: string,
  rawOperations: readonly RawOperation[],
  context: Context,
): IrResourceGroup {
  const state: GroupState = {
    primaryNames: new Set<string>(),
    primarySchemas: new Map<string, IrSchema>(),
    fieldReferences: new Map<string, string>(),
  };

  const operations = rawOperations.map((raw) => buildOperation(raw, context, state));

  const crossResourceRefs: IrSchemaSummary[] = [];
  const summarized = new Set<string>();
  for (const [name, ref] of state.fieldReferences) {
    if (state.primaryNames.has(name) || summarized.has(name)) continue;
    summarized.add(name);
    const summary = summarizeSchema(name, ref, context);
    if (summary) crossResourceRefs.push(summary);
  }

  return {
    resourceRef,
    name: resourceRef,
    operations,
    schemas: [...state.primarySchemas.values()],
    crossResourceRefs,
  };
}

// ── Operations ───────────────────────────────────────────────────────────────

function buildOperation(raw: RawOperation, context: Context, state: GroupState): IrOperation {
  const operationId = operationIdOf(raw);
  const requestBody = resolveRequestBody(raw.operation, context, `${operationId} request`);
  const responseBody = resolveResponseBody(raw.operation, context, `${operationId} response`);

  return stripUndefined({
    operationId,
    method: raw.method,
    path: raw.path,
    summary: getString(raw.operation, "summary"),
    description: getString(raw.operation, "description"),
    parameters: buildParameters(raw, context),
    requestSchema: requestBody ? adoptSchema(requestBody, context, state) : undefined,
    responseSchema: responseBody ? adoptSchema(responseBody, context, state) : undefined,
  });
}

/**
 * The operation's `operationId`, or a synthetic `"{method} {path}"` when the
 * source omits one. Vikunja's OAS3 conversion drops every `operationId`, and the
 * `ResourceBinding` operation refs need an addressable id, so a stable surrogate
 * is synthesized. Real ids are preserved verbatim (duplicates and all — SI-1
 * crit 8).
 */
function operationIdOf(raw: RawOperation): string {
  const id = getString(raw.operation, "operationId");
  if (id && id.trim().length > 0) return id;
  return `${raw.method} ${raw.path}`;
}

function buildParameters(raw: RawOperation, context: Context): IrParameter[] {
  // Path-level parameters apply to every operation on the path; operation-level
  // parameters override them on matching (name, location).
  const merged = new Map<string, IrParameter>();
  for (const node of raw.pathParameters) addParameter(merged, node, context);
  for (const node of getArray(raw.operation, "parameters") ?? [])
    addParameter(merged, node, context);
  return [...merged.values()];
}

function addParameter(target: Map<string, IrParameter>, node: unknown, context: Context): void {
  const resolved = resolveRef(node, context);
  if (!resolved) return;
  const name = getString(resolved.schema, "name");
  const location = getString(resolved.schema, "in");
  if (!name || !location) return;
  const parameterLocation = PARAMETER_LOCATIONS.find((candidate) => candidate === location);
  if (!parameterLocation) return;

  const parameter: IrParameter = stripUndefined({
    name,
    location: parameterLocation,
    required: getBoolean(resolved.schema, "required") ?? parameterLocation === "path",
    type: parameterType(resolved.schema),
    description: getString(resolved.schema, "description"),
  });
  target.set(`${parameterLocation} ${name}`, parameter);
}

function parameterType(parameter: JsonObject): string | undefined {
  const schema = getRecord(parameter, "schema");
  if (!schema) return undefined;
  return scalarType(schema["type"]);
}

// ── Bodies → IrSchema ────────────────────────────────────────────────────────

function resolveRequestBody(
  operation: JsonObject,
  context: Context,
  fallbackName: string,
): ResolvedBody | undefined {
  const requestBody = resolveRef(operation["requestBody"], context);
  if (!requestBody) return undefined;
  const schemaNode = contentSchemaNode(requestBody.schema);
  if (!schemaNode) return undefined;
  return resolveBodySchema(schemaNode, context, fallbackName);
}

function resolveResponseBody(
  operation: JsonObject,
  context: Context,
  fallbackName: string,
): ResolvedBody | undefined {
  const responses = getRecord(operation, "responses");
  if (!responses) return undefined;
  const key = successResponseKey(responses);
  if (!key) return undefined;
  const response = resolveRef(responses[key], context);
  if (!response) return undefined;
  const schemaNode = contentSchemaNode(response.schema);
  if (!schemaNode) return undefined;
  return resolveBodySchema(schemaNode, context, fallbackName);
}

/** Prefer a `2xx` response (200/201 first), then `default`. */
function successResponseKey(responses: JsonObject): string | undefined {
  const keys = Object.keys(responses);
  const preferred = ["200", "201"];
  for (const code of preferred) {
    if (keys.includes(code)) return code;
  }
  const anySuccess = keys.find((code) => /^2\d\d$/.test(code) || code === "2XX" || code === "2xx");
  if (anySuccess) return anySuccess;
  return keys.includes("default") ? "default" : undefined;
}

/** From a `content` container, pick a schema node, preferring `application/json`. */
function contentSchemaNode(container: JsonObject): unknown {
  const content = getRecord(container, "content");
  if (!content) return undefined;
  const json = getRecord(content, "application/json");
  if (json && json["schema"] !== undefined) return json["schema"];
  for (const mediaType of Object.values(content)) {
    const media = asRecord(mediaType);
    if (media && media["schema"] !== undefined) return media["schema"];
  }
  return undefined;
}

/**
 * Resolve a body schema node to its object form. Array bodies are represented by
 * their item schema (the resource's element representation), so an `IrSchema`
 * always describes an object shape.
 */
function resolveBodySchema(
  node: unknown,
  context: Context,
  fallbackName: string,
): ResolvedBody | undefined {
  const resolved = resolveRef(node, context);
  if (!resolved) return undefined;
  if (schemaIsArray(resolved.schema)) {
    const items = getRecord(resolved.schema, "items");
    const resolvedItems = items ? resolveRef(items, context) : undefined;
    if (resolvedItems) {
      return { name: resolvedItems.name, schema: resolvedItems.schema, fallbackName };
    }
    // Array of primitives — no object fields to flatten.
    return { name: undefined, schema: {}, fallbackName };
  }
  return { name: resolved.name, schema: resolved.schema, fallbackName };
}

/**
 * Flatten a resolved body and register it. A *named* component schema becomes one
 * of the group's `schemas` (deduplicated); an inline body is embedded only on its
 * operation. Either way its field-referenced schemas feed cross-resource
 * summaries.
 */
function adoptSchema(body: ResolvedBody, context: Context, state: GroupState): IrSchema {
  if (body.name !== undefined) {
    state.primaryNames.add(body.name);
    const cached = state.primarySchemas.get(body.name);
    if (cached) return cached;
    const flattened = flattenSchema(body.name, body.schema, context);
    for (const [name, ref] of flattened.references) state.fieldReferences.set(name, ref);
    state.primarySchemas.set(body.name, flattened.schema);
    return flattened.schema;
  }
  const flattened = flattenSchema(body.fallbackName, body.schema, context);
  for (const [name, ref] of flattened.references) state.fieldReferences.set(name, ref);
  return flattened.schema;
}

interface FlattenedSchema {
  readonly schema: IrSchema;
  /** Schemas referenced by this schema's fields: name → `$ref`. */
  readonly references: Map<string, string>;
}

function flattenSchema(name: string, schema: JsonObject, context: Context): FlattenedSchema {
  const references = new Map<string, string>();
  const { properties, required } = collectProperties(schema, context, new Set<string>());
  const fields: IrField[] = [];
  for (const [fieldName, fieldSchema] of properties) {
    fields.push(
      stripUndefined({
        name: fieldName,
        type: describeType(fieldSchema, references),
        description: getString(fieldSchema, "description"),
        required: required.has(fieldName),
      }),
    );
  }
  return { schema: { name, fields }, references };
}

function summarizeSchema(name: string, ref: string, context: Context): IrSchemaSummary | undefined {
  const resolved = resolveRef({ $ref: ref }, context);
  if (!resolved) return undefined;
  const { properties } = collectProperties(resolved.schema, context, new Set<string>());
  return { name, fields: [...properties.keys()] };
}

/**
 * Collect a schema's top-level properties and required-name set, merging `allOf`
 * members (the common "extends" shape). `seen` guards against `$ref` cycles.
 */
function collectProperties(
  schema: JsonObject,
  context: Context,
  seen: Set<string>,
): { properties: Map<string, JsonObject>; required: Set<string> } {
  const properties = new Map<string, JsonObject>();
  const required = new Set<string>();

  const merge = (current: JsonObject): void => {
    const props = getRecord(current, "properties");
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        const record = asRecord(value);
        if (record) properties.set(key, record);
      }
    }
    for (const name of getArray(current, "required") ?? []) {
      if (typeof name === "string") required.add(name);
    }
    for (const member of getArray(current, "allOf") ?? []) {
      const ref = memberRef(member);
      if (ref) {
        if (seen.has(ref)) continue;
        seen.add(ref);
      }
      const resolved = resolveRef(member, context);
      if (resolved) merge(resolved.schema);
    }
  };

  merge(schema);
  return { properties, required };
}

function memberRef(member: unknown): string | undefined {
  const record = asRecord(member);
  return record ? getString(record, "$ref") : undefined;
}

/**
 * A best-effort type string for one property (top-level flattening only — nested
 * object fields are not expanded). A `$ref` becomes the referenced schema's name
 * and is recorded in `references` so it can surface as a cross-resource summary.
 */
function describeType(schema: JsonObject, references: Map<string, string>): string {
  const ref = getString(schema, "$ref");
  if (ref) return nameRef(ref, references) ?? "object";

  const type = schema["type"];
  if (typeof type === "string") return namedType(type, schema, references);
  if (Array.isArray(type)) {
    const names = type.filter(
      (entry): entry is string => typeof entry === "string" && entry !== "null",
    );
    const [only] = names;
    if (names.length === 1 && only !== undefined) return namedType(only, schema, references);
    if (names.length > 1) return names.join("|");
    return "null";
  }

  const composition =
    getArray(schema, "allOf") ?? getArray(schema, "oneOf") ?? getArray(schema, "anyOf");
  if (composition) {
    const refs = composition.map(memberRef).filter((value): value is string => value !== undefined);
    if (refs.length === 1) {
      const only = refs[0];
      if (only) return nameRef(only, references) ?? "object";
    }
    return "object";
  }

  if (getRecord(schema, "properties")) return "object";
  if (getArray(schema, "enum")) return "string";
  return "object";
}

function namedType(type: string, schema: JsonObject, references: Map<string, string>): string {
  if (type !== "array") return type;
  const items = getRecord(schema, "items");
  return items ? `${describeType(items, references)}[]` : "array";
}

function nameRef(ref: string, references: Map<string, string>): string | undefined {
  const name = refName(ref);
  if (!name) return undefined;
  references.set(name, ref);
  return name;
}

// ── Ref resolution ───────────────────────────────────────────────────────────

interface ResolvedRef {
  readonly name: string | undefined;
  readonly schema: JsonObject;
}

/**
 * Resolve a node that may be a `$ref` (following ref chains up to
 * {@link MAX_REF_DEPTH}) into its object form plus the component name if the last
 * ref named one. Returns `undefined` for non-objects or unresolvable refs.
 */
function resolveRef(node: unknown, context: Context, depth = 0): ResolvedRef | undefined {
  const record = asRecord(node);
  if (!record) return undefined;
  const ref = getString(record, "$ref");
  if (!ref) return { name: undefined, schema: record };
  if (depth >= MAX_REF_DEPTH) return undefined;
  const target = resolvePointer(context.root, ref);
  const targetRecord = asRecord(target);
  if (!targetRecord) return undefined;
  if (getString(targetRecord, "$ref")) return resolveRef(targetRecord, context, depth + 1);
  return { name: refName(ref), schema: targetRecord };
}

function schemaIsArray(schema: JsonObject): boolean {
  const type = schema["type"];
  if (type === "array") return true;
  return Array.isArray(type) && type.includes("array");
}

/** A scalar type string from a JSON-Schema `type` value (string or 3.1 array). */
function scalarType(type: unknown): string | undefined {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    for (const entry of type) {
      if (typeof entry === "string" && entry !== "null") return entry;
    }
  }
  return undefined;
}
