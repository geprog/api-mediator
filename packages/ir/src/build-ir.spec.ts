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
// via Redocly). NOTE: the Vikunja document tags tasks with the singular tag
// `task` (not `tasks`), so grouping by the document's tags yields the group
// `task` — see the package README/report for this fixture-naming detail.
let vikunjaIr: Ir;
let giteaIr: Ir;

beforeAll(async () => {
  vikunjaIr = await buildIr(loadJson(`${OAS3}/vikunja.trimmed.oas3.json`));
  giteaIr = await buildIr(loadJson(`${OAS3}/gitea.trimmed.oas3.json`));
});

describe("buildIr — resource grouping (SI-1 crit 2, 6, 7)", () => {
  it("groups Vikunja operations into distinct resource groups by document tags", () => {
    const refs = vikunjaIr.map((group) => group.resourceRef);
    expect(new Set(refs).size).toBe(refs.length); // distinct
    // The document tags include `labels` and `task` (singular) among others.
    expect(refs).toEqual(expect.arrayContaining(["labels", "task"]));
  });

  it("groups Gitea operations into resource groups including `issue`", () => {
    const refs = giteaIr.map((group) => group.resourceRef);
    expect(refs).toContain("issue");
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
  it("each Vikunja `task` operation carries method, path, parameters and an operationId", () => {
    const task = groupByRef(vikunjaIr, "task");
    expect(task.operations.length).toBeGreaterThan(0);
    for (const operation of task.operations) {
      expect(operation.operationId.length).toBeGreaterThan(0);
      expect(operation.method).toBeTypeOf("string");
      expect(operation.path.startsWith("/")).toBe(true);
      expect(Array.isArray(operation.parameters)).toBe(true);
    }
  });

  it("the param-free `GET /tasks` list carries the flattened task representation as its response", () => {
    const task = groupByRef(vikunjaIr, "task");
    const list = task.operations.find((op) => op.method === "get" && op.path === "/tasks");
    expect(list).toBeDefined();
    const fieldNames = list?.responseSchema?.fields.map((field) => field.name) ?? [];
    expect(fieldNames).toEqual(expect.arrayContaining(["id", "title", "updated"]));
  });
});

describe("buildIr — flattened schema fields (SI-1 crit 4)", () => {
  it("each field carries name, type, required-ness (description optional)", () => {
    const issue = groupByRef(giteaIr, "issue");
    const issueSchema = issue.schemas.find((schema) => schema.name === "Issue");
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
    const issue = groupByRef(giteaIr, "issue");
    expect(issue.crossResourceRefs.length).toBeGreaterThan(0);
    const expandedNames = new Set(issue.schemas.map((schema) => schema.name));
    for (const summary of issue.crossResourceRefs) {
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
    const document = {
      openapi: "3.0.0",
      info: { title: "dup", version: "1" },
      paths: {
        "/a": {
          get: { operationId: "dup", tags: ["thing"], responses: { "200": { description: "ok" } } },
        },
        "/b": {
          get: { operationId: "dup", tags: ["thing"], responses: { "200": { description: "ok" } } },
        },
      },
    };
    const ir = await buildIr(document);
    const thing = groupByRef(ir, "thing");
    expect(thing.operations.map((op) => op.operationId)).toEqual(["dup", "dup"]);
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

describe("buildIr — path-prefix fallback grouping (SI-1 crit 2, 6)", () => {
  // Every scenario operation carries a tag, so a tag-less synthetic document is
  // used to exercise the path-prefix fallback branch of resource grouping.
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

  it("groups tag-less operations by their first non-parameter path segment", async () => {
    const ir = await buildIr(untaggedSpec);
    expect(ir.map((group) => group.resourceRef)).toEqual(["widgets"]);
    const widgets = groupByRef(ir, "widgets");
    expect(widgets.operations.map((operation) => operation.path).sort()).toEqual([
      "/widgets",
      "/widgets/{id}",
    ]);
  });

  it("derives a stable resourceRef across re-parses of the same document", async () => {
    const first = await buildIr(untaggedSpec);
    const second = await buildIr(untaggedSpec);
    expect(first.map((group) => group.resourceRef)).toEqual(
      second.map((group) => group.resourceRef),
    );
    expect(first[0]?.resourceRef).toBe("widgets");
  });
});

describe("buildIr — domain schema conformance", () => {
  it("produces an IR that validates against the domain Ir Zod schema", () => {
    expect(() => irSchema.parse(vikunjaIr)).not.toThrow();
    expect(() => irSchema.parse(giteaIr)).not.toThrow();
  });
});
