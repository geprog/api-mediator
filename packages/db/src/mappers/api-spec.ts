import type { ApiSpec } from "@mediator/domain";

import { apiSpec } from "../schema.js";

/** A selected `api_spec` row, with Drizzle's inferred column types. */
export type ApiSpecRow = typeof apiSpec.$inferSelect;
/** The insert shape Drizzle expects for `api_spec`. */
export type ApiSpecInsert = typeof apiSpec.$inferInsert;

/**
 * Row → domain. `parsed_ir` / `raw_document` / `analysis_exclusions` round-trip
 * through `jsonb` (their `$type<...>` binding carries the domain shape); all
 * `ApiSpec` fields are required, so no optional-key handling is needed.
 */
export function mapApiSpecRow(row: ApiSpecRow): ApiSpec {
  return {
    id: row.id,
    appId: row.appId,
    role: row.role,
    rawDocument: row.rawDocument,
    parsedIR: row.parsedIr,
    analysisExclusions: row.analysisExclusions,
    version: row.version,
    contentHash: row.contentHash,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** Domain → insert. */
export function toApiSpecInsert(spec: ApiSpec): ApiSpecInsert {
  return {
    id: spec.id,
    appId: spec.appId,
    role: spec.role,
    rawDocument: spec.rawDocument,
    parsedIr: spec.parsedIR,
    analysisExclusions: spec.analysisExclusions,
    version: spec.version,
    contentHash: spec.contentHash,
    status: spec.status,
    createdAt: spec.createdAt,
  };
}
