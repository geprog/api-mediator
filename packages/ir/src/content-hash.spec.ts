import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeContentHash } from "./content-hash.js";
import { isRecord } from "./json.js";

function loadOas3(name: string): unknown {
  const url = new URL(
    `../../../scenarios/scenario-1-small-overlap/specs/oas3/${name}`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("computeContentHash (SI-2 crit 2, 3)", () => {
  it("is deterministic: a byte-identical document hashes equal", () => {
    const first = loadOas3("vikunja.trimmed.oas3.json");
    const second = loadOas3("vikunja.trimmed.oas3.json");
    expect(computeContentHash(first)).toBe(computeContentHash(second));
  });

  it("is a stable hex SHA-256 digest", () => {
    const hash = computeContentHash(loadOas3("gitea.trimmed.oas3.json"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is sensitive: a materially changed field changes the hash", () => {
    const original = loadOas3("vikunja.trimmed.oas3.json");
    expect(isRecord(original)).toBe(true);
    if (!isRecord(original)) return;
    const mutated = { ...original, info: { title: "changed-title" } };
    expect(computeContentHash(original)).not.toBe(computeContentHash(mutated));
  });

  it("distinguishes two materially different documents", () => {
    expect(computeContentHash(loadOas3("gitea.trimmed.oas3.json"))).not.toBe(
      computeContentHash(loadOas3("vikunja.trimmed.oas3.json")),
    );
  });

  it("is independent of object key ordering (canonicalized)", () => {
    expect(computeContentHash({ a: 1, b: 2 })).toBe(computeContentHash({ b: 2, a: 1 }));
  });

  it("treats a nested reordering as equal but a value change as different", () => {
    const base = { paths: { "/a": { get: { x: 1 } } }, info: { title: "t" } };
    const reordered = { info: { title: "t" }, paths: { "/a": { get: { x: 1 } } } };
    const changed = { info: { title: "t" }, paths: { "/a": { get: { x: 2 } } } };
    expect(computeContentHash(base)).toBe(computeContentHash(reordered));
    expect(computeContentHash(base)).not.toBe(computeContentHash(changed));
  });
});
