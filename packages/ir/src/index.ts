/**
 * `@mediator/ir` — the Spec Adapter seam's OpenAPI→IR builder.
 *
 * A pure, I/O-free shared-kernel package (no DB, no HTTP): it decomposes an
 * OpenAPI 3.0/3.1 document into the domain {@link Ir}, derives unconfirmed
 * {@link ResourceBinding}s by heuristic, and computes a deterministic content
 * hash. It depends only on `@mediator/domain` and `@redocly/openapi-core`.
 *
 * `SpecDiff` (additive/breaking classification between IR versions) is Phase 6
 * and deliberately not part of this slice.
 */

export { buildIr } from "./build-ir.js";
export { deriveResourceBindings } from "./resource-bindings.js";
export { computeContentHash } from "./content-hash.js";
export { IrError, SpecParseError, UnsupportedSpecVersionError } from "./errors.js";
