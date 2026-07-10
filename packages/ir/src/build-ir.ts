import type { Ir } from "@mediator/domain";
import { bundleFromString, createConfig, detectSpec, parseYaml } from "@redocly/openapi-core";

import { decomposeDocument } from "./decompose.js";
import { SpecParseError, UnsupportedSpecVersionError } from "./errors.js";
import { isRecord, type JsonObject } from "./json.js";

/**
 * Parse, dereference, and decompose an OpenAPI **3.0 / 3.1** document into the
 * shared {@link Ir} (SI-1).
 *
 * Pipeline:
 * 1. Coerce the input to a document object (a JSON/YAML string is parsed).
 * 2. Detect the spec version via Redocly; reject anything that is not OpenAPI
 *    3.x (Swagger 2.0 throws {@link UnsupportedSpecVersionError}), and reject an
 *    unrecognizable document ({@link SpecParseError}, SI-1 crit 9).
 * 3. **Bundle** with `@redocly/openapi-core` (`dereference: false`): external
 *    refs are inlined and every `$ref` becomes a resolvable local `#/…` pointer.
 *    Bundling is structural and lenient — it never runs schema validation, so
 *    Swagger-2.0-origin artifacts, strict-schema violations, and duplicate
 *    `operationId`s all pass through (SI-1 crit 8).
 * 4. Decompose the bundled document into the IR, resolving the local refs during
 *    flattening with cycle guards so no unresolved `$ref` remains (SI-1 crit 1).
 *
 * Returns a `Promise` because Redocly's resolver/bundler is asynchronous
 * (external-ref resolution is I/O); the scenario fixtures are self-contained, so
 * no network or filesystem access occurs for them.
 *
 * @throws {SpecParseError} the input is not a recognizable/parseable OpenAPI doc.
 * @throws {UnsupportedSpecVersionError} the input is a spec but not OpenAPI 3.x.
 */
export async function buildIr(document: unknown): Promise<Ir> {
  const parsed = coerceToDocument(document);
  assertOpenApi3(parsed);
  const bundled = await bundle(document, parsed);
  return decomposeDocument(bundled);
}

function coerceToDocument(document: unknown): JsonObject {
  if (typeof document === "string") {
    let value: unknown;
    try {
      value = parseYaml(document);
    } catch (error) {
      throw new SpecParseError(`Document is not valid JSON/YAML: ${messageOf(error)}`, error);
    }
    if (!isRecord(value)) {
      throw new SpecParseError("Document must be a JSON/YAML object at its root.");
    }
    return value;
  }
  if (isRecord(document)) return document;
  throw new SpecParseError("Document must be an object or a JSON/YAML string.");
}

function assertOpenApi3(document: JsonObject): void {
  let specVersion: string;
  try {
    specVersion = detectSpec(document);
  } catch (error) {
    throw new SpecParseError(`Not a recognizable OpenAPI document: ${messageOf(error)}`, error);
  }
  if (specVersion === "oas2") {
    throw new UnsupportedSpecVersionError(
      "OpenAPI 3.x required: received a Swagger/OpenAPI 2.0 document. " +
        "Native 2.0 ingestion is out of scope — convert the document to OpenAPI 3.x first.",
    );
  }
  if (!specVersion.startsWith("oas3")) {
    throw new UnsupportedSpecVersionError(
      `OpenAPI 3.x required: received a '${specVersion}' document.`,
    );
  }
}

async function bundle(original: unknown, parsed: JsonObject): Promise<JsonObject> {
  const source = typeof original === "string" ? original : JSON.stringify(parsed);
  const config = await createConfig({});
  let bundled: unknown;
  try {
    const result = await bundleFromString({ source, config, dereference: false });
    bundled = result.bundle.parsed;
  } catch (error) {
    throw new SpecParseError(`Failed to parse/bundle OpenAPI document: ${messageOf(error)}`, error);
  }
  if (!isRecord(bundled)) {
    throw new SpecParseError("Bundled OpenAPI document is not an object.");
  }
  return bundled;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
