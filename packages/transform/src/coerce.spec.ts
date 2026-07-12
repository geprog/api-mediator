import type { CoerceConfig } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { applyCoerce } from "./coerce.js";
import { isTransformError } from "./errors.js";

function expectImpossible(config: CoerceConfig, input: Parameters<typeof applyCoerce>[1]): void {
  try {
    applyCoerce(config, input);
    throw new Error("expected an impossible-coercion transform error");
  } catch (error) {
    expect(isTransformError(error)).toBe(true);
    if (isTransformError(error)) {
      expect(error.kind).toBe("impossible-coercion");
    }
  }
}

describe("coerce string→number", () => {
  const config: CoerceConfig = { to: "number", from: "string" };

  it("parses a numeric string", () => {
    expect(applyCoerce(config, "42")).toBe(42);
    expect(applyCoerce(config, "-3.5")).toBe(-3.5);
    expect(applyCoerce(config, "  7 ")).toBe(7);
  });

  it("rejects a non-numeric or empty string, and a non-string input", () => {
    expectImpossible(config, "abc");
    expectImpossible(config, "");
    expectImpossible(config, 5);
  });
});

describe("coerce number→string", () => {
  const config: CoerceConfig = { to: "string", from: "number" };

  it("renders a finite number", () => {
    expect(applyCoerce(config, 42)).toBe("42");
    expect(applyCoerce(config, -3.5)).toBe("-3.5");
  });

  it("rejects a non-number input", () => {
    expectImpossible(config, "42");
  });
});

describe("coerce enum→boolean", () => {
  const config: CoerceConfig = {
    to: "boolean",
    from: "enum",
    truthy: ["open", "active"],
    falsy: ["closed", "archived"],
  };

  it("maps configured tokens to booleans", () => {
    expect(applyCoerce(config, "open")).toBe(true);
    expect(applyCoerce(config, "active")).toBe(true);
    expect(applyCoerce(config, "closed")).toBe(false);
  });

  it("rejects a token in neither set (never a best-effort guess)", () => {
    expectImpossible(config, "pending");
    expectImpossible(config, 1);
  });
});

describe("coerce date→date", () => {
  it("reformats epoch-millis to ISO-8601 (UTC)", () => {
    const config: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "epoch-millis",
      targetFormat: "iso-8601",
    };
    expect(applyCoerce(config, 1710000000000)).toBe("2024-03-09T16:00:00.000Z");
  });

  it("reformats ISO-8601 to date-only", () => {
    const config: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "iso-8601",
      targetFormat: "date-only",
    };
    expect(applyCoerce(config, "2024-03-09T16:00:00.000Z")).toBe("2024-03-09");
  });

  it("reformats date-only to epoch-seconds (UTC midnight)", () => {
    const config: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "date-only",
      targetFormat: "epoch-seconds",
    };
    expect(applyCoerce(config, "2024-03-09")).toBe(Date.UTC(2024, 2, 9) / 1000);
  });

  it("round-trips epoch-seconds → iso → epoch-seconds", () => {
    const toIso: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "epoch-seconds",
      targetFormat: "iso-8601",
    };
    const backToSeconds: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "iso-8601",
      targetFormat: "epoch-seconds",
    };
    const iso = applyCoerce(toIso, 1710000000);
    expect(applyCoerce(backToSeconds, iso)).toBe(1710000000);
  });

  it("rejects an out-of-range calendar date and a malformed format", () => {
    const config: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "date-only",
      targetFormat: "iso-8601",
    };
    expectImpossible(config, "2024-13-09");
    expectImpossible(config, "2024-02-30");
    expectImpossible(config, "09/03/2024");
    expectImpossible(config, 20240309);
  });
});

describe("coerce determinism", () => {
  it("produces byte-identical output for identical input applied twice", () => {
    const config: CoerceConfig = {
      to: "date",
      from: "date",
      sourceFormat: "epoch-millis",
      targetFormat: "iso-8601",
    };
    const first = applyCoerce(config, 1710000000000);
    const second = applyCoerce(config, 1710000000000);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
