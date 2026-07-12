import { describe, expect, it } from "vitest";

import type { JsonRecord } from "./json.js";
import { pathSegments, readPath, SetPathError, setPath } from "./json.js";

describe("readPath", () => {
  const record: JsonRecord = {
    user: { firstName: "Ada", middle: null, tags: ["a", "b"] },
    count: 3,
  };

  it("reads a nested value as present", () => {
    expect(readPath(record, "user.firstName")).toEqual({ present: true, value: "Ada" });
  });

  it("distinguishes a present null from an absent path", () => {
    expect(readPath(record, "user.middle")).toEqual({ present: true, value: null });
    expect(readPath(record, "user.nope")).toEqual({ present: false });
  });

  it("reads array elements by numeric segment and reports out-of-range as absent", () => {
    expect(readPath(record, "user.tags.1")).toEqual({ present: true, value: "b" });
    expect(readPath(record, "user.tags.9")).toEqual({ present: false });
  });

  it("treats a scalar with remaining segments as absent", () => {
    expect(readPath(record, "count.value")).toEqual({ present: false });
  });

  it("refuses prototype-pollution keys, resolving them to absent", () => {
    expect(readPath(record, "__proto__.polluted")).toEqual({ present: false });
    expect(readPath(record, "constructor.name")).toEqual({ present: false });
  });
});

describe("setPath", () => {
  it("writes a nested value, minting intermediate objects", () => {
    const target: JsonRecord = {};
    setPath(target, "a.b.c", 5);
    expect(target).toEqual({ a: { b: { c: 5 } } });
  });

  it("writes multiple leaves into a shared parent", () => {
    const target: JsonRecord = {};
    setPath(target, "name.first", "Ada");
    setPath(target, "name.last", "Lovelace");
    expect(target).toEqual({ name: { first: "Ada", last: "Lovelace" } });
  });

  it("rejects forbidden prototype keys", () => {
    expect(() => {
      setPath({}, "__proto__.x", 1);
    }).toThrow(SetPathError);
  });

  it("rejects descending through a non-object collision", () => {
    const target: JsonRecord = { a: 1 };
    expect(() => {
      setPath(target, "a.b", 2);
    }).toThrow(SetPathError);
  });

  it("rejects an empty path", () => {
    expect(() => {
      setPath({}, "", 1);
    }).toThrow(SetPathError);
  });
});

describe("pathSegments", () => {
  it("splits on dots and drops empty segments", () => {
    expect(pathSegments("a.b.c")).toEqual(["a", "b", "c"]);
    expect(pathSegments("a..b.")).toEqual(["a", "b"]);
    expect(pathSegments("")).toEqual([]);
  });
});
