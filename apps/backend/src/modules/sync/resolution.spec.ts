import type { ConfirmableRef, FieldMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  confirmedFieldPath,
  confirmedValue,
  findIdentityField,
  isRefConfirmed,
  parseResourcePairRef,
} from "./resolution.js";

const CONFIRMED_AT = new Date("2026-07-13T00:00:00.000Z");

function field(overrides: Partial<FieldMapping>): FieldMapping {
  return {
    id: "f",
    mappingId: "m",
    sourcePath: "a",
    targetPath: "b",
    transform: "rename",
    ...overrides,
  };
}

describe("parseResourcePairRef", () => {
  it("splits a canonical `appId:resourceRef|appId:resourceRef` into ordered sides", () => {
    const parsed = parseResourcePairRef("app-1:widgets|app-2:gadgets");
    expect(parsed).toStrictEqual({
      a: { appId: "app-1", resourceRef: "widgets" },
      b: { appId: "app-2", resourceRef: "gadgets" },
    });
  });

  it("splits each side on the FIRST colon (a resourceRef may not contain one, but the appId cannot)", () => {
    const parsed = parseResourcePairRef("app-1:widgets|app-2:orders");
    expect(parsed?.a.appId).toBe("app-1");
    expect(parsed?.b.resourceRef).toBe("orders");
  });

  it("rejects a ref without exactly two `|`-separated sides", () => {
    expect(parseResourcePairRef("app-1:widgets")).toBeUndefined();
    expect(parseResourcePairRef("a:x|b:y|c:z")).toBeUndefined();
  });

  it("rejects a side missing its colon or with an empty half", () => {
    expect(parseResourcePairRef("app-1widgets|app-2:gadgets")).toBeUndefined();
    expect(parseResourcePairRef(":widgets|app-2:gadgets")).toBeUndefined();
    expect(parseResourcePairRef("app-1:|app-2:gadgets")).toBeUndefined();
  });
});

describe("ref confirmation helpers", () => {
  it("isRefConfirmed requires BOTH confirmation stamps set", () => {
    const value: ConfirmableRef["value"] = { kind: "field", path: "id" };
    expect(isRefConfirmed(undefined)).toBe(false);
    expect(isRefConfirmed({ value, confirmedBy: null, confirmedAt: null })).toBe(false);
    expect(isRefConfirmed({ value, confirmedBy: "op", confirmedAt: null })).toBe(false);
    expect(isRefConfirmed({ value, confirmedBy: "op", confirmedAt: CONFIRMED_AT })).toBe(true);
  });

  it("confirmedValue / confirmedFieldPath return only a confirmed ref's value / field path", () => {
    const unconfirmed: ConfirmableRef = {
      value: { kind: "field", path: "id" },
      confirmedBy: null,
      confirmedAt: null,
    };
    const confirmedField: ConfirmableRef = {
      value: { kind: "field", path: "external_id" },
      confirmedBy: "op",
      confirmedAt: CONFIRMED_AT,
    };
    const confirmedOperation: ConfirmableRef = {
      value: { kind: "operation", operationId: "listWidgets" },
      confirmedBy: "op",
      confirmedAt: CONFIRMED_AT,
    };
    expect(confirmedValue(unconfirmed)).toBeUndefined();
    expect(confirmedFieldPath(unconfirmed)).toBeUndefined();
    expect(confirmedFieldPath(confirmedField)).toBe("external_id");
    // An operation-kind confirmed ref has no field path.
    expect(confirmedFieldPath(confirmedOperation)).toBeUndefined();
    expect(confirmedValue(confirmedOperation)).toStrictEqual({
      kind: "operation",
      operationId: "listWidgets",
    });
  });
});

describe("findIdentityField", () => {
  it("returns the single confirmed identity FieldMapping", () => {
    const fields = [field({ isIdentityKey: true, sourcePath: "code" }), field({ id: "f2" })];
    expect(findIdentityField(fields)?.sourcePath).toBe("code");
  });

  it("returns undefined for zero identity fields (would silently create duplicates)", () => {
    expect(findIdentityField([field({}), field({ id: "f2" })])).toBeUndefined();
  });

  it("returns undefined for MORE than one identity field (would silently merge records)", () => {
    const fields = [
      field({ id: "f1", isIdentityKey: true }),
      field({ id: "f2", isIdentityKey: true }),
    ];
    expect(findIdentityField(fields)).toBeUndefined();
  });
});
