import type { Ir } from "@mediator/domain";
import {
  BaseResolver,
  bundleFromString,
  createConfig,
  detectSpec,
  parseYaml,
  type Source,
} from "@redocly/openapi-core";

import { decomposeDocument } from "./decompose.js";
import { SpecParseError, UnsupportedSpecVersionError } from "./errors.js";
import { isRecord, type JsonObject } from "./json.js";

/**
 * A Redocly resolver that refuses **every external `$ref`** — no network, no
 * filesystem access during {@link buildIr}.
 *
 * Operator-submitted specs are untrusted input. Redocly's default
 * {@link BaseResolver} fetches external refs while bundling (`http(s)://…` via
 * `fetch`, `file`/relative paths via `fs.readFile`), which would let a submitted
 * document trigger outbound network or filesystem I/O from the mediator — an
 * SSRF-shaped risk, and at odds with the poll-only, no-surprise-egress posture
 * of `docs/architecture/security.md`. Overriding {@link loadExternalRef} to
 * reject *before* any I/O closes that hole: the bundler records a resolution
 * problem and leaves the external `$ref` unexpanded (IR decomposition then drops
 * it, since only local `#/…` pointers resolve). Local refs never reach this
 * method — they resolve against the already-parsed root document — so
 * `#/components/...` resolution keeps working unchanged.
 */
class NoExternalRefResolver extends BaseResolver {
  public override loadExternalRef(absoluteRef: string): Promise<Source> {
    return Promise.reject(
      new Error(
        `External $ref resolution is disabled (no network/filesystem egress during spec ingestion): ${absoluteRef}`,
      ),
    );
  }
}

/**
 * Parse, dereference, and decompose an OpenAPI **3.0 / 3.1** document into the
 * shared {@link Ir} (SI-1).
 *
 * Pipeline:
 * 1. Coerce the input to a document object (a JSON/YAML string is parsed).
 * 2. Detect the spec version via Redocly; reject anything that is not OpenAPI
 *    3.x (Swagger 2.0 throws {@link UnsupportedSpecVersionError}), and reject an
 *    unrecognizable document ({@link SpecParseError}, SI-1 crit 9).
 * 3. **Bundle** with `@redocly/openapi-core` (`dereference: false`) using a
 *    {@link NoExternalRefResolver}: local (`#/…`) refs are inlined; external
 *    (`http(s)`/`file`) refs are **never fetched** — they are left unexpanded
 *    with no network or filesystem access. Bundling is structural and lenient —
 *    it never runs schema validation, so Swagger-2.0-origin artifacts,
 *    strict-schema violations, and duplicate `operationId`s all pass through
 *    (SI-1 crit 8).
 * 4. Decompose the bundled document into the IR, resolving the local refs during
 *    flattening with cycle guards so no unresolved local `$ref` remains (SI-1
 *    crit 1); any leftover external `$ref` resolves to nothing and is dropped.
 *
 * Returns a `Promise` because Redocly's bundler is asynchronous; with external
 * resolution disabled, `buildIr` performs **no** network or filesystem I/O.
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
    const result = await bundleFromString({
      source,
      config,
      dereference: false,
      // Refuse external `$ref` fetches: no network/filesystem egress from an
      // operator-submitted spec (see NoExternalRefResolver).
      externalRefResolver: new NoExternalRefResolver(),
    });
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
