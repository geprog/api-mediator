import { describe, expect, it } from "vitest";

import { InvalidDatabaseUrlError, MissingDatabaseUrlError, resolveDatabaseUrl } from "./env.js";

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL when it is a valid postgres URL", () => {
    const url = "postgres://mediator:mediator@localhost:5432/api_mediator";

    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("accepts the postgresql:// protocol alias", () => {
    const url = "postgresql://mediator:mediator@localhost:5432/api_mediator";

    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("throws MissingDatabaseUrlError when DATABASE_URL is absent", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it("throws when DATABASE_URL is empty or whitespace-only", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "" })).toThrow(MissingDatabaseUrlError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "   " })).toThrow(MissingDatabaseUrlError);
  });

  it("throws InvalidDatabaseUrlError for a non-postgres URL (matching loadConfig)", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "mysql://localhost:3306/db" })).toThrow(
      InvalidDatabaseUrlError,
    );
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "not-a-url" })).toThrow(
      InvalidDatabaseUrlError,
    );
  });
});
