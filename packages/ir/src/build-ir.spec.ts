import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Ir, IrResourceGroup } from "@mediator/domain";
import { irSchema } from "@mediator/domain";
import { beforeAll, describe, expect, it } from "vitest";

import { buildIr } from "./build-ir.js";
import { SpecParseError, UnsupportedSpecVersionError } from "./errors.js";

function loadJson(relativePath: string): unknown {
  const url = new URL(`../../../${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

const OAS3 = "scenarios/scenario-1-small-overlap/specs/oas3";
const SWAGGER = "scenarios/scenario-1-small-overlap/specs/trimmed";

function groupByRef(ir: Ir, resourceRef: string): IrResourceGroup {
  const group = ir.find((candidate) => candidate.resourceRef === resourceRef);
  if (!group) throw new Error(`resource group '${resourceRef}' not found`);
  return group;
}

// The scenario-1 OAS3 conversions are the fixtures. Each spec is parsed once and
// the resulting IR reused across assertions (buildIr is async: it bundles/derefs
// via Redocly). Grouping is by the **path resource noun** (the last non-parameter
// path segment), which separates a spec's real resources into fine groups rather
// than collapsing dozens of operations under one coarse `tags` value — Gitea's
// `issue` tag alone spans 69 operations mixing issues/labels/comments/milestones.
let vikunjaIr: Ir;
let giteaIr: Ir;

beforeAll(async () => {
  vikunjaIr = await buildIr(loadJson(`${OAS3}/vikunja.trimmed.oas3.json`));
  giteaIr = await buildIr(loadJson(`${OAS3}/gitea.trimmed.oas3.json`));
});

describe("buildIr — resource grouping (SI-1 crit 2, 6, 7)", () => {
  it("groups Vikunja operations into finer resource groups by path resource noun", () => {
    const refs = vikunjaIr.map((group) => group.resourceRef);
    expect(new Set(refs).size).toBe(refs.length); // distinct
    // Separate tasks/labels/comments/projects groups, not one coarse tag blob.
    expect(refs).toEqual(expect.arrayContaining(["tasks", "labels", "comments", "projects"]));
  });

  it("splits Gitea's coarse `issue` tag into separate noun groups, with no giant blob", () => {
    const refs = giteaIr.map((group) => group.resourceRef);
    // The old tag grouping put 69 operations under a single `issue` group; noun
    // grouping separates the real resources into their own groups.
    expect(refs).toEqual(
      expect.arrayContaining(["issues", "comments", "labels", "milestones", "users"]),
    );
    expect(refs).not.toContain("issue");
    // No single group absorbs dozens of unrelated operations any more.
    const largest = Math.max(...giteaIr.map((group) => group.operations.length));
    expect(largest).toBeLessThan(20);
  });

  it("gives every group a stable resourceRef equal to its name", () => {
    for (const group of vikunjaIr) {
      expect(typeof group.resourceRef).toBe("string");
      expect(group.resourceRef.length).toBeGreaterThan(0);
      expect(group.name).toBe(group.resourceRef);
    }
  });
});

describe("buildIr — dereferencing (SI-1 crit 1)", () => {
  it("leaves no unresolved $ref anywhere in the IR", () => {
    expect(JSON.stringify(vikunjaIr)).not.toContain("$ref");
    expect(JSON.stringify(giteaIr)).not.toContain("$ref");
  });
});

describe("buildIr — operations (SI-1 crit 3)", () => {
  it("each Vikunja `tasks` operation carries method, path, parameters and an operationId", () => {
    const tasks = groupByRef(vikunjaIr, "tasks");
    expect(tasks.operations.length).toBeGreaterThan(0);
    for (const operation of tasks.operations) {
      expect(operation.operationId.length).toBeGreaterThan(0);
      expect(operation.method).toBeTypeOf("string");
      expect(operation.path.startsWith("/")).toBe(true);
      expect(Array.isArray(operation.parameters)).toBe(true);
    }
  });

  it("the param-free `GET /tasks` list carries the flattened task representation as its response", () => {
    const tasks = groupByRef(vikunjaIr, "tasks");
    const list = tasks.operations.find((op) => op.method === "get" && op.path === "/tasks");
    expect(list).toBeDefined();
    const fieldNames = list?.responseSchema?.fields.map((field) => field.name) ?? [];
    expect(fieldNames).toEqual(expect.arrayContaining(["id", "title", "updated"]));
  });
});

describe("buildIr — flattened schema fields (SI-1 crit 4)", () => {
  it("each field carries name, type, required-ness (description optional)", () => {
    const issues = groupByRef(giteaIr, "issues");
    const issueSchema = issues.schemas.find((schema) => schema.name === "Issue");
    expect(issueSchema).toBeDefined();
    const fields = issueSchema?.fields ?? [];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field.name).toBeTypeOf("string");
      expect(field.type).toBeTypeOf("string");
      expect(field.required).toBeTypeOf("boolean");
      if ("description" in field) expect(field.description).toBeTypeOf("string");
    }
    const idField = fields.find((field) => field.name === "id");
    expect(idField?.type).toBe("integer");
  });
});

describe("buildIr — cross-resource summaries (SI-1 crit 5)", () => {
  it("references to another resource's schema are lightweight summaries, not expanded", () => {
    const issues = groupByRef(giteaIr, "issues");
    expect(issues.crossResourceRefs.length).toBeGreaterThan(0);
    const expandedNames = new Set(issues.schemas.map((schema) => schema.name));
    for (const summary of issues.crossResourceRefs) {
      expect(summary.name).toBeTypeOf("string");
      // fields are top-level names only (a string[]), never expanded IrFields.
      expect(Array.isArray(summary.fields)).toBe(true);
      for (const fieldName of summary.fields) expect(fieldName).toBeTypeOf("string");
      // a summarized (cross-resource) schema is never also fully expanded here.
      expect(expandedNames.has(summary.name)).toBe(false);
    }
  });
});

describe("buildIr — leniency (SI-1 crit 8)", () => {
  it("builds the Swagger-2.0-origin, operationId-less Vikunja conversion without aborting", () => {
    expect(vikunjaIr.length).toBeGreaterThan(0);
  });

  it("tolerates duplicate operationIds without throwing", async () => {
    // Both operations share the resource noun `things`, so they land in one group
    // and their (duplicate) operationIds are preserved verbatim.
    const document = {
      openapi: "3.0.0",
      info: { title: "dup", version: "1" },
      paths: {
        "/things": {
          get: { operationId: "dup", tags: ["thing"], responses: { "200": { description: "ok" } } },
        },
        "/things/{id}": {
          get: { operationId: "dup", tags: ["thing"], responses: { "200": { description: "ok" } } },
        },
      },
    };
    const ir = await buildIr(document);
    const things = groupByRef(ir, "things");
    expect(things.operations.map((op) => op.operationId)).toEqual(["dup", "dup"]);
  });
});

describe("buildIr — error cases (SI-1 crit 9 + version gate)", () => {
  it("throws SpecParseError on a non-OpenAPI blob", async () => {
    await expect(buildIr({ hello: "world" })).rejects.toBeInstanceOf(SpecParseError);
  });

  it("throws UnsupportedSpecVersionError (OpenAPI 3.x required) on a Swagger 2.0 document", async () => {
    const swagger = loadJson(`${SWAGGER}/gitea.trimmed.swagger.json`);
    await expect(buildIr(swagger)).rejects.toBeInstanceOf(UnsupportedSpecVersionError);
    await expect(buildIr(swagger)).rejects.toThrow(/OpenAPI 3\.x/);
  });
});

describe("buildIr — noun grouping, action merge & fallback (SI-1 crit 2, 6)", () => {
  // A tag-less spec exercised via its path resource nouns.
  const untaggedSpec = {
    openapi: "3.0.0",
    info: { title: "untagged", version: "1" },
    paths: {
      "/widgets/{id}": {
        get: { operationId: "getWidget", responses: { "200": { description: "ok" } } },
      },
      "/widgets": {
        get: { operationId: "listWidgets", responses: { "200": { description: "ok" } } },
      },
    },
  };

  it("groups operations by their path resource noun (collection + item read together)", async () => {
    const ir = await buildIr(untaggedSpec);
    expect(ir.map((group) => group.resourceRef)).toEqual(["widgets"]);
    const widgets = groupByRef(ir, "widgets");
    expect(widgets.operations.map((operation) => operation.path).sort()).toEqual([
      "/widgets",
      "/widgets/{id}",
    ]);
  });

  it("merges an action sub-path (POST .../{id}/lock) into its parent resource", async () => {
    // `lock` hangs off an issue item as a single write verb: no collection-list
    // GET, so it is an action and merges into its parent noun `issues`.
    const spec = {
      openapi: "3.0.0",
      info: { title: "issues", version: "1" },
      paths: {
        "/issues": {
          get: { operationId: "listIssues", responses: { "200": { description: "ok" } } },
        },
        "/issues/{id}": {
          get: { operationId: "getIssue", responses: { "200": { description: "ok" } } },
        },
        "/issues/{id}/lock": {
          post: { operationId: "lockIssue", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const ir = await buildIr(spec);
    expect(ir.map((group) => group.resourceRef)).toEqual(["issues"]);
    const issues = groupByRef(ir, "issues");
    expect(issues.operations.map((op) => op.operationId)).toEqual(
      expect.arrayContaining(["listIssues", "getIssue", "lockIssue"]),
    );
    // the action did not spawn its own `lock` group.
    expect(ir.some((group) => group.resourceRef === "lock")).toBe(false);
  });

  it("falls back to tag / path-prefix grouping when a path has no usable noun", async () => {
    // `POST /` has no noun → falls back to its tag (`rpc`); `GET /{id}` has
    // neither a noun nor a tag → the `default` bucket. Neither odd path crashes.
    const spec = {
      openapi: "3.0.0",
      info: { title: "rpc", version: "1" },
      paths: {
        "/": {
          post: {
            operationId: "invoke",
            tags: ["rpc"],
            responses: { "200": { description: "ok" } },
          },
        },
        "/{id}": {
          get: { operationId: "readRoot", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const ir = await buildIr(spec);
    expect(ir.map((group) => group.resourceRef)).toEqual(
      expect.arrayContaining(["rpc", "default"]),
    );
  });

  it("derives a stable resourceRef across re-parses of the same document", async () => {
    const first = await buildIr(untaggedSpec);
    const second = await buildIr(untaggedSpec);
    expect(first.map((group) => group.resourceRef)).toEqual(
      second.map((group) => group.resourceRef),
    );
    expect(first[0]?.resourceRef).toBe("widgets");
  });

  it("keeps Gitea's resourceRefs stable across two buildIr calls", async () => {
    const again = await buildIr(loadJson(`${OAS3}/gitea.trimmed.oas3.json`));
    expect(again.map((group) => group.resourceRef)).toEqual(
      giteaIr.map((group) => group.resourceRef),
    );
  });
});

describe("buildIr — parameter single-value hints (feeds SS-2 scope-constant candidates)", () => {
  it("captures a path parameter's enum / default / example onto the IR parameter", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "tenants", version: "1" },
      paths: {
        "/tenants/{tenant}/things": {
          get: {
            operationId: "listThings",
            parameters: [
              {
                name: "tenant",
                in: "path",
                required: true,
                schema: { type: "string", enum: ["acme"], default: "acme" },
                example: "acme",
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const ir = await buildIr(spec);
    const things = groupByRef(ir, "things");
    const operation = things.operations.find((op) => op.operationId === "listThings");
    const tenant = operation?.parameters.find((parameter) => parameter.name === "tenant");
    expect(tenant?.enumValues).toStrictEqual(["acme"]);
    expect(tenant?.default).toBe("acme");
    expect(tenant?.example).toBe("acme");
  });

  it("omits the hints when a parameter declares none (they stay absent, not present-undefined)", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "tenants", version: "1" },
      paths: {
        "/tenants/{tenant}/things": {
          get: {
            operationId: "listThings",
            parameters: [
              { name: "tenant", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const ir = await buildIr(spec);
    const operation = groupByRef(ir, "things").operations[0];
    const tenant = operation?.parameters.find((parameter) => parameter.name === "tenant");
    expect(tenant && "enumValues" in tenant).toBe(false);
    expect(tenant && "default" in tenant).toBe(false);
    expect(tenant && "example" in tenant).toBe(false);
  });
});

describe("buildIr — domain schema conformance", () => {
  it("produces an IR that validates against the domain Ir Zod schema", () => {
    expect(() => irSchema.parse(vikunjaIr)).not.toThrow();
    expect(() => irSchema.parse(giteaIr)).not.toThrow();
  });
});
