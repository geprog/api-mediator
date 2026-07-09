/**
 * Placeholder entry point for the shared-kernel `@mediator/domain` package.
 *
 * Slice 1 only proves the typecheck + build + unit-test pipeline; the real
 * glossary entities (`ApprovedMapping`, `RecordLink`, `SyncFieldState`, …)
 * land in Phase 1. The exported helper carries an explicit return type so the
 * `@typescript-eslint/explicit-module-boundary-types` rule has something to
 * enforce.
 */
export const DOMAIN_PACKAGE = "domain" as const;

/**
 * Returns the package identifier. Exists purely to exercise the strict
 * toolchain (explicit return type on an exported function).
 */
export function domainPackageName(): typeof DOMAIN_PACKAGE {
  return DOMAIN_PACKAGE;
}
