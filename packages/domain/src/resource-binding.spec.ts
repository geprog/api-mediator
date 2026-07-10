import { describe, expect, it } from "vitest";

import { type ResourceBinding, resourceBindingSchema } from "./index.js";

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
});
