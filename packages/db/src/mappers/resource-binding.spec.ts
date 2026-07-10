import type { ResourceBinding } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  mapResourceBinding,
  toResourceBindingInsert,
  toResourceBindingRefInserts,
  toResourceBindingRefUpdate,
  type ResourceBindingRefRow,
  type ResourceBindingRow,
} from "./resource-binding.js";

const confirmedAt = new Date("2026-07-10T12:00:00.000Z");

function parentRow(): ResourceBindingRow {
  return { id: "rb-1", apiSpecId: "spec-1", resourceRef: "issues" };
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

  it("maps a binding with no ref rows to a bindings-less binding", () => {
    const binding = mapResourceBinding({ ...parentRow(), resourceRef: "webhooks" }, []);
    expect(binding).toStrictEqual({ id: "rb-1", apiSpecId: "spec-1", resourceRef: "webhooks" });
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
