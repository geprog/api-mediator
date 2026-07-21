import type { AdapterRequest, ServeRejectionReason } from "@mediator/adapter-engine";
import type { IrField, IrOperation, IrParameter, IrSchema } from "@mediator/domain";
import type { JsonValue } from "@mediator/transform";

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
 *    the composition never mapped (`mappedConsumerParamNames`), so it would be silently
 *    dropped; rejected instead (RP-2.4). An omitted **optional** mapped parameter is
 *    accepted — absence is not an error (RP-2.5).
 *
 * Undeclared transport headers are never consumer inputs and are ignored — only the
 * operation's declared parameters are checked. Union filter/sort/pagination rejections
 * (RP-2.2/2.3) belong to `collection-union`, out of this single-only slice's scope.
 */
export function validateInboundRequest(
  operation: IrOperation,
  request: AdapterRequest,
  mappedConsumerParamNames: ReadonlySet<string>,
): InboundValidation {
  const unmapped: string[] = [];
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
    if (supplied && !mappedConsumerParamNames.has(parameter.name)) {
      unmapped.push(parameter.name);
    }
  }

  const bodyViolation = validateRequestBody(operation, request.body);
  if (bodyViolation !== undefined) {
    return { ok: false, reason: "invalid-request", detail: bodyViolation };
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
