import type { FieldMapping } from "@mediator/domain";
import {
  applyFieldMappings,
  isTransformError,
  type JsonRecord,
  type JsonValue,
} from "@mediator/transform";

/**
 * **TE-4 — response phase: backend response → consumer shape.** Applies **only** the
 * mapping's response-phase `FieldMapping`s (never an inversion of the request phase),
 * reusing the Phase-4 Transformation Executor unchanged. A collection body is mapped
 * per row. On a transform failure the result is a mediator-side defect, never a
 * partial/fabricated payload (TX-5).
 *
 * Per-row backend-native-id **provenance** (TE-4.3) is a `collection-union` dedup
 * concern (AG-3); a `single` endpoint never deduplicates, so provenance is not
 * captured here — deferred with AG-3/union, out of this slice's scope.
 */

export type ResponseMappingResult =
  | { readonly ok: true; readonly payload: JsonValue }
  | { readonly ok: false; readonly detail: string };

function isJsonRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Map a backend response body to the consumer shape via the response-phase field mappings. */
export function mapBackendResponseToConsumer(
  responsePhaseFieldMappings: readonly FieldMapping[],
  backendBody: JsonValue | undefined,
): ResponseMappingResult {
  if (responsePhaseFieldMappings.length === 0) {
    // No response-phase transform composed — the backend body is the consumer shape
    // as-is (the consumer-schema validation, AG-7, is the guard on whether it fits).
    return { ok: true, payload: backendBody ?? null };
  }

  if (Array.isArray(backendBody)) {
    const rows: JsonValue[] = [];
    for (let index = 0; index < backendBody.length; index += 1) {
      const row = backendBody[index];
      if (!isJsonRecord(row)) {
        return { ok: false, detail: `response row ${String(index)} is not an object` };
      }
      const mapped = applyRow(responsePhaseFieldMappings, row, index);
      if (!mapped.ok) {
        return mapped;
      }
      rows.push(mapped.value);
    }
    return { ok: true, payload: rows };
  }

  const source = isJsonRecord(backendBody) ? backendBody : {};
  try {
    return { ok: true, payload: applyFieldMappings(responsePhaseFieldMappings, source).output };
  } catch (error) {
    if (isTransformError(error)) {
      return { ok: false, detail: `response transform: ${error.kind}` };
    }
    throw error;
  }
}

function applyRow(
  fields: readonly FieldMapping[],
  row: JsonRecord,
  index: number,
):
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly detail: string } {
  try {
    return { ok: true, value: applyFieldMappings(fields, row).output };
  } catch (error) {
    if (isTransformError(error)) {
      return { ok: false, detail: `response row ${String(index)} transform: ${error.kind}` };
    }
    throw error;
  }
}
