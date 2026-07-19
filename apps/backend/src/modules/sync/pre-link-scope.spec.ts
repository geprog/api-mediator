import type { ScopeKey, ScopeLink, ScopePathBinding } from "@mediator/domain";
import {
  AMBIGUOUS_CONTAINER_DETAILS_PREFIX,
  FakeScopeLinkStore,
  FakeSyncEventRecorder,
  type ContainerParkReader,
  type ContainerParkRecord,
} from "@mediator/sync-engine";
import { describe, expect, it } from "vitest";

import { RepoContainerParkSink, RepoPreLinkScopeResolver } from "./pre-link-scope.js";

/**
 * SS-14.3 — the pre-enqueue scoped-container resolver + the container-link park sink. The
 * resolver classifies a non-scoped rule vs a scoped one, and an unresolvable container as a
 * park signal (SS-14.6 — fed by the captured scope). The sink records the record's park on the
 * SS-11.5 parked-container surface (a `failure` `SyncEvent`), deduped across polls (SS-11.7).
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

function input(capturedScope: Record<string, string> | undefined): {
  readonly resourcePairRef: string;
  readonly sourceAppId: string;
  readonly targetAppId: string;
  readonly capturedScope: Record<string, string> | undefined;
  readonly targetScopePathBindings: readonly ScopePathBinding[];
} {
  return {
    resourcePairRef: PAIR,
    sourceAppId: APP_GITEA,
    targetAppId: APP_VIKUNJA,
    capturedScope,
    targetScopePathBindings: [SCOPE_LINK_BINDING],
  };
}

describe("RepoPreLinkScopeResolver — SS-14.2/14.3", () => {
  it("resolves a scoped record's container to its shared ScopeLink (SS-14.6 captured-scope path)", async () => {
    const scopeLinks = new FakeScopeLinkStore();
    await scopeLinks.establish(scopeLink());
    const resolver = new RepoPreLinkScopeResolver(scopeLinks);

    const result = await resolver.resolve(input({ owner: "alice", repo: "phoenix" }));

    expect(result).toStrictEqual({
      kind: "scoped",
      scopeRef: { kind: "scope-link", scopeLinkId: "sl-1" },
    });
  });

  it("SS-14.3 — an unresolvable container is `unresolved` (→ the poller parks it)", async () => {
    const resolver = new RepoPreLinkScopeResolver(new FakeScopeLinkStore());

    const result = await resolver.resolve(input({ owner: "alice", repo: "ghost" }));

    expect(result.kind).toBe("unresolved");
  });

  it("a non-scoped rule (no confirmed container binding) is `not-scoped` (key unchanged)", async () => {
    const resolver = new RepoPreLinkScopeResolver(new FakeScopeLinkStore());

    const result = await resolver.resolve({
      resourcePairRef: PAIR,
      sourceAppId: APP_GITEA,
      targetAppId: APP_VIKUNJA,
      capturedScope: { owner: "alice", repo: "phoenix" },
      targetScopePathBindings: [],
    });

    expect(result).toStrictEqual({ kind: "not-scoped" });
  });
});

class FakeParkReader implements ContainerParkReader {
  public readonly queried: ScopeKey[] = [];
  public constructor(private readonly existing: string | undefined) {}
  public findOpenContainerPark(
    _pair: string,
    sourceScopeKey: ScopeKey,
  ): Promise<string | undefined> {
    this.queried.push(sourceScopeKey);
    return Promise.resolve(this.existing);
  }
}

function parkRecord(): ContainerParkRecord {
  return {
    ruleId: "rule-1",
    mappingId: "map-1",
    sourceAppId: APP_GITEA,
    sourceNativeId: "g2",
    resourcePairRef: PAIR,
    capturedScope: { owner: "alice", repo: "ghost" },
    reason: "no active ScopeLink",
  };
}

describe("RepoContainerParkSink — SS-14.3 / SS-11.5 park surface", () => {
  it("records the record's park as a container-park `failure` SyncEvent (the SS-11.5 surface)", async () => {
    const events = new FakeSyncEventRecorder();
    const sink = new RepoContainerParkSink(events, new FakeParkReader(undefined), {
      clock: () => NOW,
      newId: () => "evt-1",
    });

    await sink.park(parkRecord());

    const recorded = events.all();
    expect(recorded).toHaveLength(1);
    const entry = recorded[0];
    expect(entry?.status).toBe("failure");
    expect(entry?.relatedRuleId).toBe("rule-1");
    expect(entry?.sourceNativeId).toBe("g2");
    // The details parse as an SS-11.5 container park (so `listParkedContainerLinks` surfaces it).
    expect(entry?.details?.startsWith(AMBIGUOUS_CONTAINER_DETAILS_PREFIX)).toBe(true);
  });

  it("SS-11.7 — dedups against an already-open park for the same container (mints nothing)", async () => {
    const events = new FakeSyncEventRecorder();
    const sink = new RepoContainerParkSink(events, new FakeParkReader("existing-park"), {
      clock: () => NOW,
      newId: () => "evt-1",
    });

    await sink.park(parkRecord());

    expect(events.all()).toHaveLength(0);
  });
});
