import { describe, expect, it } from "vitest";

import { DOMAIN_PACKAGE, domainPackageName } from "./index.js";

describe("domain package placeholder", () => {
  it("exposes a stable package identifier", () => {
    expect(DOMAIN_PACKAGE).toBe("domain");
  });

  it("returns the identifier from the helper", () => {
    expect(domainPackageName()).toBe(DOMAIN_PACKAGE);
  });
});
