import type { ScopeIdentityKey } from "@mediator/domain";
import { scopeIdentitySignature } from "@mediator/sync-engine";
import { describe, expect, it } from "vitest";

import {
  scopeKeyFromCaptured,
  sourceScopeSignature,
  targetContainerSignature,
} from "./scope-signature.js";

/** Unit tests for the pure SS-11 scope-identity signature + addressing-key helpers. */

const IDENTITY_KEY: ScopeIdentityKey = [{ sourceScopeKey: "name", targetFieldPath: "title" }];

describe("sourceScopeSignature", () => {
  it("computes the value-preserving signature from a captured scope (AS-IS)", () => {
    expect(sourceScopeSignature({ owner: "alice", name: "phoenix" }, IDENTITY_KEY)).toBe(
      scopeIdentitySignature(["phoenix"]),
    );
  });

  it("returns undefined when a pairing component is missing / not a scalar", () => {
    expect(sourceScopeSignature({ owner: "alice" }, IDENTITY_KEY)).toBeUndefined();
    expect(sourceScopeSignature({ name: { nested: "x" } }, IDENTITY_KEY)).toBeUndefined();
  });

  it("rejects a value-altering (non-rename) transform — the value must round-trip", () => {
    const altering: ScopeIdentityKey = [
      { sourceScopeKey: "name", targetFieldPath: "title", transform: { kind: "coerce" } },
    ];
    expect(sourceScopeSignature({ name: "phoenix" }, altering)).toBeUndefined();
  });

  it("multi-component signature is order-sensitive to the pairing order", () => {
    const twoPart: ScopeIdentityKey = [
      { sourceScopeKey: "owner", targetFieldPath: "owner_username" },
      { sourceScopeKey: "name", targetFieldPath: "title" },
    ];
    expect(sourceScopeSignature({ owner: "alice", name: "phoenix" }, twoPart)).toBe(
      scopeIdentitySignature(["alice", "phoenix"]),
    );
  });
});

describe("targetContainerSignature", () => {
  it("reads the target field(s) AS-IS and matches an equal source signature", () => {
    const source = sourceScopeSignature({ name: "phoenix" }, IDENTITY_KEY);
    const target = targetContainerSignature({ title: "phoenix", id: 42 }, IDENTITY_KEY);
    expect(target).toBe(source);
  });

  it("returns undefined when the target identity field is absent", () => {
    expect(targetContainerSignature({ id: 42 }, IDENTITY_KEY)).toBeUndefined();
  });
});

describe("scopeKeyFromCaptured", () => {
  it("stringifies scalar components into an addressing key", () => {
    expect(scopeKeyFromCaptured({ owner: "alice", name: "phoenix" })).toStrictEqual({
      owner: "alice",
      name: "phoenix",
    });
    expect(scopeKeyFromCaptured({ project: 42 })).toStrictEqual({ project: "42" });
  });

  it("returns undefined on an empty or unusable captured scope", () => {
    expect(scopeKeyFromCaptured({})).toBeUndefined();
    expect(scopeKeyFromCaptured({ owner: "alice", bad: { nested: "x" } })).toBeUndefined();
    expect(scopeKeyFromCaptured({ owner: "" })).toBeUndefined();
  });
});
