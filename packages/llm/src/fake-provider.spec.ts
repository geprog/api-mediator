import { describe, expect, it } from "vitest";

import { LLMOutputValidationError } from "./errors.js";
import { FakeProvider, FakeProviderScriptError } from "./fake-provider.js";
import { buildGeneratedBy } from "./provider.js";
import {
  consumerProviderDetailContext,
  malformedShortlist,
  peerPeerDetailContext,
  shortlistContext,
  validConsumerProviderSet,
  validPeerPeerSet,
  validShortlist,
} from "./fixtures.js";

describe("FakeProvider — scripted valid outputs (LP-3 crit 1/2)", () => {
  it("returns exactly the scripted ResourceShortlist for a spec pair, with no network", async () => {
    const provider = new FakeProvider({
      shortlistKey: () => "pair",
      shortlist: { pair: [validShortlist] },
    });
    await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
      validShortlist,
    );
  });

  it("returns exactly the scripted MappingSuggestionSet for a resource pair", async () => {
    const provider = new FakeProvider({
      detail: {
        "issues=>tasks@peer-peer": [validPeerPeerSet],
        "issues=>tasks@consumer-provider": [validConsumerProviderSet],
      },
    });
    await expect(provider.generateMappingProposal(peerPeerDetailContext)).resolves.toEqual(
      validPeerPeerSet,
    );
    await expect(provider.generateMappingProposal(consumerProviderDetailContext)).resolves.toEqual(
      validConsumerProviderSet,
    );
  });
});

describe("FakeProvider — malformed scripting drives the retry contract (LP-3 crit 3/4)", () => {
  it("throws LLMOutputValidationError (with raw output) on a scripted malformed shape", async () => {
    const provider = new FakeProvider({
      shortlistKey: () => "pair",
      shortlist: { pair: [malformedShortlist] },
    });
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      LLMOutputValidationError,
    );
  });

  it("scripts malformed-then-valid, reproducibly across runs", async () => {
    const build = (): FakeProvider =>
      new FakeProvider({
        shortlistKey: () => "pair",
        shortlist: { pair: [malformedShortlist, validShortlist] },
      });

    for (let run = 0; run < 2; run += 1) {
      const provider = build();
      await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
        LLMOutputValidationError,
      );
      await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
        validShortlist,
      );
      // A third call clamps to the last (valid) entry — still deterministic.
      await expect(provider.shortlistResourcePairs(shortlistContext)).resolves.toEqual(
        validShortlist,
      );
    }
  });

  it("scripts malformed on every attempt up to the ceiling", async () => {
    const provider = new FakeProvider({
      shortlistKey: () => "pair",
      shortlist: { pair: [malformedShortlist] },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
        LLMOutputValidationError,
      );
    }
  });
});

describe("FakeProvider — provenance and misuse", () => {
  it("records a scriptable, stable provider identity into generatedBy (LP-3 crit 5, LP-4)", () => {
    const fallback = new FakeProvider();
    expect(fallback.providerId).toBe("fake");
    expect(fallback.model).toBe("fake-model");

    const scripted = new FakeProvider({ providerId: "fake", model: "replay-1" });
    expect(buildGeneratedBy(scripted, "test-prompt-v1")).toEqual({
      providerId: "fake",
      model: "replay-1",
      promptVersion: "test-prompt-v1",
    });
  });

  it("throws FakeProviderScriptError when a key has no scripted output", async () => {
    const provider = new FakeProvider();
    await expect(provider.shortlistResourcePairs(shortlistContext)).rejects.toBeInstanceOf(
      FakeProviderScriptError,
    );
  });
});
