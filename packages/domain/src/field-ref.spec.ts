import { describe, expect, it } from "vitest";

import {
  type FieldRef,
  fieldResourceRef,
  parseFieldRef,
  recordRelativePath,
  serializeFieldRef,
} from "./index.js";

/** The shapes a real approval stores: a flat field, a nested one, a dotted leaf. */
const REFS: readonly FieldRef[] = [
  { resourceRef: "issues", path: "title" },
  { resourceRef: "issues", path: "body" },
  { resourceRef: "tasks", path: "description" },
  { resourceRef: "issues", path: "assignee.name" },
  { resourceRef: "users", path: "profile.contact.email" },
];

describe("serializeFieldRef / parseFieldRef round trip", () => {
  it.each(REFS)("round-trips $resourceRef / $path", (ref) => {
    expect(parseFieldRef(serializeFieldRef(ref))).toEqual(ref);
  });

  it("serializes into the resourceRef/path form the approval stores", () => {
    expect(serializeFieldRef({ resourceRef: "issues", path: "title" })).toBe("issues/title");
    expect(serializeFieldRef({ resourceRef: "tasks", path: "assignee.name" })).toBe(
      "tasks/assignee.name",
    );
  });

  it("splits on the first slash, so a resourceRef never swallows a dotted path", () => {
    expect(parseFieldRef("issues/assignee.name")).toEqual({
      resourceRef: "issues",
      path: "assignee.name",
    });
  });

  it("returns undefined for an unqualified or degenerate ref", () => {
    expect(parseFieldRef("title")).toBeUndefined();
    expect(parseFieldRef("")).toBeUndefined();
    expect(parseFieldRef("/title")).toBeUndefined();
    expect(parseFieldRef("issues/")).toBeUndefined();
  });
});

describe("recordRelativePath", () => {
  // The regression this whole slice exists for: a stored, resource-qualified path
  // must reduce to the bare key live payload JSON actually carries. `pathSegments`
  // splits on `.` only, so an unreduced `issues/title` is a single literal segment
  // that no record has — the ABSENT read behind `transform error: missing-input`,
  // the "no target match" duplicate-creation, and the literal payload key.
  it("strips the resource qualification a real approval stores", () => {
    expect(recordRelativePath("issues/title")).toBe("title");
    expect(recordRelativePath("tasks/description")).toBe("description");
    expect(recordRelativePath("issues/assignee.name")).toBe("assignee.name");
  });

  it("passes an already-bare path through unchanged", () => {
    expect(recordRelativePath("title")).toBe("title");
    expect(recordRelativePath("assignee.name")).toBe("assignee.name");
  });

  it("is idempotent — reducing an already-reduced path is a no-op", () => {
    expect(recordRelativePath(recordRelativePath("issues/title"))).toBe("title");
  });
});

describe("fieldResourceRef", () => {
  it("yields the resource group a qualified path belongs to", () => {
    expect(fieldResourceRef("issues/title")).toBe("issues");
    expect(fieldResourceRef("users/profile.contact.email")).toBe("users");
  });

  it("is undefined for an unqualified path", () => {
    expect(fieldResourceRef("title")).toBeUndefined();
  });
});
