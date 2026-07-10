import { describe, expect, it } from "vitest";

import { buildGeneratedBy } from "./provider.js";

describe("buildGeneratedBy (LP-4)", () => {
  it("assembles provider identity + the active prompt version", () => {
    expect(
      buildGeneratedBy({ providerId: "ollama", model: "glm-4.7-flash" }, "mapping-v1"),
    ).toEqual({
      providerId: "ollama",
      model: "glm-4.7-flash",
      promptVersion: "mapping-v1",
    });
  });

  it("differs across providers, models, or prompt versions (LP-4 crit 3)", () => {
    const base = buildGeneratedBy({ providerId: "ollama", model: "glm-4.7-flash" }, "v1");
    expect(buildGeneratedBy({ providerId: "fake", model: "glm-4.7-flash" }, "v1")).not.toEqual(
      base,
    );
    expect(buildGeneratedBy({ providerId: "ollama", model: "other" }, "v1")).not.toEqual(base);
    expect(buildGeneratedBy({ providerId: "ollama", model: "glm-4.7-flash" }, "v2")).not.toEqual(
      base,
    );
  });

  it("stamps an independent value per call (LP-4 crit 4: one per directional proposal)", () => {
    const identity = { providerId: "ollama", model: "glm-4.7-flash" };
    const first = buildGeneratedBy(identity, "v1");
    const second = buildGeneratedBy(identity, "v1");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
