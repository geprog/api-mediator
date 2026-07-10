import { describe, expect, it } from "vitest";

import { ConsumerRegistry, DuplicateConsumerError, type EventConsumer } from "./consumer.js";

interface FakeTx {
  readonly marker: "fake-tx";
}

function consumer(name: string, ...types: readonly string[]): EventConsumer<FakeTx> {
  return {
    name,
    handles: (type) => types.includes(type),
    handle: () => Promise.resolve(),
  };
}

describe("ConsumerRegistry", () => {
  it("returns only consumers that handle a given type, in registration order", () => {
    const registry = new ConsumerRegistry<FakeTx>();
    const a = consumer("a", "SpecIngested");
    const b = consumer("b", "MappingApproved");
    const c = consumer("c", "SpecIngested", "MappingApproved");
    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.consumersFor("SpecIngested")).toStrictEqual([a, c]);
    expect(registry.consumersFor("MappingApproved")).toStrictEqual([b, c]);
    expect(registry.consumersFor("Unknown")).toStrictEqual([]);
    expect(registry.all()).toStrictEqual([a, b, c]);
  });

  it("rejects a duplicate consumer name (ledger-key collision)", () => {
    const registry = new ConsumerRegistry<FakeTx>();
    registry.register(consumer("dup", "SpecIngested"));
    expect(() => {
      registry.register(consumer("dup", "MappingApproved"));
    }).toThrow(DuplicateConsumerError);
  });
});
