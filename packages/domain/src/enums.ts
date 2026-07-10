import { z } from "zod";

/**
 * Canonical domain enumerations for Phase 1.
 *
 * Each enum follows a single pattern so the Zod schema, the string-union TS
 * type, and the `as const` value object are all derived from **one** tuple of
 * literals — there is no place for the three to drift out of sync:
 *
 * ```ts
 * export const fooSchema = z.enum(["a", "b"]);      // runtime validator
 * export type Foo = z.infer<typeof fooSchema>;      // "a" | "b"
 * export const Foo = fooSchema.enum;                // { a: "a"; b: "b" }
 * ```
 *
 * The type and the value object deliberately share a name (`Foo`): TypeScript
 * keeps a type and a value in separate namespaces, so `Foo.a` (value) and
 * `Foo` (the union type) coexist — the "enum-as-const-object + derived union"
 * shape mandated by the project conventions.
 *
 * Literal spellings are taken **verbatim** from `docs/glossary.md` /
 * `docs/architecture/data-model.md` and must not be renamed.
 */

// ── RegisteredApp.status ─────────────────────────────────────────────────────

export const registeredAppStatusSchema = z.enum(["active", "disabled"]);
export type RegisteredAppStatus = z.infer<typeof registeredAppStatusSchema>;
export const RegisteredAppStatus = registeredAppStatusSchema.enum;

// ── ApiSpec.role ─────────────────────────────────────────────────────────────

export const apiSpecRoleSchema = z.enum(["PROVIDER", "CONSUMER"]);
export type ApiSpecRole = z.infer<typeof apiSpecRoleSchema>;
export const ApiSpecRole = apiSpecRoleSchema.enum;

// ── ApiSpec.status ───────────────────────────────────────────────────────────

/**
 * `superseded`/`archived` are only ever *set* in later phases (re-ingestion and
 * app deregistration respectively — see `docs/architecture/data-model.md`
 * `ApiSpec`); Phase 1 only ever creates `active` specs. The full enum is modeled
 * here so the single naming authority owns every value the column can hold.
 */
export const apiSpecStatusSchema = z.enum(["active", "superseded", "archived"]);
export type ApiSpecStatus = z.infer<typeof apiSpecStatusSchema>;
export const ApiSpecStatus = apiSpecStatusSchema.enum;

// ── Credential.type ──────────────────────────────────────────────────────────

/**
 * `adapterToken` is a **Phase-5** value (a consumer app's mediator-issued token,
 * stored as a salted hash rather than envelope-encrypted material — see
 * `docs/architecture/data-model.md` `Credential` and `docs/architecture/security.md`).
 * It is included here because the data model's enum includes it, but Phase-1
 * credential storage (`CredentialStore.store`, requirement CR-1 criterion 5)
 * rejects it — that rejection lives in the credential-store slice, not in this
 * types-only package.
 */
export const credentialTypeSchema = z.enum([
  "apiKey",
  "oauth2",
  "basicAuth",
  "adapterToken",
  "custom",
]);
export type CredentialType = z.infer<typeof credentialTypeSchema>;
export const CredentialType = credentialTypeSchema.enum;

// ── Exhaustiveness helper ────────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness guard for discriminated unions and enum switches.
 *
 * Placing an unhandled case into `assertNever` makes TypeScript fail the build
 * if a new enum value is added without a matching branch. At runtime it throws,
 * so an impossible value that slips past the type system is loud rather than
 * silently ignored.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
