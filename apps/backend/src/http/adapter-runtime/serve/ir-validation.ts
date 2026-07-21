import type { AdapterRequest, ServeRejectionReason } from "@mediator/adapter-engine";
import type { IrField, IrOperation, IrParameter, IrSchema } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";

import { classifyUnionParameter } from "../../../modules/adapter-composition/union.js";

/**
 * Validation of a request/response against the **consumer operation's own IR**
 * (RP-2 inbound, AG-7 response). Pure: a value in → a verdict, no I/O — so a fixture
 * deterministically produces its verdict with no backend (RP-4.2 / AG-7.5).
 *
 * The IR flattens a schema to top-level `{ name, type, required }` fields (no inline
 * nested schema), so validation checks **top-level** required-ness and coarse type
 * agreement. That is exactly enough for the loudness guarantee: a mapping that omits
 * a required top-level consumer field, or a request missing a required parameter, is
 * caught — and every message names fields/parameters only, never a payload value.
 */

// ── shared: value ↔ IR type agreement ────────────────────────────────────────

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coarse agreement between an IR type string and a JSON value. Unknown/empty IR types accept. */
function typeMatches(irType: string | undefined, value: JsonValue): boolean {
  if (value === null) {
    // A present null is treated as nullable — required-ness is checked separately.
    return true;
  }
  const normalized = (irType ?? "").trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  if (normalized.endsWith("[]") || normalized === "array") {
    return Array.isArray(value);
  }
  switch (normalized) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
    case "int":
    case "long":
    case "float":
    case "double":
    case "decimal":
      return typeof value === "number";
    case "boolean":
    case "bool":
      return typeof value === "boolean";
    case "object":
      return isJsonRecord(value);
    default:
      // A type the IR could not pin down (a `$ref` name, `any`, etc.) never false-fails.
      return true;
  }
}

function fieldPresent(record: { [key: string]: JsonValue }, field: IrField): boolean {
  const value = record[field.name];
  return value !== undefined && value !== null;
}

/**
 * The top-level violations of a JSON value against an {@link IrSchema} — a required
 * field missing, or a present field of the wrong coarse type. Payload-free: only
 * field names + expected types appear. An empty list means valid.
 */
export function validateAgainstSchema(schema: IrSchema, value: JsonValue): readonly string[] {
  if (!isJsonRecord(value)) {
    return ["expected an object body"];
  }
  const violations: string[] = [];
  for (const field of schema.fields) {
    if (field.required && !fieldPresent(value, field)) {
      violations.push(`required field '${field.name}' is missing`);
      continue;
    }
    const fieldValue = value[field.name];
    if (fieldValue !== undefined && !typeMatches(field.type, fieldValue)) {
      violations.push(`field '${field.name}' should be ${field.type}`);
    }
  }
  return violations;
}

// ── RP-2: inbound request validation ─────────────────────────────────────────

/** The verdict of {@link validateInboundRequest} — accept, or a distinct client rejection (RP-2.6). */
export type InboundValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ServeRejectionReason; readonly detail: string };

/** Read a declared parameter's supplied value from the protocol-neutral request. */
function readSuppliedParam(
  request: AdapterRequest,
  parameter: IrParameter,
): { readonly supplied: boolean } {
  switch (parameter.location) {
    case "path": {
      const value = request.pathParameters[parameter.name];
      return { supplied: value !== undefined };
    }
    case "query": {
      const value = request.query[parameter.name];
      return { supplied: value !== undefined };
    }
    case "header": {
      // Fastify lower-cases header names; match the declared name case-insensitively.
      const wanted = parameter.name.toLowerCase();
      const supplied = Object.keys(request.headers).some((key) => key.toLowerCase() === wanted);
      return { supplied };
    }
    case "cookie":
      // Cookie parameters are not a supported consumer input here.
      return { supplied: false };
  }
}

/**
 * Validate the inbound request against the consumer operation's own request contract
 * (RP-2), **before** any transform or backend call. Two distinct rejection reasons:
 *  - `invalid-request` — a required parameter is absent, or the body fails the
 *    consumer's own request schema (the caller's fix, RP-2.1).
 *  - `unmapped-consumer-input` — the request *supplies* a declared consumer parameter
 *    the composition never mapped (`mappedConsumerParamNames`) **and** the composer did
 *    not acknowledge as ignored (`acknowledgedIgnoredParamNames`), so it would be
 *    silently dropped; rejected instead (RP-2.4). An omitted **optional** mapped
 *    parameter is accepted — absence is not an error (RP-2.5).
 *
 * A supplied parameter the composer **acknowledged-ignored** (CO-5.4) is *served* with
 * the parameter dropped: the acknowledgement is what makes the drop non-silent, so it is
 * not a rejection. The default — an empty `acknowledgedIgnoredParamNames` — keeps every
 * unmapped input rejecting (the fail-loud, backward-compatible behavior).
 *
 * Undeclared transport headers are never consumer inputs and are ignored — only the
 * operation's declared parameters are checked. `unionConfig` is supplied **only** for a
 * `collection-union` endpoint and adds the RP-2.2/2.3 rejection (the CO-3↔RP-2 contract):
 * a supplied filter/sort/pagination query parameter with no configured post-merge
 * semantics rejects as `union-parameter-unconfigured`, never a silently
 * unfiltered/unsorted/mispaged answer. A non-union endpoint passes no `unionConfig` and is
 * therefore entirely unaffected.
 */
export function validateInboundRequest(
  operation: IrOperation,
  request: AdapterRequest,
  mappedConsumerParamNames: ReadonlySet<string>,
  acknowledgedIgnoredParamNames: ReadonlySet<string>,
  unionConfig?: UnionServeConfig,
): InboundValidation {
  const unmapped: string[] = [];
  let unionReject: string | undefined;
  for (const parameter of operation.parameters) {
    if (parameter.location === "cookie") {
      continue;
    }
    const { supplied } = readSuppliedParam(request, parameter);
    if (parameter.required && !supplied) {
      return {
        ok: false,
        reason: "invalid-request",
        detail: `missing required ${parameter.location} parameter '${parameter.name}'`,
      };
    }
    if (!supplied) {
      continue;
    }

    // RP-2.2/2.3 — a union query parameter's fate is decided by the union config, not by
    // per-backend `ParameterMapping`s: sort/pagination are never pushed down, so a
    // post-merge entry is the only way to honor them, and a filter is honored by pushdown
    // (mapped in every binding) or a `postMergeFilters` entry. A **servable** union
    // parameter is handled — not an unmapped input — while an **unconfigured** one is the
    // more-specific rejection (recorded, reported after the body check).
    if (unionConfig !== undefined && parameter.location === "query") {
      const verdict = unionParameterVerdict(
        parameter,
        request,
        mappedConsumerParamNames,
        unionConfig,
      );
      if (verdict.kind === "servable") {
        continue;
      }
      if (verdict.kind === "unconfigured") {
        unionReject ??= verdict.detail;
        continue;
      }
      // `not-union` (a filter mapped in no binding) falls through to the generic check.
    }

    if (
      !mappedConsumerParamNames.has(parameter.name) &&
      !acknowledgedIgnoredParamNames.has(parameter.name)
    ) {
      unmapped.push(parameter.name);
    }
  }

  const bodyViolation = validateRequestBody(operation, request.body);
  if (bodyViolation !== undefined) {
    return { ok: false, reason: "invalid-request", detail: bodyViolation };
  }

  // A union parameter with no configured semantics is reported ahead of the generic
  // `unmapped-consumer-input` return, so it carries the more specific cause (RP-2.6).
  if (unionReject !== undefined) {
    return { ok: false, reason: "union-parameter-unconfigured", detail: unionReject };
  }

  const firstUnmapped = unmapped[0];
  if (firstUnmapped !== undefined) {
    return {
      ok: false,
      reason: "unmapped-consumer-input",
      detail: `consumer parameter '${firstUnmapped}' has no configured mapping to a backend`,
    };
  }
  return { ok: true };
}

/**
 * The persisted union serving state RP-2 consults for a `collection-union` endpoint —
 * built by the serve handler from the endpoint's `postMerge*` config plus the active
 * bindings' `ParameterMapping`s. All parameter names are **bare** (the RP-2 inbound check
 * compares bare names).
 */
export interface UnionServeConfig {
  /** Consumer filter params pushed down over the union — those mapped in **every** contributing binding. */
  readonly pushdownEligibleParamNames: ReadonlySet<string>;
  /** Consumer filter params covered by a `postMergeFilters` entry. */
  readonly postMergeFilterParamNames: ReadonlySet<string>;
  /** Consumer pagination params covered by a **confirmed** `postMergePagination` convention. */
  readonly paginationParamNames: ReadonlySet<string>;
  /**
   * Per bare **sort** param name: whether a fixed entry exists (its presence selects the
   * order) and the set of accepted values (a value-driven `?sort=name`). Absent key = no
   * `postMergeSorts` entry for that parameter, so any request using it rejects.
   */
  readonly sortConfigByParam: ReadonlyMap<
    string,
    { readonly fixed: boolean; readonly values: ReadonlySet<string> }
  >;
}

/** The supplied query values of a parameter (repeated keys keep all values), or empty when absent. */
function suppliedQueryValues(request: AdapterRequest, name: string): readonly string[] {
  const raw = request.query[name];
  if (raw === undefined) {
    return [];
  }
  return typeof raw === "string" ? [raw] : [...raw];
}

/** Whether a supplied sort parameter's value(s) are all covered by a `postMergeSorts` entry. */
function sortServable(
  name: string,
  suppliedValues: readonly string[],
  config: UnionServeConfig,
): boolean {
  const entry = config.sortConfigByParam.get(name);
  if (entry === undefined) {
    return false;
  }
  // A fixed sort parameter's mere presence selects the order — any value is honored.
  return entry.fixed || suppliedValues.every((value) => entry.values.has(value));
}

/**
 * How a `collection-union` treats one supplied **query** parameter (RP-2.2/2.3):
 * - `servable` — honored by the union config (a confirmed pagination convention, a
 *   `postMergeSorts` entry, pushdown in every binding, or a `postMergeFilters` entry), so
 *   it is neither rejected nor an unmapped input.
 * - `unconfigured` — a sort/pagination parameter with no post-merge semantics, or a filter
 *   mapped in *some* binding (so not a generic unmapped input) but neither pushed down nor
 *   post-merge configured. Rejected as `union-parameter-unconfigured`, never answered
 *   unfiltered/unsorted/mispaged.
 * - `not-union` — a filter mapped in **no** binding: a generic unmapped input, deferred to
 *   the `unmapped-consumer-input` cause (a better fit).
 */
type UnionParameterVerdict =
  | { readonly kind: "servable" }
  | { readonly kind: "unconfigured"; readonly detail: string }
  | { readonly kind: "not-union" };

function unionParameterVerdict(
  parameter: IrParameter,
  request: AdapterRequest,
  mappedConsumerParamNames: ReadonlySet<string>,
  config: UnionServeConfig,
): UnionParameterVerdict {
  const kind = classifyUnionParameter(parameter);
  if (kind === "pagination") {
    return config.paginationParamNames.has(parameter.name)
      ? { kind: "servable" }
      : {
          kind: "unconfigured",
          detail: `union pagination parameter '${parameter.name}' has no confirmed postMergePagination semantics`,
        };
  }
  if (kind === "sort") {
    return sortServable(parameter.name, suppliedQueryValues(request, parameter.name), config)
      ? { kind: "servable" }
      : {
          kind: "unconfigured",
          detail: `union sort parameter '${parameter.name}' has no configured postMergeSorts semantics`,
        };
  }
  // filter
  if (
    config.pushdownEligibleParamNames.has(parameter.name) ||
    config.postMergeFilterParamNames.has(parameter.name)
  ) {
    return { kind: "servable" };
  }
  // Mapped in no binding at all → a generic unmapped input (better cause); otherwise an
  // unconfigured union filter (mapped in some binding, cannot be pushed down over the union).
  return mappedConsumerParamNames.has(parameter.name)
    ? {
        kind: "unconfigured",
        detail: `union filter parameter '${parameter.name}' is neither pushed down nor covered by a postMergeFilters entry`,
      }
    : { kind: "not-union" };
}

function schemaHasRequiredField(schema: IrSchema): boolean {
  return schema.fields.some((field) => field.required);
}

/** Validate the request body against the consumer op's request schema; a payload-free detail or `undefined`. */
function validateRequestBody(operation: IrOperation, body: unknown): string | undefined {
  const schema = operation.requestSchema;
  if (schema === undefined) {
    return undefined;
  }
  if (body === undefined || body === null) {
    return schemaHasRequiredField(schema) ? "request body is required" : undefined;
  }
  const violations = validateAgainstSchema(schema, body as JsonValue);
  return violations[0];
}

// ── AG-7: aggregated response validation ─────────────────────────────────────

/** The verdict of {@link validateConsumerResponse} — valid, or a mediator-transform-error detail. */
export type ResponseValidation =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Validate the final consumer-shape response against the consumer operation's own
 * OpenAPI response schema (AG-7). A failure is a **mediator-side** defect — the caller
 * never receives the invalid body (AG-7.2). A collection payload validates per row
 * (the IR unwraps a top-level array to its item schema). When the operation declares
 * no response schema there is nothing to validate against, so the response is accepted.
 */
export function validateConsumerResponse(
  operation: IrOperation,
  value: JsonValue,
): ResponseValidation {
  const schema = operation.responseSchema;
  if (schema === undefined) {
    return { ok: true };
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const row = value[index];
      if (row === undefined) {
        continue;
      }
      const violations = validateAgainstSchema(schema, row);
      const first = violations[0];
      if (first !== undefined) {
        return { ok: false, detail: `row ${String(index)}: ${first}` };
      }
    }
    return { ok: true };
  }
  const violations = validateAgainstSchema(schema, value);
  const first = violations[0];
  return first === undefined ? { ok: true } : { ok: false, detail: first };
}
