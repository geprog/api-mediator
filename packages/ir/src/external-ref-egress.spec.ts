import { afterEach, describe, expect, it, vi } from "vitest";

import { buildIr } from "./build-ir.js";

/**
 * External-ref egress hardening (carry-over from the IR review): an
 * operator-submitted spec must NOT be able to make `buildIr` fetch an external
 * `$ref` (an SSRF-shaped risk, and against the no-surprise-egress posture of
 * `docs/architecture/security.md`). These tests prove `buildIr` performs no
 * network I/O for a document carrying an `http://…` external `$ref`, still
 * builds an IR, and leaves the external ref unexpanded — while local `#/…` refs
 * keep resolving.
 */

// A classic SSRF target host; if any egress happened it would be to here.
const EXTERNAL_HOST = "169.254.169.254";
const EXTERNAL_REF = `http://${EXTERNAL_HOST}/latest/meta-data/schema.json#/Secret`;

/** A spec whose response body is an external `$ref` (would fetch, if resolved). */
const specWithExternalRef = {
  openapi: "3.0.0",
  info: { title: "external-ref", version: "1" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        tags: ["thing"],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: EXTERNAL_REF } } },
          },
        },
      },
    },
  },
};

/** The same shape, but the ref is local — must still resolve after hardening. */
const specWithLocalRef = {
  openapi: "3.0.0",
  info: { title: "local-ref", version: "1" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        tags: ["thing"],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Thing: {
        type: "object",
        properties: { id: { type: "integer" }, name: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

describe("buildIr — external-ref egress hardening", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch an http:// external $ref and still builds the IR", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ir = await buildIr(specWithExternalRef);

    // No network egress was attempted for the external ref.
    expect(fetchSpy).not.toHaveBeenCalled();
    // The document still built into an IR (leniency preserved).
    expect(ir.length).toBeGreaterThan(0);
    const things = ir.find((group) => group.resourceRef === "things");
    expect(things).toBeDefined();
  });

  it("leaves the external $ref unexpanded — its host never appears in the IR", async () => {
    const ir = await buildIr(specWithExternalRef);

    // The external target was dropped, not inlined: nothing from the remote host
    // (its URL, its `Secret` schema) leaked into the IR.
    expect(JSON.stringify(ir)).not.toContain(EXTERNAL_HOST);
    expect(JSON.stringify(ir)).not.toContain("$ref");
  });

  it("still resolves local #/… refs after external resolution is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const ir = await buildIr(specWithLocalRef);

    expect(fetchSpy).not.toHaveBeenCalled();
    const things = ir.find((group) => group.resourceRef === "things");
    const listThings = things?.operations.find((op) => op.operationId === "listThings");
    const fieldNames = listThings?.responseSchema?.fields.map((field) => field.name) ?? [];
    // The local Thing schema resolved and flattened into the response fields.
    expect(fieldNames).toEqual(expect.arrayContaining(["id", "name"]));
  });
});
