import { describe, expect, it } from "vitest";

import { MissingDatabaseUrlError, resolveDatabaseUrl } from "./env.js";

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL when it is present", () => {
    const url = "postgres://mediator:mediator@localhost:5432/api_mediator";

    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("throws MissingDatabaseUrlError when DATABASE_URL is absent", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it("throws when DATABASE_URL is empty or whitespace-only", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "" })).toThrow(MissingDatabaseUrlError);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "   " })).toThrow(MissingDatabaseUrlError);
  });
});
