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
 * 1. Operations are grouped into resource groups by `tags` (first tag), falling
 *    back to a path-prefix heuristic when an operation carries no tag.
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
  const groupsInOrder: string[] = [];
  const operationsByGroup = new Map<string, RawOperation[]>();

  const paths = getRecord(root, "paths");
  if (paths) {
    for (const [path, node] of Object.entries(paths)) {
      const pathItem = asRecord(node);
      if (!pathItem) continue;
      const pathParameters = getArray(pathItem, "parameters") ?? [];
      for (const method of HTTP_METHODS) {
        const operation = getRecord(pathItem, method);
        if (!operation) continue;
        const resourceRef = resourceRefFor(operation, path);
        let list = operationsByGroup.get(resourceRef);
        if (!list) {
          list = [];
          operationsByGroup.set(resourceRef, list);
          groupsInOrder.push(resourceRef);
        }
        list.push({ method, path, operation, pathParameters });
      }
    }
  }

  return groupsInOrder.map((resourceRef) =>
    decomposeGroup(resourceRef, operationsByGroup.get(resourceRef) ?? [], context),
  );
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
 * The stable `resourceRef` of an operation: its first `tags` entry, or — when it
 * carries no tag — the first non-parameter path segment (path-prefix heuristic).
 * Both are stable across re-parses of the same document (SI-1 crit 6).
 */
function resourceRefFor(operation: JsonObject, path: string): string {
  const tags = getArray(operation, "tags");
  if (tags) {
    for (const tag of tags) {
      if (typeof tag === "string" && tag.length > 0) return tag;
    }
  }
  const segment = path
    .split("/")
    .filter((part) => part.length > 0)
    .find((part) => !part.startsWith("{"));
  return segment ?? "default";
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
