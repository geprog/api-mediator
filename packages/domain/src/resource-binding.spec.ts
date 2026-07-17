import { describe, expect, it } from "vitest";

import {
  type ResourceBinding,
  resourceBindingSchema,
  scopePathBindingSchema,
  sourceScopeRefSchema,
} from "./index.js";

/** A derived, still-unconfirmed binding for the Gitea `issues` resource. */
function derivedIssuesBinding(): ResourceBinding {
  return {
    id: "rb-1",
    apiSpecId: "spec-1",
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    collectionReadRef: {
      value: { kind: "operation", operationId: "issueSearchIssues" },
      confirmedBy: null,
      confirmedAt: null,
    },
    paginationRef: {
      value: { kind: "parameter", operationId: "issueSearchIssues", parameter: "page" },
      confirmedBy: null,
      confirmedAt: null,
    },
    // No delta/change-timestamp refs: the owning app declares neither capability,
    // so those refs are simply absent (not meaningful for this resource).
  };
}

describe("ResourceBinding schema", () => {
  it("accepts a derived, unconfirmed binding with only the meaningful refs present", () => {
    const parsed = resourceBindingSchema.parse(derivedIssuesBinding());
    expect(parsed.nativeIdRef?.confirmedBy).toBeNull();
    expect(parsed.nativeIdRef?.confirmedAt).toBeNull();
    // Absent refs stay omitted, distinct from an explicit `undefined`.
    expect("deltaCursorRef" in parsed).toBe(false);
    expect("changeTimestampRef" in parsed).toBe(false);
  });

  it("accepts a confirmed ref carrying operator identity and timestamp", () => {
    const binding = derivedIssuesBinding();
    const parsed = resourceBindingSchema.parse({
      ...binding,
      nativeIdRef: {
        value: { kind: "field", path: "id" },
        confirmedBy: "operator@example.test",
        confirmedAt: new Date("2026-07-10T12:00:00.000Z"),
      },
    });
    expect(parsed.nativeIdRef?.confirmedBy).toBe("operator@example.test");
    expect(parsed.nativeIdRef?.confirmedAt).toBeInstanceOf(Date);
  });

  it("accepts a binding with no refs at all (a resource with no derivable bindings)", () => {
    const result = resourceBindingSchema.safeParse({
      id: "rb-2",
      apiSpecId: "spec-1",
      resourceRef: "webhooks",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an IrRefTarget with an unknown kind", () => {
    const result = resourceBindingSchema.safeParse({
      ...derivedIssuesBinding(),
      nativeIdRef: { value: { kind: "schema", path: "id" }, confirmedBy: null, confirmedAt: null },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a parameter ref missing its parameter name", () => {
    const result = resourceBindingSchema.safeParse({
      ...derivedIssuesBinding(),
      paginationRef: {
        value: { kind: "parameter", operationId: "issueSearchIssues" },
        confirmedBy: null,
        confirmedAt: null,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a ref missing its confirmation fields", () => {
    const result = resourceBindingSchema.safeParse({
      ...derivedIssuesBinding(),
      nativeIdRef: { value: { kind: "field", path: "id" } },
    });
    expect(result.success).toBe(false);
  });

  it("carries two independently-confirmable scope constants that round-trip (SS-1 crit 5)", () => {
    const parsed = resourceBindingSchema.parse({
      ...derivedIssuesBinding(),
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "owner",
          value: "alice",
          confirmedBy: "op@a.test",
          confirmedAt: new Date("2026-07-10T12:00:00.000Z"),
        },
        {
          kind: "constant",
          parameterName: "repo",
          value: "phoenix",
          confirmedBy: "op@a.test",
          confirmedAt: new Date("2026-07-10T12:00:00.000Z"),
        },
      ],
    });
    expect(parsed.scopePathBindings).toHaveLength(2);
    expect(parsed.scopePathBindings?.[0]?.parameterName).toBe("owner");
    const repoEntry = parsed.scopePathBindings?.[1];
    expect(repoEntry?.kind === "constant" ? repoEntry.value : undefined).toBe("phoenix");
  });

  it("accepts an empty scopePathBindings collection (SS-1 crit 1: param-free resource)", () => {
    const parsed = resourceBindingSchema.parse({
      id: "rb-3",
      apiSpecId: "spec-1",
      resourceRef: "tasks",
      scopePathBindings: [],
    });
    expect(parsed.scopePathBindings).toStrictEqual([]);
  });
});

describe("scopePathBindingSchema — constant kind (SS-1 crit 2-4)", () => {
  const confirmedAt = new Date("2026-07-10T12:00:00.000Z");

  it("accepts a derived, unconfirmed constant with an empty value (SS-2 crit 2)", () => {
    const parsed = scopePathBindingSchema.parse({
      kind: "constant",
      parameterName: "owner",
      value: "",
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(parsed).toStrictEqual({
      kind: "constant",
      parameterName: "owner",
      value: "",
      confirmedBy: null,
      confirmedAt: null,
    });
  });

  it("accepts a confirmed constant carrying a literal value + operator identity", () => {
    const parsed = scopePathBindingSchema.parse({
      kind: "constant",
      parameterName: "repo",
      value: "phoenix",
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(parsed.confirmedBy).toBe("operator@example.test");
    expect(parsed.confirmedAt).toStrictEqual(confirmedAt);
  });

  it("enforces the confirmed-pair invariant: rejects confirmedBy set while confirmedAt null", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "constant",
      parameterName: "owner",
      value: "alice",
      confirmedBy: "operator@example.test",
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("enforces the confirmed-pair invariant: rejects confirmedAt set while confirmedBy null", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "constant",
      parameterName: "owner",
      value: "alice",
      confirmedBy: null,
      confirmedAt,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a confirmed constant with an empty value (a scope cannot go live valueless)", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "constant",
      parameterName: "owner",
      value: "",
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an entry with an unknown kind (union is constant | record-derived — no scope-link yet, Layer 3)", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "scope-link",
      parameterName: "owner",
      scopeKeyRef: "repo",
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("scopePathBindingSchema — record-derived kind (SS-8 crit 1, 3, 4)", () => {
  const confirmedAt = new Date("2026-07-16T12:00:00.000Z");

  it("accepts a derived, unconfirmed record-derived entry (no transform), round-tripping its fields", () => {
    const parsed = scopePathBindingSchema.parse({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "project",
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(parsed).toStrictEqual({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "project",
      confirmedBy: null,
      confirmedAt: null,
    });
  });

  it("accepts a confirmed record-derived entry with a value-preserving (rename) transform", () => {
    const parsed = scopePathBindingSchema.parse({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "project",
      transform: { kind: "rename" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(parsed.kind).toBe("record-derived");
    expect(parsed.confirmedBy).toBe("operator@example.test");
    expect(parsed.confirmedAt).toStrictEqual(confirmedAt);
    expect(parsed.kind === "record-derived" ? parsed.transform : undefined).toStrictEqual({
      kind: "rename",
    });
  });

  it("rejects a value-altering transform (coerce) — a captured scope must round-trip (mirrors the identity-key rename-only rule)", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "project",
      transform: { kind: "coerce", config: { coerce: { to: "string", from: "number" } } },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a record-derived entry with an empty sourceScopeKey (confirmed⇒required-field invariant)", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "",
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(result.success).toBe(false);
  });

  it("enforces the confirmed-pair invariant on record-derived: rejects confirmedBy set while confirmedAt null", () => {
    const result = scopePathBindingSchema.safeParse({
      kind: "record-derived",
      parameterName: "id",
      sourceScopeKey: "project",
      confirmedBy: "operator@example.test",
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("sourceScopeRef schema (SS-7)", () => {
  it("round-trips a confirmed multi-component ref (Gitea owner + name)", () => {
    const confirmedAt = new Date("2026-07-16T09:30:00.000Z");
    const parsed = sourceScopeRefSchema.parse({
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ],
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(parsed.components).toStrictEqual([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ]);
    expect(parsed.confirmedBy).toBe("operator@example.test");
    expect(parsed.confirmedAt).toStrictEqual(confirmedAt);
  });

  it("accepts a derived unconfirmed ref (single component, both null)", () => {
    const parsed = sourceScopeRefSchema.parse({
      components: [{ key: "project", fieldPath: "project_id" }],
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(parsed.confirmedBy).toBeNull();
    expect(parsed.confirmedAt).toBeNull();
  });

  it("carries as an absent (optional) ref on a binding — absence is not undefined", () => {
    const binding: ResourceBinding = resourceBindingSchema.parse({
      id: "rb-1",
      apiSpecId: "spec-1",
      resourceRef: "tasks",
    });
    expect(binding.sourceScopeRef).toBeUndefined();
    expect("sourceScopeRef" in binding).toBe(false);
  });

  it("enforces the confirmed-pair invariant: rejects confirmedBy set while confirmedAt null", () => {
    const result = sourceScopeRefSchema.safeParse({
      components: [{ key: "project", fieldPath: "project_id" }],
      confirmedBy: "operator@example.test",
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("enforces the confirmed-pair invariant: rejects confirmedAt set while confirmedBy null", () => {
    const result = sourceScopeRefSchema.safeParse({
      components: [{ key: "project", fieldPath: "project_id" }],
      confirmedBy: null,
      confirmedAt: new Date("2026-07-16T09:30:00.000Z"),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty component set (an absent ref is not a confirmed-empty one)", () => {
    const result = sourceScopeRefSchema.safeParse({
      components: [],
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate component keys (they key the captured-scope map)", () => {
    const result = sourceScopeRefSchema.safeParse({
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "owner", fieldPath: "repository.name" },
      ],
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty key or empty fieldPath", () => {
    expect(
      sourceScopeRefSchema.safeParse({
        components: [{ key: "", fieldPath: "repository.owner" }],
        confirmedBy: null,
        confirmedAt: null,
      }).success,
    ).toBe(false);
    expect(
      sourceScopeRefSchema.safeParse({
        components: [{ key: "owner", fieldPath: "" }],
        confirmedBy: null,
        confirmedAt: null,
      }).success,
    ).toBe(false);
  });
});
