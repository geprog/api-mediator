import type { FieldMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { BadRequestError } from "../../app-errors.js";
import { assertIdentityInvariants } from "./assemble.js";

/**
 * Direct coverage of the final-field-set identity re-assertion (AS-5
 * defense-in-depth): whatever assembly path produced a field's `isIdentityKey`,
 * this guard re-applies rename-only, one-per-pair, and the shared-pairing lock.
 */

function identity(sourcePath: string, targetPath: string): FieldMapping {
  return {
    id: `${sourcePath}->${targetPath}`,
    mappingId: "am-1",
    sourcePath,
    targetPath,
    transform: "rename",
    isIdentityKey: true,
  };
}

describe("assertIdentityInvariants", () => {
  it("accepts a single identity key with no counterpart", () => {
    expect(() => {
      assertIdentityInvariants([identity("issues/email", "tasks/email")], []);
    }).not.toThrow();
  });

  it("rejects two identity keys on the same resource pair", () => {
    expect(() => {
      assertIdentityInvariants(
        [identity("issues/email", "tasks/email"), identity("issues/ref", "tasks/ref")],
        [],
      );
    }).toThrow(BadRequestError);
  });

  it("rejects an identity key carrying a non-rename transform", () => {
    const coerced: FieldMapping = {
      ...identity("issues/email", "tasks/email"),
      transform: "coerce",
    };
    expect(() => {
      assertIdentityInvariants([coerced], []);
    }).toThrow(BadRequestError);
  });

  it("accepts a pairing that matches the counterpart direction", () => {
    const counterpart = [identity("tasks/email", "issues/email")];
    expect(() => {
      assertIdentityInvariants([identity("issues/email", "tasks/email")], counterpart);
    }).not.toThrow();
  });

  it("rejects a pairing that diverges from the counterpart direction", () => {
    // Counterpart confirmed tasks/email ↔ issues/email; this direction pairs
    // issues/email → tasks/title (a different B-side field).
    const counterpart = [identity("tasks/email", "issues/email")];
    expect(() => {
      assertIdentityInvariants([identity("issues/email", "tasks/title")], counterpart);
    }).toThrow(BadRequestError);
  });

  it("ignores non-identity fields", () => {
    const plain: FieldMapping = {
      id: "fm-plain",
      mappingId: "am-1",
      sourcePath: "issues/title",
      targetPath: "tasks/title",
      transform: "rename",
    };
    expect(() => {
      assertIdentityInvariants([plain], []);
    }).not.toThrow();
  });
});
