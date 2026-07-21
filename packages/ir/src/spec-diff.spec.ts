import type {
  Ir,
  IrField,
  IrOperation,
  IrParameter,
  IrResourceGroup,
  IrSchema,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { diffSpec, type SpecChange, type SpecChangeKind } from "./spec-diff.js";

/**
 * SL-1.2/1.3/1.4 — unit coverage of the pure `diffSpec` classification. Every fixture
 * is a **hand-built IR** (never a parsed OpenAPI document), which is itself the
 * protocol-agnostic proof (SL-1.4): the diff reasons only over the shared IR types.
 */

// ── IR builders ────────────────────────────────────────────────────────────────

function field(name: string, type: string, required: boolean): IrField {
  return { name, type, required };
}

function schema(name: string, fields: readonly IrField[]): IrSchema {
  return { name, fields: [...fields] };
}

function param(overrides: Partial<IrParameter> & Pick<IrParameter, "name">): IrParameter {
  return { location: "query", required: false, ...overrides };
}

function op(overrides: Partial<IrOperation> & Pick<IrOperation, "operationId">): IrOperation {
  return {
    method: "get",
    path: `/things`,
    parameters: [],
    ...overrides,
  };
}

function group(
  overrides: Partial<IrResourceGroup> & Pick<IrResourceGroup, "resourceRef">,
): IrResourceGroup {
  return {
    name: overrides.resourceRef,
    operations: [],
    schemas: [],
    crossResourceRefs: [],
    ...overrides,
  };
}

/** A one-resource IR whose `things` group carries the given operations + schemas. */
function ir(parts: { operations?: IrOperation[]; schemas?: IrSchema[] } = {}): Ir {
  return [
    group({
      resourceRef: "things",
      operations: parts.operations ?? [],
      schemas: parts.schemas ?? [],
    }),
  ];
}

function kinds(changes: readonly SpecChange[]): SpecChangeKind[] {
  return changes.map((change) => change.kind);
}

function ofKind(changes: readonly SpecChange[], kind: SpecChangeKind): SpecChange[] {
  return changes.filter((change) => change.kind === kind);
}

// ── No structural change ─────────────────────────────────────────────────────

describe("diffSpec — structurally identical", () => {
  it("classifies identical IR as additive with no changes", () => {
    const one = ir({
      operations: [op({ operationId: "listThings" })],
      schemas: [schema("Thing", [field("id", "integer", true)])],
    });
    const diff = diffSpec(one, structuredClone(one));
    expect(diff.classification).toBe("additive");
    expect(diff.changes).toHaveLength(0);
  });

  it("ignores a description-only change (no structural entry, additive)", () => {
    const before = ir({ operations: [op({ operationId: "listThings", summary: "old" })] });
    const after = ir({
      operations: [op({ operationId: "listThings", summary: "brand new copy" })],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("additive");
    expect(diff.changes).toHaveLength(0);
  });
});

// ── Resource groups ──────────────────────────────────────────────────────────

describe("diffSpec — resource groups", () => {
  it("classifies a new resource group as additive", () => {
    const before: Ir = [group({ resourceRef: "things" })];
    const after: Ir = [group({ resourceRef: "things" }), group({ resourceRef: "widgets" })];
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("additive");
    expect(kinds(diff.changes)).toEqual(["resource-group-added"]);
    expect(diff.changes[0]?.location).toEqual({ level: "resource", resourceRef: "widgets" });
  });

  it("classifies a removed resource group as breaking", () => {
    const before: Ir = [group({ resourceRef: "things" }), group({ resourceRef: "widgets" })];
    const after: Ir = [group({ resourceRef: "things" })];
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["resource-group-removed"]);
    expect(diff.changes[0]?.location).toEqual({ level: "resource", resourceRef: "widgets" });
  });
});

// ── Operations ──────────────────────────────────────────────────────────────

describe("diffSpec — operations", () => {
  it("classifies a new operation as additive with operation locality", () => {
    const before = ir({ operations: [op({ operationId: "listThings" })] });
    const after = ir({
      operations: [
        op({ operationId: "listThings" }),
        op({ operationId: "createThing", method: "post" }),
      ],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("additive");
    expect(kinds(diff.changes)).toEqual(["operation-added"]);
    expect(diff.changes[0]?.location).toEqual({
      level: "operation",
      resourceRef: "things",
      operationId: "createThing",
    });
  });

  it("classifies a removed operation as breaking", () => {
    const before = ir({
      operations: [op({ operationId: "listThings" }), op({ operationId: "getThing" })],
    });
    const after = ir({ operations: [op({ operationId: "listThings" })] });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["operation-removed"]);
    expect(diff.changes[0]?.location).toMatchObject({ operationId: "getThing" });
  });

  it("classifies a method/path change under a stable operationId as breaking", () => {
    const before = ir({
      operations: [op({ operationId: "getThing", method: "get", path: "/things/{id}" })],
    });
    const after = ir({
      operations: [op({ operationId: "getThing", method: "get", path: "/items/{id}" })],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["operation-signature-changed"]);
  });

  it("treats an un-pairable duplicate operationId whose signatures changed as breaking (conservative)", () => {
    const before = ir({
      operations: [
        op({ operationId: "dup", method: "get", path: "/a" }),
        op({ operationId: "dup", method: "get", path: "/b" }),
      ],
    });
    const after = ir({
      operations: [
        op({ operationId: "dup", method: "get", path: "/a" }),
        op({ operationId: "dup", method: "get", path: "/c" }),
      ],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["operation-ambiguous"]);
  });

  it("reports no change for an unchanged duplicate operationId bucket", () => {
    const dup = ir({
      operations: [
        op({ operationId: "dup", method: "get", path: "/a" }),
        op({ operationId: "dup", method: "get", path: "/b" }),
      ],
    });
    const diff = diffSpec(dup, structuredClone(dup));
    expect(diff.changes).toHaveLength(0);
    expect(diff.classification).toBe("additive");
  });
});

// ── Parameters ────────────────────────────────────────────────────────────────

describe("diffSpec — parameters", () => {
  const base = (params: IrParameter[]): Ir =>
    ir({ operations: [op({ operationId: "listThings", parameters: params })] });

  it("classifies a new optional parameter as additive", () => {
    const diff = diffSpec(base([]), base([param({ name: "page" })]));
    expect(diff.classification).toBe("additive");
    expect(kinds(diff.changes)).toEqual(["parameter-added"]);
    expect(diff.changes[0]?.location).toEqual({
      level: "parameter",
      resourceRef: "things",
      operationId: "listThings",
      parameterName: "page",
      parameterLocation: "query",
    });
  });

  it("classifies a new required parameter as breaking (conservative)", () => {
    const diff = diffSpec(
      base([]),
      base([param({ name: "tenant", location: "path", required: true })]),
    );
    expect(diff.classification).toBe("breaking");
    expect(ofKind(diff.changes, "parameter-added")[0]?.classification).toBe("breaking");
  });

  it("classifies a removed parameter as breaking", () => {
    const diff = diffSpec(base([param({ name: "page" })]), base([]));
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["parameter-removed"]);
  });

  it("classifies a parameter type change as breaking", () => {
    const diff = diffSpec(
      base([param({ name: "id", type: "string" })]),
      base([param({ name: "id", type: "integer" })]),
    );
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["parameter-type-changed"]);
  });

  it("classifies a parameter required-ness change as breaking", () => {
    const diff = diffSpec(
      base([param({ name: "q", required: false })]),
      base([param({ name: "q", required: true })]),
    );
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["parameter-requiredness-changed"]);
  });
});

// ── Schemas & fields ──────────────────────────────────────────────────────────

describe("diffSpec — schemas & fields", () => {
  const withThing = (fields: IrField[]): Ir => ir({ schemas: [schema("Thing", fields)] });

  it("classifies a new schema as additive", () => {
    const before = ir({ schemas: [schema("Thing", [field("id", "integer", true)])] });
    const after = ir({
      schemas: [
        schema("Thing", [field("id", "integer", true)]),
        schema("Widget", [field("id", "integer", true)]),
      ],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("additive");
    expect(kinds(diff.changes)).toEqual(["schema-added"]);
    expect(diff.changes[0]?.location).toEqual({
      level: "schema",
      resourceRef: "things",
      schemaName: "Widget",
    });
  });

  it("classifies a removed schema as breaking", () => {
    const before = ir({
      schemas: [
        schema("Thing", [field("id", "integer", true)]),
        schema("Widget", [field("id", "integer", true)]),
      ],
    });
    const after = ir({ schemas: [schema("Thing", [field("id", "integer", true)])] });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["schema-removed"]);
  });

  it("classifies a new optional field as additive with field locality", () => {
    const before = withThing([field("id", "integer", true)]);
    const after = withThing([field("id", "integer", true), field("nickname", "string", false)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("additive");
    expect(kinds(diff.changes)).toEqual(["field-added"]);
    expect(diff.changes[0]?.location).toEqual({
      level: "field",
      resourceRef: "things",
      schemaName: "Thing",
      fieldName: "nickname",
    });
  });

  it("classifies a new required field as breaking (conservative)", () => {
    const before = withThing([field("id", "integer", true)]);
    const after = withThing([field("id", "integer", true), field("owner", "string", true)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(ofKind(diff.changes, "field-added")[0]?.classification).toBe("breaking");
  });

  it("classifies a removed field as breaking", () => {
    const before = withThing([field("id", "integer", true), field("title", "string", true)]);
    const after = withThing([field("id", "integer", true)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["field-removed"]);
  });

  it("classifies a field type change as breaking", () => {
    const before = withThing([field("id", "integer", true)]);
    const after = withThing([field("id", "string", true)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["field-type-changed"]);
  });

  it("classifies a field becoming newly-required as breaking", () => {
    const before = withThing([field("summary", "string", false)]);
    const after = withThing([field("summary", "string", true)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["field-requiredness-changed"]);
  });

  it("classifies a field relaxing to optional as breaking (conservative default)", () => {
    const before = withThing([field("summary", "string", true)]);
    const after = withThing([field("summary", "string", false)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["field-requiredness-changed"]);
  });

  it("treats a renamed field as removal (breaking) + addition, overall breaking", () => {
    const before = withThing([field("assignee", "string", false)]);
    const after = withThing([field("assigned_to", "string", false)]);
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(ofKind(diff.changes, "field-removed")[0]?.location).toMatchObject({
      fieldName: "assignee",
    });
    expect(ofKind(diff.changes, "field-added")[0]?.location).toMatchObject({
      fieldName: "assigned_to",
    });
    // The removal is the breaking half — exactly the required "renamed field" signal.
    expect(ofKind(diff.changes, "field-removed")[0]?.classification).toBe("breaking");
  });
});

// ── Operation bodies ────────────────────────────────────────────────────────

describe("diffSpec — operation bodies", () => {
  it("diffs inline (anonymous) request-body fields via the schema pass", () => {
    const before = ir({
      operations: [
        op({
          operationId: "createThing",
          method: "post",
          requestSchema: schema("createThing request", [field("title", "string", true)]),
        }),
      ],
    });
    const after = ir({
      operations: [
        op({
          operationId: "createThing",
          method: "post",
          requestSchema: schema("createThing request", [field("title", "integer", true)]),
        }),
      ],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(["field-type-changed"]);
    expect(diff.changes[0]?.location).toMatchObject({
      schemaName: "createThing request",
      fieldName: "title",
    });
  });

  it("classifies a swapped named response body as breaking", () => {
    const before = ir({
      operations: [
        op({
          operationId: "getThing",
          responseSchema: schema("Thing", [field("id", "integer", true)]),
        }),
      ],
      schemas: [
        schema("Thing", [field("id", "integer", true)]),
        schema("ThingV2", [field("id", "integer", true)]),
      ],
    });
    const after = ir({
      operations: [
        op({
          operationId: "getThing",
          responseSchema: schema("ThingV2", [field("id", "integer", true)]),
        }),
      ],
      schemas: [
        schema("Thing", [field("id", "integer", true)]),
        schema("ThingV2", [field("id", "integer", true)]),
      ],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toContain("response-body-changed");
  });

  it("classifies gaining a response body as additive but gaining a request body as breaking", () => {
    const beforeResp = ir({ operations: [op({ operationId: "getThing" })] });
    const afterResp = ir({
      operations: [
        op({
          operationId: "getThing",
          responseSchema: schema("Thing", [field("id", "integer", true)]),
        }),
      ],
    });
    const respDiff = diffSpec(beforeResp, afterResp);
    expect(respDiff.classification).toBe("additive");
    expect(ofKind(respDiff.changes, "response-body-changed")[0]?.classification).toBe("additive");

    const beforeReq = ir({ operations: [op({ operationId: "createThing", method: "post" })] });
    const afterReq = ir({
      operations: [
        op({
          operationId: "createThing",
          method: "post",
          requestSchema: schema("createThing request", []),
        }),
      ],
    });
    const reqDiff = diffSpec(beforeReq, afterReq);
    expect(reqDiff.classification).toBe("breaking");
    expect(ofKind(reqDiff.changes, "request-body-changed")[0]?.classification).toBe("breaking");
  });

  it("classifies losing a body as breaking", () => {
    const before = ir({
      operations: [
        op({
          operationId: "getThing",
          responseSchema: schema("Thing", [field("id", "integer", true)]),
        }),
      ],
    });
    const after = ir({ operations: [op({ operationId: "getThing" })] });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    // The removed named body also surfaces as a removed schema — both breaking, consistent.
    expect(kinds(diff.changes)).toContain("response-body-changed");
  });
});

// ── Mixed / overall verdict ───────────────────────────────────────────────────

describe("diffSpec — overall verdict & nested locality", () => {
  it("is breaking overall when any single change is breaking", () => {
    const before = ir({
      operations: [op({ operationId: "listThings" })],
      schemas: [schema("Thing", [field("id", "integer", true), field("title", "string", true)])],
    });
    const after = ir({
      // additive: a new operation; breaking: a removed field.
      operations: [
        op({ operationId: "listThings" }),
        op({ operationId: "createThing", method: "post" }),
      ],
      schemas: [schema("Thing", [field("id", "integer", true)])],
    });
    const diff = diffSpec(before, after);
    expect(diff.classification).toBe("breaking");
    expect(kinds(diff.changes)).toEqual(
      expect.arrayContaining(["operation-added", "field-removed"]),
    );
    expect(ofKind(diff.changes, "operation-added")[0]?.classification).toBe("additive");
  });

  it("scopes each change to the exact resource it happened in", () => {
    const before: Ir = [
      group({ resourceRef: "things", schemas: [schema("Thing", [field("id", "integer", true)])] }),
      group({
        resourceRef: "widgets",
        schemas: [schema("Widget", [field("id", "integer", true)])],
      }),
    ];
    const after: Ir = [
      group({ resourceRef: "things", schemas: [schema("Thing", [field("id", "integer", true)])] }),
      group({ resourceRef: "widgets", schemas: [schema("Widget", [field("id", "string", true)])] }),
    ];
    const diff = diffSpec(before, after);
    expect(kinds(diff.changes)).toEqual(["field-type-changed"]);
    expect(diff.changes[0]?.location).toEqual({
      level: "field",
      resourceRef: "widgets",
      schemaName: "Widget",
      fieldName: "id",
    });
  });
});
