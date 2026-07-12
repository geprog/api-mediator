import { describe, expect, it } from "vitest";

import { ARTIFACT_INSTANTIATION_CONSUMER_NAME } from "./consumer.js";
import { ArtifactInstantiationReconciler } from "./reconciler.js";

describe("ArtifactInstantiationReconciler", () => {
  it("shares the consumer's name (one derivation, one reconciler)", () => {
    const reconciler = new ArtifactInstantiationReconciler({
      findMissingMappingIds: () => Promise.resolve([]),
      instantiate: () => Promise.resolve(),
    });
    expect(reconciler.name).toBe(ARTIFACT_INSTANTIATION_CONSUMER_NAME);
  });

  it("re-triggers instantiation for every mapping with no artifacts", async () => {
    const instantiated: string[] = [];
    const reconciler = new ArtifactInstantiationReconciler({
      findMissingMappingIds: () => Promise.resolve(["m-1", "m-2"]),
      instantiate: (id) => {
        instantiated.push(id);
        return Promise.resolve();
      },
    });

    await reconciler.reconcile();

    expect(instantiated).toStrictEqual(["m-1", "m-2"]);
  });

  it("does nothing when every active mapping already has artifacts", async () => {
    let calls = 0;
    const reconciler = new ArtifactInstantiationReconciler({
      findMissingMappingIds: () => Promise.resolve([]),
      instantiate: () => {
        calls += 1;
        return Promise.resolve();
      },
    });

    await reconciler.reconcile();

    expect(calls).toBe(0);
  });
});
