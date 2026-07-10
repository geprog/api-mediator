import { openApiDocumentSchema } from "@mediator/contracts";

/**
 * Read an uploaded OpenAPI file into the JSON object the registration/preview
 * requests carry (`RegisterSpecRequest.document`). Phase 1 accepts **JSON**
 * OpenAPI documents only — the vendored scenario specs are JSON, and supporting
 * YAML would pull in a YAML parser dependency this slice does not need.
 *
 * The parsed value is validated against `openApiDocumentSchema` (the same
 * `Record<string, unknown>` shape the backend expects), so a JSON array or scalar
 * is rejected here with a clear message rather than failing opaquely server-side.
 * This does not validate that the document is a *well-formed OpenAPI spec* — the
 * backend's `buildIr` owns that and reports it as a 400.
 */
export async function readOpenApiDocument(file: File): Promise<Record<string, unknown>> {
  const text = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`"${file.name}" is not valid JSON. Upload an OpenAPI document in JSON format.`);
  }

  const result = openApiDocumentSchema.safeParse(parsed);
  if (!result.success || Array.isArray(parsed)) {
    throw new Error(
      `"${file.name}" is not a JSON object; an OpenAPI document must be a top-level JSON object.`,
    );
  }
  return result.data;
}
