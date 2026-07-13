import type { FieldMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { participatingFieldsForSide } from "./participating-fields.js";
import type { MappingDirection } from "./types.js";

/**
 * Unit tests for EP-1.2 — the side-field participation set the echo compare covers.
 * The load-bearing cases: a field that participates only as the *other* direction's
 * output (asymmetric pairing) and a multi-input transform's additional inputs must
 * both appear, or a naive one-direction check would miss an echo / false-positive.
 */

function fm(
  overrides: Partial<FieldMapping> & Pick<FieldMapping, "sourcePath" | "targetPath">,
): FieldMapping {
  return {
    id: `fm-${overrides.sourcePath}-${overrides.targetPath}`,
    mappingId: "map",
    transform: "rename",
    ...overrides,
  };
}

describe("participatingFieldsForSide (EP-1.2)", () => {
  it("covers inputs when the side is the direction's source and outputs when it is the target", () => {
    // A→B: a.x → b.y ; the reverse B→A: b.y → a.z (asymmetric — different A field).
    const aToB: MappingDirection = {
      sourceSide: "A",
      fieldMappings: [fm({ sourcePath: "a.x", targetPath: "b.y" })],
    };
    const bToA: MappingDirection = {
      sourceSide: "B",
      fieldMappings: [fm({ sourcePath: "b.y", targetPath: "a.z" })],
    };
    const directions = [aToB, bToA];

    // Side A: input a.x (from A→B) UNION output a.z (from B→A). A naive "A→B inputs
    // only" check would miss a.z — the field the reverse direction writes into A.
    expect(participatingFieldsForSide("A", directions)).toStrictEqual(["a.x", "a.z"]);
    // Side B: output b.y (from A→B) UNION input b.y (from B→A) — deduplicated to one.
    expect(participatingFieldsForSide("B", directions)).toStrictEqual(["b.y"]);
  });

  it("includes a multi-input transform's additional inputs on the source side", () => {
    // A→B: fullName = firstName + lastName (aggregate over two A inputs).
    const aToB: MappingDirection = {
      sourceSide: "A",
      fieldMappings: [
        fm({
          sourcePath: "firstName",
          targetPath: "fullName",
          transform: "aggregate",
          transformConfig: { additionalInputPaths: ["lastName"] },
        }),
      ],
    };
    const bToA: MappingDirection = {
      sourceSide: "B",
      fieldMappings: [fm({ sourcePath: "fullName", targetPath: "displayName" })],
    };
    const directions = [aToB, bToA];

    // Side A: primary input firstName + additional input lastName (A→B) UNION the
    // reverse direction's output displayName (B→A).
    expect(participatingFieldsForSide("A", directions)).toStrictEqual([
      "firstName",
      "lastName",
      "displayName",
    ]);
    // Side B: output fullName (A→B) UNION input fullName (B→A) — one field.
    expect(participatingFieldsForSide("B", directions)).toStrictEqual(["fullName"]);
  });

  it("handles a one-way rule (single direction): source inputs only, no output on that side", () => {
    const aToB: MappingDirection = {
      sourceSide: "A",
      fieldMappings: [
        fm({ sourcePath: "email", targetPath: "email" }),
        fm({ sourcePath: "name", targetPath: "name" }),
      ],
    };
    expect(participatingFieldsForSide("A", [aToB])).toStrictEqual(["email", "name"]);
    // Side B participates only as the (single) direction's target outputs.
    expect(participatingFieldsForSide("B", [aToB])).toStrictEqual(["email", "name"]);
  });
});
