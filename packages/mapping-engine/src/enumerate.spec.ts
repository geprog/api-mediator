import { describe, expect, it } from "vitest";

import { type CandidateSpecPair, enumerateCandidatePairs, unorderedPairKey } from "./enumerate.js";
import { giteaSpec, makeSpec, todoConsumerSpec, vikunjaSpec } from "./fixtures.js";

function directions(candidates: readonly CandidateSpecPair[]): string[] {
  return candidates.map((c) => `${c.sourceSpecId}->${c.targetSpecId}(${c.variant})`);
}

describe("enumerateCandidatePairs — sync candidates (CE-1)", () => {
  it("yields both directional peer-peer analyses under one unordered pair", () => {
    const candidates = enumerateCandidatePairs(giteaSpec, [vikunjaSpec]);
    expect(directions(candidates).sort()).toEqual([
      "spec-gitea->spec-vikunja(peer-peer)",
      "spec-vikunja->spec-gitea(peer-peer)",
    ]);
    // Both share the single unordered spec pair, so stage 1 runs once for them.
    const keys = new Set(candidates.map((c) => c.unorderedKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(unorderedPairKey("spec-gitea", "spec-vikunja"));
  });

  it("produces zero peer-peer candidates when no other active PROVIDER spec exists", () => {
    expect(enumerateCandidatePairs(giteaSpec, [])).toEqual([]);
  });

  it("scenario-1: exactly Gitea→Vikunja and Vikunja→Gitea (CE-1 crit 4)", () => {
    const candidates = enumerateCandidatePairs(vikunjaSpec, [giteaSpec]);
    expect(candidates).toHaveLength(2);
    expect(directions(candidates).sort()).toEqual([
      "spec-gitea->spec-vikunja(peer-peer)",
      "spec-vikunja->spec-gitea(peer-peer)",
    ]);
  });
});

describe("enumerateCandidatePairs — adapter candidates (CE-2)", () => {
  it("new CONSUMER × other PROVIDER → one consumer-as-source candidate", () => {
    const candidates = enumerateCandidatePairs(todoConsumerSpec, [vikunjaSpec]);
    expect(candidates).toEqual([
      {
        sourceSpecId: "spec-todo",
        targetSpecId: "spec-vikunja",
        variant: "consumer-provider",
        unorderedKey: unorderedPairKey("spec-todo", "spec-vikunja"),
      },
    ]);
  });

  it("new PROVIDER × other CONSUMER → one consumer-as-source candidate (consumer is the other)", () => {
    const candidates = enumerateCandidatePairs(vikunjaSpec, [todoConsumerSpec]);
    expect(candidates).toEqual([
      {
        sourceSpecId: "spec-todo", // consumer as source even though it is the pre-existing spec
        targetSpecId: "spec-vikunja",
        variant: "consumer-provider",
        unorderedKey: unorderedPairKey("spec-todo", "spec-vikunja"),
      },
    ]);
  });

  it("a consumer-provider unordered pair carries exactly one directional analysis", () => {
    const candidates = enumerateCandidatePairs(todoConsumerSpec, [vikunjaSpec]);
    const byKey = candidates.filter((c) => c.unorderedKey === candidates[0]?.unorderedKey);
    expect(byKey).toHaveLength(1);
  });

  it("two CONSUMER specs are never paired", () => {
    const otherConsumer = makeSpec({ id: "spec-c2", appId: "app-c2", role: "CONSUMER" });
    expect(enumerateCandidatePairs(todoConsumerSpec, [otherConsumer])).toEqual([]);
  });
});

describe("enumerateCandidatePairs — guardrails (CE-3)", () => {
  it("never pairs a spec with its own app's other-role spec", () => {
    // The new Gitea PROVIDER spec's own app also carries a CONSUMER spec.
    const sameAppConsumer = makeSpec({
      id: "spec-gitea-consumer",
      appId: "app-gitea",
      role: "CONSUMER",
    });
    const candidates = enumerateCandidatePairs(giteaSpec, [sameAppConsumer, vikunjaSpec]);
    // Only the cross-app Gitea↔Vikunja peer pair — never Gitea-provider × Gitea-consumer.
    expect(candidates.every((c) => c.sourceSpecId !== "spec-gitea-consumer")).toBe(true);
    expect(candidates.every((c) => c.targetSpecId !== "spec-gitea-consumer")).toBe(true);
    expect(candidates).toHaveLength(2);
  });

  it("sourceSpecId and targetSpecId are never equal", () => {
    const candidates = enumerateCandidatePairs(giteaSpec, [vikunjaSpec, todoConsumerSpec]);
    expect(candidates.every((c) => c.sourceSpecId !== c.targetSpecId)).toBe(true);
    // Passing the new spec itself in the counterpart set changes nothing.
    expect(enumerateCandidatePairs(giteaSpec, [giteaSpec, vikunjaSpec])).toHaveLength(2);
  });

  it("excludes superseded / archived counterpart specs (active only)", () => {
    const superseded = makeSpec({
      id: "spec-old",
      appId: "app-old",
      role: "PROVIDER",
      status: "superseded",
    });
    const archived = makeSpec({
      id: "spec-arch",
      appId: "app-arch",
      role: "PROVIDER",
      status: "archived",
    });
    const candidates = enumerateCandidatePairs(giteaSpec, [superseded, archived, vikunjaSpec]);
    expect(candidates).toHaveLength(2); // only the active Vikunja pair
    expect(
      candidates.every((c) => c.sourceSpecId !== "spec-old" && c.targetSpecId !== "spec-old"),
    ).toBe(true);
  });

  it("only enumerates pairs involving the new spec (never pre-existing other pairs)", () => {
    const acme = makeSpec({ id: "spec-acme", appId: "app-acme", role: "PROVIDER" });
    const candidates = enumerateCandidatePairs(giteaSpec, [vikunjaSpec, acme]);
    // Gitea↔Vikunja (2) + Gitea↔Acme (2) = 4; the pre-existing Vikunja↔Acme pair is NOT produced.
    expect(candidates).toHaveLength(4);
    const involvesVikunjaAcme = candidates.some(
      (c) =>
        (c.sourceSpecId === "spec-vikunja" && c.targetSpecId === "spec-acme") ||
        (c.sourceSpecId === "spec-acme" && c.targetSpecId === "spec-vikunja"),
    );
    expect(involvesVikunjaAcme).toBe(false);
  });

  it("kind follows the role pairing (peer-peer vs consumer-provider)", () => {
    const peer = enumerateCandidatePairs(giteaSpec, [vikunjaSpec]);
    expect(peer.every((c) => c.variant === "peer-peer")).toBe(true);
    const adapter = enumerateCandidatePairs(todoConsumerSpec, [vikunjaSpec]);
    expect(adapter.every((c) => c.variant === "consumer-provider")).toBe(true);
  });
});
