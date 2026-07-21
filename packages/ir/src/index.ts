/**
 * `@mediator/ir` — the Spec Adapter seam's OpenAPI→IR builder.
 *
 * An I/O-free shared-kernel package (no DB, no HTTP): it decomposes an OpenAPI
 * 3.0/3.1 document into the domain {@link Ir}, derives unconfirmed
 * {@link ResourceBinding}s by heuristic, and computes a deterministic content
 * hash. It depends only on `@mediator/domain` and `@redocly/openapi-core`.
 *
 * "I/O-free" rather than "pure": `buildIr` is async because Redocly's bundler
 * resolves refs asynchronously, and `deriveResourceBindings` mints a fresh
 * binding `id` via `crypto.randomUUID()` (non-deterministic, though not I/O).
 * `computeContentHash` and the decomposition itself are deterministic.
 *
 * `SpecDiff` (additive/breaking classification between IR versions) is Phase 6
 * and deliberately not part of this slice.
 */

export { buildIr } from "./build-ir.js";
export { deriveResourceBindings } from "./resource-bindings.js";
export { computeContentHash } from "./content-hash.js";
export { IrError, SpecParseError, UnsupportedSpecVersionError } from "./errors.js";
export {
  pausesDependentRules,
  revalidateResourceBinding,
  revalidateScopeCorrespondence,
} from "./scope-revalidation.js";
export type {
  BindingRefInvalidatedFinding,
  ContainerResourceRemovedFinding,
  ResourceBindingRevalidation,
  RevalidatableRefName,
  ScopeCorrespondenceRevalidation,
  ScopeCorrespondenceRevalidationInput,
  ScopeCorrespondenceSide,
  ScopeIdentityKeyInvalidatedFinding,
  ScopeLinkArchiveScope,
  ScopeParameterAddedFinding,
  ScopeParameterRemovedFinding,
  ScopeRevalidationFinding,
  SourceScopeRefInvalidatedFinding,
} from "./scope-revalidation.js";
