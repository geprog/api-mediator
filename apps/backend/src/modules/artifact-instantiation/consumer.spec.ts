import type { ProcessedEventOps } from "@mediator/db";
import { MAPPING_APPROVED_EVENT_TYPE, SPEC_INGESTED_EVENT_TYPE } from "@mediator/domain";
import { invokeConsumer, type DeliveredEvent } from "@mediator/event-bus";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_INSTANTIATION_CONSUMER_NAME,
  MappingApprovedInstantiationConsumer,
  type LoadedApprovedMapping,
} from "./consumer.js";
import {
  FakeDownstreamArtifactOps,
  approvedMappingFixture,
  fieldMappingFixture,
  sequentialIds,
} from "./fakes.testkit.js";

/** A sentinel transaction handle — identity is all that matters for these tests. */
interface FakeTx {
  readonly marker: "fake-tx";
}
const fakeTx: FakeTx = { marker: "fake-tx" };

/** In-memory `processed_event` ledger (mirrors the real dedup-by-event-id). */
class FakeLedger implements ProcessedEventOps {
  readonly #processed = new Set<string>();
  public isProcessed(consumerName: string, eventId: string): Promise<boolean> {
    return Promise.resolve(this.#processed.has(`${consumerName}::${eventId}`));
  }
  public markProcessed(consumerName: string, eventId: string): Promise<void> {
    this.#processed.add(`${consumerName}::${eventId}`);
    return Promise.resolve();
  }
}

function mappingApprovedEvent(id: string, approvedMappingId: string): DeliveredEvent {
  return {
    id,
    type: MAPPING_APPROVED_EVENT_TYPE,
    occurredAt: new Date("2026-07-12T00:00:00.000Z"),
    payload: { approvedMappingId, variant: "peer-peer" },
  };
}

/** A peer-peer mapping + one field pair, loaded for `m-1` (anything else: not found). */
function loaderFor(): {
  readonly load: (id: string, tx: FakeTx) => Promise<LoadedApprovedMapping | undefined>;
  readonly loadCalls: FakeTx[];
} {
  const loadCalls: FakeTx[] = [];
  const load = (id: string, tx: FakeTx): Promise<LoadedApprovedMapping | undefined> => {
    loadCalls.push(tx);
    if (id !== "m-1") {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      mapping: approvedMappingFixture({
        id: "m-1",
        variant: "peer-peer",
        sourceAppId: "app-a",
        targetAppId: "app-b",
      }),
      fields: [
        fieldMappingFixture({
          id: "f-1",
          mappingId: "m-1",
          sourcePath: "issues/title",
          targetPath: "tasks/title",
        }),
      ],
      operations: [],
    });
  };
  return { load, loadCalls };
}

describe("MappingApprovedInstantiationConsumer", () => {
  it("handles only MappingApproved", () => {
    const ops = new FakeDownstreamArtifactOps();
    const { load } = loaderFor();
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load,
      ops: () => ops,
      newId: sequentialIds("id"),
    });
    expect(consumer.name).toBe(ARTIFACT_INSTANTIATION_CONSUMER_NAME);
    expect(consumer.handles(MAPPING_APPROVED_EVENT_TYPE)).toBe(true);
    expect(consumer.handles(SPEC_INGESTED_EVENT_TYPE)).toBe(false);
  });

  it("loads the mapping through the handler's tx and instantiates its artifacts", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const { load, loadCalls } = loaderFor();
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load,
      ops: () => ops,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "m-1"), fakeTx);

    // Loaded through the handler's transaction handle, and one disabled rule created.
    expect(loadCalls).toStrictEqual([fakeTx]);
    expect(ops.syncRules).toHaveLength(1);
    expect(ops.syncRules[0]?.status).toBe("disabled");
    expect(ops.edges).toHaveLength(1);
  });

  it("is idempotent under at-least-once redelivery: the same event instantiates once", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const { load } = loaderFor();
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load,
      ops: () => ops,
      newId: sequentialIds("id"),
    });
    const ledger = new FakeLedger();
    const event = mappingApprovedEvent("evt-1", "m-1");

    const first = await invokeConsumer(consumer, event, fakeTx, ledger);
    const second = await invokeConsumer(consumer, event, fakeTx, ledger);

    expect(first).toBe("handled");
    expect(second).toBe("skipped-duplicate");
    // Redelivery skipped by the ledger → the handler ran once → one rule/edge.
    expect(ops.syncRules).toHaveLength(1);
    expect(ops.edges).toHaveLength(1);
  });

  it("no-ops when the mapping cannot be loaded (nothing to instantiate)", async () => {
    const ops = new FakeDownstreamArtifactOps();
    const { load } = loaderFor();
    const consumer = new MappingApprovedInstantiationConsumer<FakeTx>({
      load,
      ops: () => ops,
      newId: sequentialIds("id"),
    });

    await consumer.handle(mappingApprovedEvent("evt-1", "missing"), fakeTx);

    expect(ops.syncRules).toHaveLength(0);
    expect(ops.edges).toHaveLength(0);
    expect(ops.calls.insertSyncRuleIfAbsent).toBe(0);
    expect(ops.calls.upsertGraphEdge).toBe(0);
  });
});
