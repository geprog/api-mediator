import type { ScopePathBinding, ScopeTransform } from "@mediator/domain";
import type { CapturedScope } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import { resolveRecordDerivedScopeValues } from "./record-derived-scope.js";

/**
 * Unit tests for {@link resolveRecordDerivedScopeValues} (SS-8b) — the pre-resolution of
 * a target resource's confirmed `record-derived` scope bindings against one change's
 * captured scope into the `{ parameterName → value }` map the shared scope-fill
 * substitutes alongside constants. The invariants under test: a present component fills
 * (stringified, transform applied); a missing / unconfirmed / unusable component is
 * **omitted** so the fill fails loudly rather than fabricating a scope.
 */

const CONFIRMED_AT = new Date("2026-07-13T00:00:00.000Z");

function recordDerived(
  parameterName: string,
  sourceScopeKey: string,
  opts: { transform?: ScopeTransform; confirmed?: boolean } = {},
): ScopePathBinding {
  const confirmed = opts.confirmed ?? true;
  return {
    kind: "record-derived",
    parameterName,
    sourceScopeKey,
    ...(opts.transform !== undefined ? { transform: opts.transform } : {}),
    confirmedBy: confirmed ? "operator" : null,
    confirmedAt: confirmed ? CONFIRMED_AT : null,
  };
}

function constant(parameterName: string, value: string): ScopePathBinding {
  return {
    kind: "constant",
    parameterName,
    value,
    confirmedBy: "operator",
    confirmedAt: CONFIRMED_AT,
  };
}

function resolve(
  bindings: readonly ScopePathBinding[],
  captured: CapturedScope,
): Record<string, string> {
  return Object.fromEntries(resolveRecordDerivedScopeValues(bindings, captured));
}

describe("resolveRecordDerivedScopeValues (SS-8b)", () => {
  it("maps each confirmed record-derived param from its captured component by sourceScopeKey", () => {
    const result = resolve([recordDerived("owner", "owner"), recordDerived("repo", "name")], {
      owner: "alice",
      name: "phoenix",
    });
    expect(result).toStrictEqual({ owner: "alice", repo: "phoenix" });
  });

  it("stringifies a numeric / boolean captured value (shared value-space)", () => {
    expect(resolve([recordDerived("id", "project")], { project: 42 })).toStrictEqual({ id: "42" });
    expect(resolve([recordDerived("flag", "flag")], { flag: true })).toStrictEqual({
      flag: "true",
    });
  });

  it("passes a value through a value-preserving rename transform unchanged", () => {
    const rename: ScopeTransform = { kind: "rename" };
    expect(
      resolve([recordDerived("owner", "owner", { transform: rename })], { owner: "alice" }),
    ).toStrictEqual({ owner: "alice" });
  });

  it("omits a param whose captured component is ABSENT (fail loud downstream)", () => {
    const result = resolve([recordDerived("owner", "owner"), recordDerived("repo", "name")], {
      owner: "alice",
    });
    expect(result).toStrictEqual({ owner: "alice" });
    expect("repo" in result).toBe(false);
  });

  it("omits an UNCONFIRMED record-derived binding", () => {
    expect(
      resolve([recordDerived("repo", "name", { confirmed: false })], { name: "phoenix" }),
    ).toStrictEqual({});
  });

  it("ignores a `constant` binding (constants fill from their literal, not from captured scope)", () => {
    expect(resolve([constant("owner", "alice")], { owner: "ignored" })).toStrictEqual({});
  });

  it("omits a captured value of JSON null / object / array (not a usable path segment)", () => {
    expect(resolve([recordDerived("owner", "owner")], { owner: null })).toStrictEqual({});
    expect(resolve([recordDerived("owner", "owner")], { owner: { nested: 1 } })).toStrictEqual({});
    expect(resolve([recordDerived("owner", "owner")], { owner: [1, 2] })).toStrictEqual({});
  });

  it("omits an EMPTY-STRING captured component (never composes a `//` collapsing path segment)", () => {
    // A source record carrying `repository.owner: ""` must not fill `{owner}` with "" — a
    // `/repos//phoenix` path collapses to `/repos/phoenix`, silently re-routing containers.
    // Only the empty component is dropped (the sibling still resolves); the fill then fails
    // loudly on the missing `owner` param (asserted in binding-resolvers.spec.ts).
    expect(resolve([recordDerived("owner", "owner")], { owner: "" })).toStrictEqual({});
    expect(
      resolve([recordDerived("owner", "owner"), recordDerived("repo", "name")], {
        owner: "",
        name: "phoenix",
      }),
    ).toStrictEqual({ repo: "phoenix" });
  });

  it("omits a captured component containing a path separator or a `.`/`..` traversal segment", () => {
    expect(resolve([recordDerived("owner", "owner")], { owner: "a/b" })).toStrictEqual({});
    expect(resolve([recordDerived("owner", "owner")], { owner: "." })).toStrictEqual({});
    expect(resolve([recordDerived("owner", "owner")], { owner: ".." })).toStrictEqual({});
  });

  it("omits a param whose transform is value-ALTERING (never touches a scope that must round-trip)", () => {
    const coerce: ScopeTransform = {
      kind: "coerce",
      config: { coerce: { to: "string", from: "number" } },
    };
    expect(
      resolve([recordDerived("id", "project", { transform: coerce })], { project: 42 }),
    ).toStrictEqual({});
  });
});
