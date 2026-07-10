import { describe, expect, it } from "vitest";

import { type Ir, irSchema } from "./index.js";

/** A small but structurally complete IR exercising every modeled element. */
function sampleIr(): Ir {
  return [
    {
      resourceRef: "issues",
      name: "Issues",
      operations: [
        {
          operationId: "issueSearchIssues",
          method: "get",
          path: "/repos/{owner}/{repo}/issues",
          summary: "List a repository's issues",
          description: "Returns the issues of a repository.",
          parameters: [
            { name: "owner", location: "path", required: true, type: "string" },
            { name: "repo", location: "path", required: true, type: "string" },
            {
              name: "page",
              location: "query",
              required: false,
              type: "integer",
              description: "page number of results",
            },
          ],
          responseSchema: {
            name: "IssueList",
            fields: [{ name: "items", type: "array", required: true }],
          },
        },
        {
          operationId: "issueCreateIssue",
          method: "post",
          path: "/repos/{owner}/{repo}/issues",
          parameters: [{ name: "owner", location: "path", required: true }],
          requestSchema: {
            name: "CreateIssueOption",
            fields: [{ name: "title", type: "string", required: true }],
          },
          responseSchema: {
            name: "Issue",
            fields: [{ name: "id", type: "integer", required: true }],
          },
        },
      ],
      schemas: [
        {
          name: "Issue",
          fields: [
            { name: "id", type: "integer", description: "the native id", required: true },
            { name: "title", type: "string", required: true },
            { name: "updated_at", type: "string", required: false },
          ],
        },
      ],
      crossResourceRefs: [{ name: "Repository", fields: ["id", "name", "owner"] }],
    },
  ];
}

describe("Ir schema", () => {
  it("round-trips a hand-built IR unchanged", () => {
    const ir = sampleIr();
    const parsed = irSchema.parse(ir);
    expect(parsed).toEqual(ir);
  });

  it("accepts a resource group with no operations, schemas, or cross-refs", () => {
    const empty: Ir = [
      { resourceRef: "labels", name: "Labels", operations: [], schemas: [], crossResourceRefs: [] },
    ];
    expect(irSchema.safeParse(empty).success).toBe(true);
  });

  it("omits absent optional operation fields after parsing", () => {
    const [group] = irSchema.parse(sampleIr());
    const createOp = group?.operations[1];
    // The create operation declared no summary/description; absence is preserved.
    expect(createOp && "summary" in createOp).toBe(false);
    expect(createOp && "requestSchema" in createOp).toBe(true);
  });

  it("rejects an unknown HTTP method", () => {
    const bad = sampleIr();
    const badMethod = { ...bad[0]?.operations[0], method: "fetch" };
    const group = { ...bad[0], operations: [badMethod] };
    expect(irSchema.safeParse([group]).success).toBe(false);
  });

  it("rejects an operation missing its operationId", () => {
    const result = irSchema.safeParse([
      {
        resourceRef: "issues",
        name: "Issues",
        operations: [{ method: "get", path: "/x", parameters: [] }],
        schemas: [],
        crossResourceRefs: [],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a schema field with the wrong `required` type", () => {
    const result = irSchema.safeParse([
      {
        resourceRef: "issues",
        name: "Issues",
        operations: [],
        schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: "yes" }] }],
        crossResourceRefs: [],
      },
    ]);
    expect(result.success).toBe(false);
  });
});
