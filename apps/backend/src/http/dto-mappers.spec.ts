import type { AppCapabilities, ResourceBinding } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { toResourceBindingDto } from "./dto-mappers.js";

/**
 * Unit tests for the `ResourceBinding` → wire DTO mapper's **scope-binding** serialization,
 * focused on the SS-12 hazard discharge: a persisted `scope-link` scope path binding must be
 * **serialized** (kind-tagged, beside `constant`/`record-derived`), not silently dropped from
 * the bindings GET. Confirming a `scope-link` binding through the API is SS-15; here the mapper
 * proves the wire is lossless once one exists.
 */

const CONFIRMED_AT = new Date("2026-07-13T00:00:00.000Z");
const CAPS: AppCapabilities = {
  supportsPolling: true,
  supportsDeltaQuery: false,
  supportsChangeTimestamps: false,
  defaultPollInterval: 60,
};

function binding(scopePathBindings: ResourceBinding["scopePathBindings"]): ResourceBinding {
  return { id: "rb-1", apiSpecId: "spec-1", resourceRef: "tasks", scopePathBindings };
}

/**
 * The SS-18.4 kind-selector context these serialization cases do not exercise: no proposed
 * `ScopeCorrespondence`, so `scope-link` is not selectable and no `scopeKeyRef` candidate is
 * offered. It must not affect how an ALREADY-persisted `scope-link` entry serializes — which
 * is exactly what these cases assert.
 */
const NO_SCOPE_LINK_CONTEXT = {
  scopeLinkAvailable: false,
  scopeKeyRefCandidate: undefined,
} as const;

describe("toResourceBindingDto — scope-link serialization (SS-12 hazard A)", () => {
  it("serializes a confirmed scope-link entry kind-tagged with its scopeKeyRef", () => {
    const dto = toResourceBindingDto(
      binding([
        {
          kind: "scope-link",
          parameterName: "id",
          scopeKeyRef: "id",
          confirmedBy: "operator",
          confirmedAt: CONFIRMED_AT,
        },
      ]),
      CAPS,
      NO_SCOPE_LINK_CONTEXT,
    );

    expect(dto.scopeBindings).toHaveLength(1);
    const entry = dto.scopeBindings[0];
    expect(entry).toStrictEqual({
      parameterName: "id",
      kind: "scope-link",
      scopeKeyRef: "id",
      confirmedBy: "operator",
      confirmedAt: CONFIRMED_AT.toISOString(),
    });
  });

  it("reports an unconfirmed scope-link entry (confirmedAt null) — still lossless, never dropped", () => {
    const dto = toResourceBindingDto(
      binding([
        {
          kind: "scope-link",
          parameterName: "project",
          scopeKeyRef: "id",
          confirmedBy: null,
          confirmedAt: null,
        },
      ]),
      CAPS,
      NO_SCOPE_LINK_CONTEXT,
    );

    expect(dto.scopeBindings).toStrictEqual([
      {
        parameterName: "project",
        kind: "scope-link",
        scopeKeyRef: "id",
        confirmedBy: null,
        confirmedAt: null,
      },
    ]);
  });

  it("keeps constant / record-derived / scope-link members side by side (mixed collection)", () => {
    const dto = toResourceBindingDto(
      binding([
        {
          kind: "constant",
          parameterName: "region",
          value: "eu",
          confirmedBy: "op",
          confirmedAt: CONFIRMED_AT,
        },
        {
          kind: "record-derived",
          parameterName: "owner",
          sourceScopeKey: "owner",
          confirmedBy: "op",
          confirmedAt: CONFIRMED_AT,
        },
        {
          kind: "scope-link",
          parameterName: "id",
          scopeKeyRef: "id",
          confirmedBy: "op",
          confirmedAt: CONFIRMED_AT,
        },
      ]),
      CAPS,
      NO_SCOPE_LINK_CONTEXT,
    );

    expect(dto.scopeBindings.map((entry) => `${entry.parameterName}:${entry.kind}`)).toStrictEqual([
      "region:constant",
      "owner:record-derived",
      "id:scope-link",
    ]);
  });
});
