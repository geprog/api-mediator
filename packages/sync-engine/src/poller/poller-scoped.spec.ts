import type { ScopePathBinding, SourceScopeRef } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { FakeOrderingQueue } from "../fake-ordering-queue.js";
import { FakeRecordLinkStore } from "../identity-resolution/fakes.js";
import { stringifyIdentityValue } from "../identity-resolution/hash.js";
import {
  QueueKeyResolver,
  type PreLinkScopeInput,
  type PreLinkScopeResolution,
  type PreLinkScopeResolver,
} from "../ordering/queue-key-resolver.js";
import { scopeQualifiedIdentityKey } from "../ordering/scoped-queue-key.js";
import { FakePollPlanResolver, FakePollStateStore, FakeSourceReader } from "./fakes.js";
import { Poller } from "./poller.js";
import type { ContainerParkRecord, ContainerParkSink, CrossScopePollPlan } from "./types.js";

/**
 * **SS-14.3 / SS-14.5 — the Poller's pre-enqueue container scoping.** A scoped rule whose
 * record container resolves is enqueued under the **scope-qualified** key; one whose container
 * is **unresolved cannot be safely scope-keyed**, so it is **parked BEFORE enqueue** (never
 * enqueued under a guessed key). Snapshots still key by **globally-unique native id** — scoping
 * changes matching + queue keys, not snapshot keys (SS-14.5).
 */

const RULE_ID = "rule-scoped";
const SOURCE_APP = "app-gitea";
const TARGET_APP = "app-vikunja";
const PAIR = "pair::issues";
const NOW = new Date("2026-07-19T12:00:00.000Z");

const SOURCE_SCOPE_REF: SourceScopeRef = {
  components: [{ key: "project", fieldPath: "project" }],
  confirmedBy: "op",
  confirmedAt: NOW,
};

const TARGET_SCOPE_BINDINGS: readonly ScopePathBinding[] = [
  {
    kind: "scope-link",
    parameterName: "id",
    scopeKeyRef: "id",
    confirmedBy: "op",
    confirmedAt: NOW,
  },
];

function scopedPlan(): CrossScopePollPlan {
  return {
    ruleId: RULE_ID,
    mappingId: "mapping-1",
    sourceAppId: SOURCE_APP,
    targetAppId: TARGET_APP,
    resourcePairRef: PAIR,
    scopeMode: "cross-scope",
    mode: "full-fetch",
    identitySourcePath: "title",
    cursor: undefined,
    sourceScopeRef: SOURCE_SCOPE_REF,
    targetScopePathBindings: TARGET_SCOPE_BINDINGS,
  };
}

/** Resolves `project: "42"` to ScopeLink `sl-1`; anything else is an unresolvable container. */
class FakeScopeResolver implements PreLinkScopeResolver {
  public resolve(input: PreLinkScopeInput): Promise<PreLinkScopeResolution> {
    const project = input.capturedScope?.["project"];
    if (project === "42") {
      return Promise.resolve({
        kind: "scoped",
        scopeRef: { kind: "scope-link", scopeLinkId: "sl-1" },
      });
    }
    return Promise.resolve({
      kind: "unresolved",
      reason: "no active ScopeLink for the record's container",
    });
  }
}

class FakeParkSink implements ContainerParkSink {
  public readonly parks: ContainerParkRecord[] = [];
  public park(park: ContainerParkRecord): Promise<void> {
    this.parks.push(park);
    return Promise.resolve();
  }
}

function harness(options: { readonly withSink?: boolean } = {}): {
  readonly poller: Poller;
  readonly reader: FakeSourceReader;
  readonly state: FakePollStateStore;
  readonly queue: FakeOrderingQueue;
  readonly parkSink: FakeParkSink;
} {
  const reader = new FakeSourceReader();
  const resolver = new FakePollPlanResolver();
  resolver.set(RULE_ID, { pollable: true, plan: scopedPlan() });
  const state = new FakePollStateStore();
  const queue = new FakeOrderingQueue();
  const links = new FakeRecordLinkStore();
  const queueKeys = new QueueKeyResolver(links, new FakeScopeResolver());
  const parkSink = new FakeParkSink();
  const poller = new Poller(reader, resolver, state, queue, queueKeys, {
    now: () => NOW,
    ...(options.withSink === false ? {} : { containerPark: parkSink }),
  });
  return { poller, reader, state, queue, parkSink };
}

describe("Poller — SS-14 scoped record identity", () => {
  it("SS-14.3 — a resolvable container is enqueued (scope-qualified); an unresolved one is PARKED, not enqueued", async () => {
    const h = harness();
    h.reader.setFullFetch(RULE_ID, [
      {
        records: [
          { nativeId: "g1", record: { id: "g1", title: "Bug", project: "42" } },
          { nativeId: "g2", record: { id: "g2", title: "Other", project: "unknown" } },
        ],
      },
    ]);

    const outcome = await h.poller.pollOnce(RULE_ID);

    expect(outcome.kind).toBe("completed");
    // g1 (project 42) enqueued under the SCOPE-QUALIFIED key; g2 (unresolved) NOT enqueued.
    const pending = h.queue.listByStatus("pending");
    expect(pending).toHaveLength(1);
    if (outcome.kind === "completed") {
      expect(outcome.enqueued).toHaveLength(1);
      expect(outcome.enqueued[0]?.sourceNativeId).toBe("g1");
      expect(outcome.enqueued[0]?.queueKey).toBe(
        scopeQualifiedIdentityKey(
          { kind: "scope-link", scopeLinkId: "sl-1" },
          stringifyIdentityValue("Bug"),
        ),
      );
    }
    // g2's container did not resolve → parked BEFORE enqueue (SS-14.3), never enqueued.
    expect(h.parkSink.parks).toHaveLength(1);
    expect(h.parkSink.parks[0]?.sourceNativeId).toBe("g2");
    expect(h.parkSink.parks[0]?.capturedScope).toStrictEqual({ project: "unknown" });
  });

  it("SS-14.5 — the full-fetch snapshot keys by GLOBALLY-UNIQUE NATIVE ID, not the scoped queue key", async () => {
    const h = harness();
    h.reader.setFullFetch(RULE_ID, [
      {
        records: [
          { nativeId: "g1", record: { id: "g1", title: "Bug", project: "42" } },
          { nativeId: "g2", record: { id: "g2", title: "Other", project: "unknown" } },
        ],
      },
    ]);

    await h.poller.pollOnce(RULE_ID);

    // Both fetched records are in the snapshot BY NATIVE ID (scoping did not leak into keys) —
    // the parked g2 is snapshotted too, so it is not re-parked as a spurious delete next poll.
    const entries = h.state.stateOf(RULE_ID)?.entries;
    expect([...(entries?.keys() ?? [])].sort()).toStrictEqual(["g1", "g2"]);
  });

  it("SS-14.3 — advancement still happens (enqueue-then-advance): a parked record is durably handled", async () => {
    const h = harness();
    h.reader.setFullFetch(RULE_ID, [
      { records: [{ nativeId: "g2", record: { id: "g2", title: "Other", project: "unknown" } }] },
    ]);

    await h.poller.pollOnce(RULE_ID);

    // The park is durable (recorded) BEFORE the advance, so the cursor/snapshot advances once.
    expect(h.parkSink.parks).toHaveLength(1);
    expect(h.state.stateOf(RULE_ID)?.advanceCount).toBe(1);
  });

  it("SS-14.3 — fail loud: a park with NO sink configured throws, never a silent drop", async () => {
    const h = harness({ withSink: false });
    h.reader.setFullFetch(RULE_ID, [
      { records: [{ nativeId: "g2", record: { id: "g2", title: "Other", project: "unknown" } }] },
    ]);

    await expect(h.poller.pollOnce(RULE_ID)).rejects.toThrow(/no ContainerParkSink/);
  });
});
