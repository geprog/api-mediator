import { z } from "zod";

/**
 * The normalized **Intermediate Representation** (IR) — the protocol-agnostic
 * form every downstream component (mapping, sync, adapter) reasons over instead
 * of the raw OpenAPI document.
 *
 * The concrete JSON layout is implementation-defined; the concept fixes only
 * *what the IR must contain* (see `docs/architecture/mapping-engine.md`
 * "Spec decomposition" and requirement SI-1). This module models exactly the
 * elements that decomposition enumerates:
 *
 *   Ir  =  IrResourceGroup[]                          (resource groups)
 *     └── IrOperation[]      method, path, summary/description, parameters,
 *                            request schema, response schema, operationId
 *     └── IrSchema[]         the flattened component schemas the group references
 *     └── IrSchemaSummary[]  cross-resource references, as lightweight summaries
 *                            (schema name + top-level field list) — step 3
 *
 * This package is types-only: the `@mediator/ir` builder slice produces `Ir`
 * values and `@mediator/db` stores them via `jsonb.$type<Ir>()`. Keeping the IR
 * a plain JSON-serializable structure (no `Date`s, no branded ids) is what makes
 * that `jsonb` round-trip lossless.
 */

// ── Leaf enums (local to the IR) ─────────────────────────────────────────────

/** Lower-cased HTTP methods an operation can use. */
export const irHttpMethodSchema = z.enum([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);
export type IrHttpMethod = z.infer<typeof irHttpMethodSchema>;

/** Where an operation parameter lives, mirroring OpenAPI's `in`. */
export const irParameterLocationSchema = z.enum(["path", "query", "header", "cookie"]);
export type IrParameterLocation = z.infer<typeof irParameterLocationSchema>;

// ── Schema / field shape ─────────────────────────────────────────────────────

/**
 * One flattened field of a schema (SI-1 criterion 4): name, type,
 * required-ness, and an optional human `description`.
 */
export const irFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
});
export type IrField = z.infer<typeof irFieldSchema>;

/**
 * A flattened, named data schema (a component schema, or an operation's
 * request/response body). Its `fields` carry full detail; contrast with the
 * lightweight {@link IrSchemaSummary} used for cross-resource references.
 *
 * (The Zod validator is named `irSchemaSchema` — "the schema *for* an
 * `IrSchema`" — to keep the uniform `<type>Schema` validator convention; do not
 * confuse it with {@link irSchema}, the validator for the top-level {@link Ir}.)
 */
export const irSchemaSchema = z.object({
  name: z.string(),
  fields: z.array(irFieldSchema),
});
export type IrSchema = z.infer<typeof irSchemaSchema>;

/**
 * A cross-resource reference summary (decomposition step 3): a referenced
 * schema's name plus only its **top-level field names**, deliberately not
 * expanded, to bound the prompt size sent to the LLM in Phase 2.
 */
export const irSchemaSummarySchema = z.object({
  name: z.string(),
  fields: z.array(z.string()),
});
export type IrSchemaSummary = z.infer<typeof irSchemaSummarySchema>;

// ── Operations ───────────────────────────────────────────────────────────────

/**
 * One request input of an operation (path/query/header/cookie parameter).
 *
 * `enumValues` / `default` / `example` are the parameter's single-value **hints**
 * captured from its schema, when present. They let the resource-binding
 * derivation pre-fill a *heuristic candidate* for a scope path-parameter constant
 * (`ResourceBinding.scopePathBindings`, SS-2 criterion 2) — e.g. a `{tenant}`
 * path parameter whose schema pins `enum: ["acme"]` or `default: "acme"`. They
 * are additive metadata (absent when the spec declares none) and, like the rest
 * of the IR, carry no live payload values.
 */
export const irParameterSchema = z.object({
  name: z.string(),
  location: irParameterLocationSchema,
  required: z.boolean(),
  type: z.string().optional(),
  description: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  default: z.string().optional(),
  example: z.string().optional(),
});
export type IrParameter = z.infer<typeof irParameterSchema>;

/**
 * One operation of a resource group (SI-1 criterion 3).
 *
 * `operationId` is not guaranteed unique across a document — the scenario specs
 * contain duplicate `operationId`s (SI-1 criterion 8), which the builder
 * tolerates — so it is modeled as a plain string, never as a key. Request and
 * response bodies are embedded inline as {@link IrSchema}s so an operation is
 * self-contained for prompt building; both are absent when the operation has no
 * body of that kind.
 */
export const irOperationSchema = z.object({
  operationId: z.string(),
  method: irHttpMethodSchema,
  path: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  parameters: z.array(irParameterSchema),
  requestSchema: irSchemaSchema.optional(),
  responseSchema: irSchemaSchema.optional(),
});
export type IrOperation = z.infer<typeof irOperationSchema>;

// ── Resource groups & the root IR ────────────────────────────────────────────

/**
 * One resource-level IR unit: a spec's operations and schemas grouped by
 * OpenAPI `tags` (falling back to a path-prefix heuristic). Addressable by a
 * stable `resourceRef` — the same identifier `ResourceBinding.resourceRef` and
 * `ApiSpec.analysisExclusions` reference (SI-1 criterion 6).
 */
export const irResourceGroupSchema = z.object({
  resourceRef: z.string(),
  name: z.string(),
  operations: z.array(irOperationSchema),
  schemas: z.array(irSchemaSchema),
  crossResourceRefs: z.array(irSchemaSummarySchema),
});
export type IrResourceGroup = z.infer<typeof irResourceGroupSchema>;

/**
 * The whole IR of one `ApiSpec`: the list of its resource groups. Validator for
 * the root {@link Ir} — see the note on {@link irSchemaSchema} for why the two
 * names look similar.
 */
export const irSchema = z.array(irResourceGroupSchema);
export type Ir = z.infer<typeof irSchema>;
