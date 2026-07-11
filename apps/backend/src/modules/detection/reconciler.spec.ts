import { describe, expect, it } from "vitest";

import { DETECTION_CONSUMER_NAME } from "./consumer.js";
import { DetectionReconciler } from "./reconciler.js";

describe("DetectionReconciler", () => {
  it("enqueues a detection job for every active spec with no job", async () => {
    const enqueued: string[] = [];
    const reconciler = new DetectionReconciler({
      findMissingSpecIds: () => Promise.resolve(["spec-1", "spec-2"]),
      enqueue: (apiSpecId) => {
        enqueued.push(apiSpecId);
        return Promise.resolve();
      },
    });

    expect(reconciler.name).toBe(DETECTION_CONSUMER_NAME);
    await reconciler.reconcile();

    expect(enqueued).toStrictEqual(["spec-1", "spec-2"]);
  });

  it("enqueues nothing when no active spec is missing a job", async () => {
    let enqueueCalls = 0;
    const reconciler = new DetectionReconciler({
      findMissingSpecIds: () => Promise.resolve([]),
      enqueue: () => {
        enqueueCalls += 1;
        return Promise.resolve();
      },
    });

    await reconciler.reconcile();

    expect(enqueueCalls).toBe(0);
  });
});
