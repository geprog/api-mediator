import { describe, expect, it } from "vitest";

import { stripUndefined, type WithoutUndefined } from "./exact-optional.js";

describe("stripUndefined", () => {
  it("omits keys whose value is undefined, leaving them absent (not present-undefined)", () => {
    const result = stripUndefined({ a: 1, b: undefined, c: "keep" });

    expect(result).toEqual({ a: 1, c: "keep" });
    expect("b" in result).toBe(false);
    expect(Object.keys(result)).toStrictEqual(["a", "c"]);
  });

  it("keeps a present null value (null is a defined value, unlike undefined)", () => {
    const result = stripUndefined({ confirmedBy: null, confirmedAt: undefined });

    expect("confirmedBy" in result).toBe(true);
    expect(result.confirmedBy).toBeNull();
    expect("confirmedAt" in result).toBe(false);
  });

  it("returns a copy, never mutating the input", () => {
    const input = { a: 1, b: undefined };
    const result = stripUndefined(input);

    expect(result).not.toBe(input);
    expect("b" in input).toBe(true);
  });

  it("narrows an undefined-bearing key to a truly optional key (compile-time)", () => {
    type Source = { id: string; baseUrl: string | undefined };
    // The result type makes `baseUrl` optional-without-undefined, so it is
    // assignable to an `exactOptionalPropertyTypes` target that omits the key.
    type Result = WithoutUndefined<Source>;
    const absent: Result = stripUndefined<Source>({ id: "x", baseUrl: undefined });
    const present: Result = { id: "y", baseUrl: "https://example.test" };

    expect("baseUrl" in absent).toBe(false);
    expect(present.baseUrl).toBe("https://example.test");
  });
});
