import type { ResourceBinding } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { ScopePathBindingRow } from "../schema.js";
import {
  applyScopePathBindingPatch,
  mapResourceBinding,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ResourceBindingRefRow,
  type ResourceBindingRow,
} from "./resource-binding.js";

const confirmedAt = new Date("2026-07-10T12:00:00.000Z");

function parentRow(overrides: Partial<ResourceBindingRow> = {}): ResourceBindingRow {
  return {
    id: "rb-1",
    apiSpecId: "spec-1",
    resourceRef: "issues",
    scopePathBindings: [],
    sourceScopeRef: null,
    ...overrides,
  };
}

function refRow(
  refKind: ResourceBindingRefRow["refKind"],
  overrides: Partial<ResourceBindingRefRow> = {},
): ResourceBindingRefRow {
  return {
    id: `ref-${refKind}`,
    resourceBindingId: "rb-1",
    refKind,
    value: { kind: "field", path: "id" },
    confirmedBy: null,
    confirmedAt: null,
    ...overrides,
  };
}

describe("mapResourceBinding", () => {
  it("assembles present refs and OMITS absent ones (absent != present-unconfirmed)", () => {
    const binding = mapResourceBinding(parentRow(), [
      refRow("nativeIdRef"),
      refRow("collectionReadRef", {
        value: { kind: "operation", operationId: "listIssues" },
      }),
    ]);

    expect(binding.nativeIdRef).toStrictEqual({
      value: { kind: "field", path: "id" },
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(binding.collectionReadRef?.value).toStrictEqual({
      kind: "operation",
      operationId: "listIssues",
    });
    // Refs with no child row are absent keys, not present-undefined.
    expect("paginationRef" in binding).toBe(false);
    expect("deltaCursorRef" in binding).toBe(false);
    expect("changeTimestampRef" in binding).toBe(false);
  });

  it("preserves a confirmed ref's operator identity and real Date timestamp", () => {
    const binding = mapResourceBinding(parentRow(), [
      refRow("nativeIdRef", { confirmedBy: "operator@example.test", confirmedAt }),
    ]);

    expect(binding.nativeIdRef?.confirmedBy).toBe("operator@example.test");
    expect(binding.nativeIdRef?.confirmedAt).toBeInstanceOf(Date);
    expect(binding.nativeIdRef?.confirmedAt).toStrictEqual(confirmedAt);
  });

  it("maps a binding with no ref rows to a refs-less binding (empty scope bindings)", () => {
    const binding = mapResourceBinding({ ...parentRow(), resourceRef: "webhooks" }, []);
    expect(binding).toStrictEqual({
      id: "rb-1",
      apiSpecId: "spec-1",
      resourceRef: "webhooks",
      scopePathBindings: [],
    });
  });

  it("round-trips scope_path_bindings, ISO confirmedAt back to a real Date", () => {
    const binding = mapResourceBinding(
      parentRow({
        scopePathBindings: [
          {
            kind: "constant",
            parameterName: "owner",
            value: "",
            confirmedBy: null,
            confirmedAt: null,
          },
          {
            kind: "constant",
            parameterName: "repo",
            value: "phoenix",
            confirmedBy: "operator@example.test",
            confirmedAt: confirmedAt.toISOString(),
          },
        ],
      }),
      [],
    );

    expect(binding.scopePathBindings).toStrictEqual([
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
      {
        kind: "constant",
        parameterName: "repo",
        value: "phoenix",
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
    ]);
    expect(binding.scopePathBindings?.[1]?.confirmedAt).toBeInstanceOf(Date);
  });

  it("round-trips a confirmed record-derived scope entry (kind/sourceScopeKey/transform, ISO confirmedAt back to a Date), a constant sibling untouched (SS-8)", () => {
    const binding = mapResourceBinding(
      parentRow({
        scopePathBindings: [
          {
            kind: "record-derived",
            parameterName: "owner",
            sourceScopeKey: "owner",
            transform: { kind: "rename" },
            confirmedBy: "operator@example.test",
            confirmedAt: confirmedAt.toISOString(),
          },
          {
            kind: "constant",
            parameterName: "repo",
            value: "phoenix",
            confirmedBy: "operator@example.test",
            confirmedAt: confirmedAt.toISOString(),
          },
        ],
      }),
      [],
    );

    expect(binding.scopePathBindings).toStrictEqual([
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
      {
        kind: "constant",
        parameterName: "repo",
        value: "phoenix",
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
    ]);
    expect(binding.scopePathBindings?.[0]?.confirmedAt).toBeInstanceOf(Date);
  });
});

describe("toResourceBindingInsert / toResourceBindingRefInserts", () => {
  const binding: ResourceBinding = {
    id: "rb-1",
    apiSpecId: "spec-1",
    resourceRef: "issues",
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: null, confirmedAt: null },
    changeTimestampRef: {
      value: { kind: "field", path: "updated" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    },
  };

  it("splits a binding into its parent row and one child row per present ref", () => {
    expect(toResourceBindingInsert(binding)).toStrictEqual({
      id: "rb-1",
      apiSpecId: "spec-1",
      resourceRef: "issues",
      scopePathBindings: [],
      // Absent domain `sourceScopeRef` → NULL column (SS-7).
      sourceScopeRef: null,
    });

    const refInserts = toResourceBindingRefInserts(binding);
    expect(refInserts).toHaveLength(2);
    expect(refInserts).toContainEqual({
      resourceBindingId: "rb-1",
      refKind: "nativeIdRef",
      value: { kind: "field", path: "id" },
      confirmedBy: null,
      confirmedAt: null,
    });
    expect(refInserts).toContainEqual({
      resourceBindingId: "rb-1",
      refKind: "changeTimestampRef",
      value: { kind: "field", path: "updated" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
  });

  it("serializes scope bindings into the parent insert, Date confirmedAt as an ISO string", () => {
    const insert = toResourceBindingInsert({
      ...binding,
      scopePathBindings: [
        {
          kind: "constant",
          parameterName: "owner",
          value: "",
          confirmedBy: null,
          confirmedAt: null,
        },
        {
          kind: "constant",
          parameterName: "repo",
          value: "phoenix",
          confirmedBy: "operator@example.test",
          confirmedAt,
        },
      ],
    });

    expect(insert.scopePathBindings).toStrictEqual([
      { kind: "constant", parameterName: "owner", value: "", confirmedBy: null, confirmedAt: null },
      {
        kind: "constant",
        parameterName: "repo",
        value: "phoenix",
        confirmedBy: "operator@example.test",
        confirmedAt: confirmedAt.toISOString(),
      },
    ]);
  });

  it("serializes a record-derived scope entry into the parent insert (sourceScopeKey/transform carried, no value key), Date confirmedAt as ISO (SS-8)", () => {
    const insert = toResourceBindingInsert({
      ...binding,
      scopePathBindings: [
        {
          kind: "record-derived",
          parameterName: "owner",
          sourceScopeKey: "owner",
          transform: { kind: "rename" },
          confirmedBy: "operator@example.test",
          confirmedAt,
        },
      ],
    });

    expect(insert.scopePathBindings).toStrictEqual([
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
        confirmedBy: "operator@example.test",
        confirmedAt: confirmedAt.toISOString(),
      },
    ]);
    const first = insert.scopePathBindings?.[0];
    expect(first !== undefined && "value" in first).toBe(false);
  });

  it("serializes a confirmed sourceScopeRef into the parent insert, Date confirmedAt as ISO (SS-7)", () => {
    const insert = toResourceBindingInsert({
      ...binding,
      sourceScopeRef: {
        components: [
          { key: "owner", fieldPath: "repository.owner" },
          { key: "name", fieldPath: "repository.name" },
        ],
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
    });
    expect(insert.sourceScopeRef).toStrictEqual({
      components: [
        { key: "owner", fieldPath: "repository.owner" },
        { key: "name", fieldPath: "repository.name" },
      ],
      confirmedBy: "operator@example.test",
      confirmedAt: confirmedAt.toISOString(),
    });
  });

  it("serializes an absent sourceScopeRef as NULL (SS-7.3)", () => {
    expect(toResourceBindingInsert(binding).sourceScopeRef).toBeNull();
  });

  it("round-trips a confirmed sourceScopeRef through the row form (ISO confirmedAt back to a Date)", () => {
    const insert = toResourceBindingInsert({
      ...binding,
      sourceScopeRef: {
        components: [{ key: "project", fieldPath: "project_id" }],
        confirmedBy: "operator@example.test",
        confirmedAt,
      },
    });
    // A NULL column maps to absent; a present row maps back with a real Date.
    const reloaded = mapResourceBinding(
      parentRow({ sourceScopeRef: insert.sourceScopeRef ?? null }),
      [],
    );
    expect(reloaded.sourceScopeRef).toStrictEqual({
      components: [{ key: "project", fieldPath: "project_id" }],
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(reloaded.sourceScopeRef?.confirmedAt).toBeInstanceOf(Date);
  });

  it("maps a NULL source_scope_ref column to an absent domain ref (SS-7.3)", () => {
    const reloaded = mapResourceBinding(parentRow({ sourceScopeRef: null }), []);
    expect(reloaded.sourceScopeRef).toBeUndefined();
    expect("sourceScopeRef" in reloaded).toBe(false);
  });
});

describe("toResourceBindingRefUpdate", () => {
  it("confirm-only: sets confirmation columns, never touches value", () => {
    const set = toResourceBindingRefUpdate({
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(set).toStrictEqual({ confirmedBy: "operator@example.test", confirmedAt });
    expect("value" in set).toBe(false);
  });

  it("correct: sets value together with confirmation", () => {
    const set = toResourceBindingRefUpdate({
      value: { kind: "field", path: "number" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
    expect(set).toStrictEqual({
      value: { kind: "field", path: "number" },
      confirmedBy: "operator@example.test",
      confirmedAt,
    });
  });

  it("distinguishes an explicit null (un-confirm) from an omitted field", () => {
    const cleared = toResourceBindingRefUpdate({ confirmedBy: null, confirmedAt: null });
    expect(cleared).toStrictEqual({ confirmedBy: null, confirmedAt: null });

    const empty = toResourceBindingRefUpdate({});
    expect(empty).toStrictEqual({});
  });
});

describe("applyScopePathBindingPatch", () => {
  const scopeConfirmedAt = new Date("2026-07-15T09:30:00.000Z");

  function unconfirmed(parameterName: string): ScopePathBindingRow {
    return { kind: "constant", parameterName, value: "", confirmedBy: null, confirmedAt: null };
  }

  it("rewrites only the matching entry (value + confirmation), leaving siblings identical (SS-3.2)", () => {
    const { rows, matched } = applyScopePathBindingPatch(
      [unconfirmed("owner"), unconfirmed("repo")],
      {
        kind: "constant",
        parameterName: "owner",
        value: "alice",
        confirmedBy: "op@example.test",
        confirmedAt: scopeConfirmedAt,
      },
    );

    expect(matched).toBe(true);
    // Date confirmedAt is serialized to an ISO string for the jsonb row.
    expect(rows).toStrictEqual([
      {
        kind: "constant",
        parameterName: "owner",
        value: "alice",
        confirmedBy: "op@example.test",
        confirmedAt: scopeConfirmedAt.toISOString(),
      },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ]);
  });

  it("confirms a record-derived entry: flips kind, sets sourceScopeKey + value-preserving transform, drops the constant value (SS-8)", () => {
    const { rows, matched } = applyScopePathBindingPatch(
      [unconfirmed("owner"), unconfirmed("repo")],
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
        confirmedBy: "op@example.test",
        confirmedAt: scopeConfirmedAt,
      },
    );

    expect(matched).toBe(true);
    // The matched entry becomes the record-derived member — no stale `value` key —
    // while the sibling constant stays byte-identical to its seed (SS-3.2).
    expect(rows).toStrictEqual([
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        transform: { kind: "rename" },
        confirmedBy: "op@example.test",
        confirmedAt: scopeConfirmedAt.toISOString(),
      },
      { kind: "constant", parameterName: "repo", value: "", confirmedBy: null, confirmedAt: null },
    ]);
    // The rewritten entry carries no `value` key (record-derived has no literal).
    expect(rows[0] !== undefined && "value" in rows[0]).toBe(false);
  });

  it("confirms a record-derived entry without a transform: the key is simply omitted (SS-8)", () => {
    const { rows } = applyScopePathBindingPatch([unconfirmed("owner")], {
      kind: "record-derived",
      parameterName: "owner",
      sourceScopeKey: "owner",
      confirmedBy: "op@example.test",
      confirmedAt: scopeConfirmedAt,
    });

    expect(rows).toStrictEqual([
      {
        kind: "record-derived",
        parameterName: "owner",
        sourceScopeKey: "owner",
        confirmedBy: "op@example.test",
        confirmedAt: scopeConfirmedAt.toISOString(),
      },
    ]);
    expect(rows[0] !== undefined && "transform" in rows[0]).toBe(false);
  });

  it("reports matched=false and returns the collection unchanged when the parameter is absent (SS-3.4)", () => {
    const seed = [unconfirmed("owner"), unconfirmed("repo")];
    const { rows, matched } = applyScopePathBindingPatch(seed, {
      kind: "constant",
      parameterName: "tenant",
      value: "acme",
      confirmedBy: "op@example.test",
      confirmedAt: scopeConfirmedAt,
    });

    expect(matched).toBe(false);
    expect(rows).toStrictEqual(seed);
  });
});
