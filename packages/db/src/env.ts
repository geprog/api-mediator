import { isPostgresConnectionUrl, POSTGRES_URL_MESSAGE } from "@mediator/config";

/** Thrown by {@link resolveDatabaseUrl} when `DATABASE_URL` is absent or blank. */
export class MissingDatabaseUrlError extends Error {
  public constructor() {
    super(
      "DATABASE_URL is not set. Export it, or add it to the repo-root .env, before running db migrations or the db integration tests.",
    );
    this.name = "MissingDatabaseUrlError";
  }
}

/** Thrown by {@link resolveDatabaseUrl} when `DATABASE_URL` is set but malformed. */
export class InvalidDatabaseUrlError extends Error {
  public constructor() {
    super(`DATABASE_URL ${POSTGRES_URL_MESSAGE}.`);
    this.name = "InvalidDatabaseUrlError";
  }
}

/**
 * Read and validate a `DATABASE_URL` out of an injected environment.
 *
 * The environment is passed in (mirroring `@mediator/config`'s `loadConfig`) so
 * this helper is pure and unit-testable, and so the library core never reaches
 * for `process.env` on its own — only the CLI entrypoints do. It reuses
 * `@mediator/config`'s {@link isPostgresConnectionUrl} so the migrate CLI and the
 * app's `loadConfig` accept/reject exactly the same URLs (importing the predicate
 * does not trigger the full env validation).
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new MissingDatabaseUrlError();
  }
  if (!isPostgresConnectionUrl(url)) {
    throw new InvalidDatabaseUrlError();
  }
  return url;
}
