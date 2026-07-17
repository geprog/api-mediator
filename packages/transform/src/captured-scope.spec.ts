import type { SourceScopeRef } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { extractCapturedScope } from "./captured-scope.js";

function confirmedRef(components: SourceScopeRef["components"]): SourceScopeRef {
  return { components, confirmedBy: "operator@example.test", confirmedAt: new Date() };
}

describe("extractCapturedScope (SS-7 crit 5)", () => {
  it("extracts a single-component captured scope by fieldPath (Vikunja project_id)", () => {
    const record = { id: 7, title: "Ship it", project_id: 42 };
    const ref = confirmedRef([{ key: "project", fieldPath: "project_id" }]);
    expect(extractCapturedScope(record, ref)).toStrictEqual({ project: 42 });
  });

  it("extracts a multi-component captured scope through nested field paths (Gitea owner + name)", () => {
    const record = {
      id: 3,
      title: "Bug",
      repository: { owner: "alice", name: "phoenix", full_name: "alice/phoenix", id: 12 },
    };
    const ref = confirmedRef([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ]);
    expect(extractCapturedScope(record, ref)).toStrictEqual({ owner: "alice", name: "phoenix" });
  });

  it("keys the map by the component KEY, not the leaf of the fieldPath", () => {
    // An operator-renamed component: key `container` reads `repository.owner`.
    const record = { repository: { owner: "alice" } };
    const ref = confirmedRef([{ key: "container", fieldPath: "repository.owner" }]);
    expect(extractCapturedScope(record, ref)).toStrictEqual({ container: "alice" });
  });

  it("OMITS a component whose fieldPath does not resolve (documented missing-field behavior)", () => {
    const record = { id: 7, repository: { owner: "alice" } };
    const ref = confirmedRef([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" }, // absent in the record
    ]);
    const captured = extractCapturedScope(record, ref);
    // Only the resolvable component is present; the missing one is omitted (not
    // null) so SS-8 can detect an incomplete scope by comparing key counts.
    expect(captured).toStrictEqual({ owner: "alice" });
    expect("name" in captured).toBe(false);
    expect(Object.keys(captured)).toHaveLength(1);
  });

  it("captures a present field holding JSON null (present != absent)", () => {
    const record = { project_id: null };
    const ref = confirmedRef([{ key: "project", fieldPath: "project_id" }]);
    const captured = extractCapturedScope(record, ref);
    expect("project" in captured).toBe(true);
    expect(captured["project"]).toBeNull();
  });

  it("omits a component whose path runs into a scalar mid-way (no fabrication)", () => {
    const record = { repository: "alice/phoenix" }; // a string, not an object
    const ref = confirmedRef([{ key: "owner", fieldPath: "repository.owner" }]);
    expect(extractCapturedScope(record, ref)).toStrictEqual({});
  });

  it("does not mutate the source record", () => {
    const record = { repository: { owner: "alice", name: "phoenix" } };
    const before = structuredClone(record);
    extractCapturedScope(record, confirmedRef([{ key: "owner", fieldPath: "repository.owner" }]));
    expect(record).toStrictEqual(before);
  });
});
