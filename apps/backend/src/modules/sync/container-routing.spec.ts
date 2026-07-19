import type { ScopeLink, ScopePathBinding } from "@mediator/domain";
import { FakeScopeLinkStore } from "@mediator/sync-engine";
import { describe, expect, it } from "vitest";

import { hasConfirmedScopePathBinding, resolveScopedContainer } from "./container-routing.js";

/**
 * SS-14.1 / SS-14.6 — `resolveScopedContainer` also yields the **target-side container scope
 * fill** (`targetContainerScope`) a scoped identity lookup searches within, resolved from the
 * change's **captured scope** (create/update path). Both Layer 3 (`scope-link` → ScopeLink
 * target key) and Layer 2 (`record-derived` → resolved fill) are covered, plus the
 * scoped-vs-non-scoped classification the SS-14.3 park decision needs.
 */

const NOW = new Date("2026-07-19T00:00:00.000Z");
const PAIR = "pair::issues";
const APP_GITEA = "app-gitea";
const APP_VIKUNJA = "app-vikunja";

const SCOPE_LINK_BINDING: ScopePathBinding = {
  kind: "scope-link",
  parameterName: "id",
  scopeKeyRef: "id",
  confirmedBy: "op",
  confirmedAt: NOW,
};

const RECORD_DERIVED_BINDING: ScopePathBinding = {
  kind: "record-derived",
  parameterName: "project",
  sourceScopeKey: "project",
  confirmedBy: "op",
  confirmedAt: NOW,
};

function scopeLink(): ScopeLink {
  return {
    id: "sl-1",
    scopeCorrespondenceId: "sc-1",
    appAId: APP_GITEA,
    appAScopeKey: { owner: "alice", repo: "phoenix" },
    appBId: APP_VIKUNJA,
    appBScopeKey: { id: "42" },
    resourcePairRef: PAIR,
    establishedBy: "identity-match",
    status: "active",
    createdAt: NOW,
  };
}

describe("resolveScopedContainer — SS-14.1 targetContainerScope", () => {
  it("L3 (scope-link) — resolves the container to the ScopeLink target key + freezes the scopeRef", async () => {
    const scopeLinks = new FakeScopeLinkStore();
    await scopeLinks.establish(scopeLink());

    const container = await resolveScopedContainer({
      capturedScope: { owner: "alice", repo: "phoenix" },
      resourcePairRef: PAIR,
      sourceAppId: APP_GITEA,
      targetAppId: APP_VIKUNJA,
      scopePathBindings: [SCOPE_LINK_BINDING],
      scopeLinks,
    });

    expect(container.scopeRefForNewLink).toStrictEqual({ kind: "scope-link", scopeLinkId: "sl-1" });
    // The scoped identity lookup fills the target read with project 42 — searches only within it.
    expect(container.targetContainerScope).toStrictEqual(new Map([["id", "42"]]));
    expect(container.createScopeLinkValues).toStrictEqual(new Map([["id", "42"]]));
  });

  it("L3 — an unresolved container (no active ScopeLink) yields nothing (→ park, never a guess)", async () => {
    const container = await resolveScopedContainer({
      capturedScope: { owner: "alice", repo: "ghost" },
      resourcePairRef: PAIR,
      sourceAppId: APP_GITEA,
      targetAppId: APP_VIKUNJA,
      scopePathBindings: [SCOPE_LINK_BINDING],
      scopeLinks: new FakeScopeLinkStore(),
    });

    expect(container.scopeRefForNewLink).toBeUndefined();
    expect(container.targetContainerScope).toBeUndefined();
  });

  it("L2 (record-derived) — resolves the container fill from the captured scope (shared value-space)", async () => {
    const container = await resolveScopedContainer({
      capturedScope: { project: "7" },
      resourcePairRef: PAIR,
      sourceAppId: APP_GITEA,
      targetAppId: APP_VIKUNJA,
      scopePathBindings: [RECORD_DERIVED_BINDING],
      scopeLinks: new FakeScopeLinkStore(),
    });

    expect(container.scopeRefForNewLink).toStrictEqual({
      kind: "resolved",
      values: { project: "7" },
    });
    expect(container.targetContainerScope).toStrictEqual(new Map([["project", "7"]]));
  });

  it("a delete (no captured scope) resolves no container — routes from the stored scopeRef instead", async () => {
    const container = await resolveScopedContainer({
      capturedScope: undefined,
      resourcePairRef: PAIR,
      sourceAppId: APP_GITEA,
      targetAppId: APP_VIKUNJA,
      scopePathBindings: [SCOPE_LINK_BINDING],
      scopeLinks: new FakeScopeLinkStore(),
    });

    expect(container).toStrictEqual({});
  });
});

describe("hasConfirmedScopePathBinding — SS-14.3 scoped classification", () => {
  it("is true for a confirmed scope-link or record-derived binding", () => {
    expect(hasConfirmedScopePathBinding([SCOPE_LINK_BINDING])).toBe(true);
    expect(hasConfirmedScopePathBinding([RECORD_DERIVED_BINDING])).toBe(true);
  });

  it("is false for no bindings, a constant-only rule, or an UNCONFIRMED scoped binding", () => {
    expect(hasConfirmedScopePathBinding([])).toBe(false);
    expect(
      hasConfirmedScopePathBinding([
        {
          kind: "constant",
          parameterName: "tenant",
          value: "acme",
          confirmedBy: "op",
          confirmedAt: NOW,
        },
      ]),
    ).toBe(false);
    expect(
      hasConfirmedScopePathBinding([
        {
          kind: "scope-link",
          parameterName: "id",
          scopeKeyRef: "id",
          confirmedBy: null,
          confirmedAt: null,
        },
      ]),
    ).toBe(false);
  });
});
