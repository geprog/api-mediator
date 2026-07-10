/**
 * `@mediator/domain` — the shared kernel and single naming authority for the
 * API Mediator. Every glossary entity is defined here **once**, as a Zod schema
 * plus its inferred TypeScript type, so the whole system imports one vocabulary.
 *
 * This is a types-only, I/O-free package: no persistence, no HTTP, no OpenAPI
 * parsing (those slices import from here). Phase 1 covers registration + spec
 * ingestion entities and the IR; mapping/sync/adapter entities arrive in later
 * phases.
 */

export * from "./enums.js";
export * from "./exact-optional.js";
export * from "./ir.js";
export * from "./registered-app.js";
export * from "./api-spec.js";
export * from "./resource-binding.js";
export * from "./credential.js";
export * from "./events.js";
