import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  AppCapabilities,
  ConfirmableRef,
  Ir,
  IrOperation,
  ResourceBinding,
} from "@mediator/domain";
import { beforeAll, describe, expect, it } from "vitest";

import { buildIr } from "./build-ir.js";
import { deriveResourceBindings } from "./resource-bindings.js";

function loadOas3(name: string): unknown {
  const url = new URL(
    `../../../scenarios/scenario-1-small-overlap/specs/oas3/${name}`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

function capabilities(overrides: Partial<AppCapabilities> = {}): AppCapabilities {
  return {
    supportsPolling: true,
    supportsDeltaQuery: false,
    supportsChangeTimestamps: false,
    defaultPollInterval: 60_000,
    ...overrides,
  };
}

function bindingFor(bindings: readonly ResourceBinding[], resourceRef: string): ResourceBinding {
  const binding = bindings.find((candidate) => candidate.resourceRef === resourceRef);
  if (!binding) throw new Error(`binding for '${resourceRef}' not found`);
  return binding;
}

function resolveOperation(ir: Ir, resourceRef: string, operationId: string): IrOperation {
  const group = ir.find((candidate) => candidate.resourceRef === resourceRef);
  const operation = group?.operations.find((op) => op.operationId === operationId);
  if (!operation) throw new Error(`operation '${operationId}' not found in '${resourceRef}'`);
  return operation;
}

/** Every ref actually present on a binding (absent keys are omitted). */
function presentRefs(binding: ResourceBinding): ConfirmableRef[] {
  return [
    binding.nativeIdRef,
    binding.collectionReadRef,
    binding.paginationRef,
    binding.changeTimestampRef,
    binding.deltaCursorRef,
    binding.deltaDeletionRef,
  ].filter((ref): ref is ConfirmableRef => ref !== undefined);
}

let vikunjaIr: Ir;
let giteaIr: Ir;

beforeAll(async () => {
  vikunjaIr = await buildIr(loadOas3("vikunja.trimmed.oas3.json"));
  giteaIr = await buildIr(loadOas3("gitea.trimmed.oas3.json"));
});

describe("deriveResourceBindings — shape (RB-1 crit 1, 7)", () => {
  it("derives exactly one binding per resource group, each keyed to its spec + resourceRef", () => {
    const bindings = deriveResourceBindings(vikunjaIr, capabilities(), "spec-vikunja");
    expect(bindings).toHaveLength(vikunjaIr.length);
    for (const binding of bindings) {
      expect(binding.id.length).toBeGreaterThan(0);
      expect(binding.apiSpecId).toBe("spec-vikunja");
      expect(vikunjaIr.some((group) => group.resourceRef === binding.resourceRef)).toBe(true);
    }
  });

  it("leaves every derived ref unconfirmed (confirmedBy = null, confirmedAt = null)", () => {
    const bindings = deriveResourceBindings(
      giteaIr,
      capabilities({ supportsDeltaQuery: true, supportsChangeTimestamps: true }),
      "spec-gitea",
    );
    for (const binding of bindings) {
      for (const ref of presentRefs(binding)) {
        expect(ref.confirmedBy).toBeNull();
        expect(ref.confirmedAt).toBeNull();
      }
    }
  });
});

describe("deriveResourceBindings — Vikunja `tasks` (RB-1 crit 2-5, 9)", () => {
  it("guesses nativeIdRef = `id`, collectionReadRef = param-free GET /tasks, paginationRef = page", () => {
    const binding = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities(), "spec-vikunja"),
      "tasks",
    );

    expect(binding.nativeIdRef?.value).toEqual({ kind: "field", path: "id" });

    const collectionRead = binding.collectionReadRef?.value;
    expect(collectionRead?.kind).toBe("operation");
    if (collectionRead?.kind !== "operation") throw new Error("expected an operation ref");
    const operation = resolveOperation(vikunjaIr, "tasks", collectionRead.operationId);
    expect(operation.method).toBe("get");
    expect(operation.path).toBe("/tasks");
    expect(operation.parameters.some((p) => p.location === "path")).toBe(false); // param-free

    expect(binding.paginationRef?.value).toEqual({
      kind: "parameter",
      operationId: collectionRead.operationId,
      parameter: "page",
    });
  });

  it("guesses changeTimestampRef = `updated` iff the app declares supportsChangeTimestamps", () => {
    const withTimestamps = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities({ supportsChangeTimestamps: true }), "spec"),
      "tasks",
    );
    expect(withTimestamps.changeTimestampRef?.value).toEqual({ kind: "field", path: "updated" });

    const withoutTimestamps = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities({ supportsChangeTimestamps: false }), "spec"),
      "tasks",
    );
    expect(withoutTimestamps.changeTimestampRef).toBeUndefined();
  });

  it("omits delta refs when the app does not declare supportsDeltaQuery", () => {
    const binding = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities({ supportsDeltaQuery: false }), "spec"),
      "tasks",
    );
    expect(binding.deltaCursorRef).toBeUndefined();
    expect(binding.deltaDeletionRef).toBeUndefined();
  });
});

describe("deriveResourceBindings — Gitea `issues` (RB-1 crit 6, 8)", () => {
  // With noun grouping, `/repos/issues/search` (noun `search`) is its own group,
  // so the `issues` collection read is unambiguously the {owner}/{repo}-scoped list.
  const ACCEPTABLE_COLLECTION_READS = ["/repos/{owner}/{repo}/issues"];

  it("guesses nativeIdRef = `id` and a collection GET for collectionReadRef, both unconfirmed", () => {
    const binding = bindingFor(
      deriveResourceBindings(giteaIr, capabilities(), "spec-gitea"),
      "issues",
    );

    expect(binding.nativeIdRef?.value).toEqual({ kind: "field", path: "id" });
    expect(binding.nativeIdRef?.confirmedBy).toBeNull();

    const collectionRead = binding.collectionReadRef?.value;
    expect(collectionRead?.kind).toBe("operation");
    if (collectionRead?.kind !== "operation") throw new Error("expected an operation ref");
    const operation = resolveOperation(giteaIr, "issues", collectionRead.operationId);
    expect(operation.method).toBe("get");
    // Ground truth: the {owner}/{repo}-scoped issues list is the collection read.
    expect(ACCEPTABLE_COLLECTION_READS).toContain(operation.path);
    expect(binding.collectionReadRef?.confirmedBy).toBeNull();
  });

  it("guesses deltaCursorRef (`since`) iff the app declares supportsDeltaQuery", () => {
    const withDelta = bindingFor(
      deriveResourceBindings(giteaIr, capabilities({ supportsDeltaQuery: true }), "spec-gitea"),
      "issues",
    );
    const cursor = withDelta.deltaCursorRef?.value;
    expect(cursor?.kind).toBe("parameter");
    if (cursor?.kind === "parameter") expect(cursor.parameter).toBe("since");

    const withoutDelta = bindingFor(
      deriveResourceBindings(giteaIr, capabilities({ supportsDeltaQuery: false }), "spec-gitea"),
      "issues",
    );
    expect(withoutDelta.deltaCursorRef).toBeUndefined();
  });
});

// ── Synthetic specs ───────────────────────────────────────────────────────────
// The scenario fixtures have no `cursor` pagination parameter and no deletion-
// marker field, so small in-test OAS3 documents exercise those derivation paths.

function widgetsSpec(options: {
  collectionParams: readonly string[];
  fields: readonly string[];
}): unknown {
  const properties: Record<string, unknown> = { id: { type: "integer" } };
  for (const field of options.fields) properties[field] = { type: "string" };
  return {
    openapi: "3.0.0",
    info: { title: "widgets", version: "1" },
    paths: {
      "/widgets": {
        get: {
          operationId: "listWidgets",
          tags: ["widget"],
          parameters: options.collectionParams.map((name) => ({
            name,
            in: "query",
            schema: { type: "string" },
          })),
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Widget: { type: "object", properties } },
    },
  };
}

describe("deriveResourceBindings — pagination-vs-delta cursor precedence", () => {
  it("assigns a lone `cursor` param to paginationRef, never also deltaCursorRef", async () => {
    const ir = await buildIr(widgetsSpec({ collectionParams: ["cursor"], fields: [] }));
    const binding = bindingFor(
      deriveResourceBindings(ir, capabilities({ supportsDeltaQuery: true }), "spec-widgets"),
      "widgets",
    );
    expect(binding.paginationRef?.value).toEqual({
      kind: "parameter",
      operationId: "listWidgets",
      parameter: "cursor",
    });
    expect(binding.deltaCursorRef).toBeUndefined();
  });

  it("derives deltaCursorRef from a distinct `since` param alongside a `cursor` page param", async () => {
    const ir = await buildIr(widgetsSpec({ collectionParams: ["cursor", "since"], fields: [] }));
    const binding = bindingFor(
      deriveResourceBindings(ir, capabilities({ supportsDeltaQuery: true }), "spec-widgets"),
      "widgets",
    );
    expect(binding.paginationRef?.value).toEqual({
      kind: "parameter",
      operationId: "listWidgets",
      parameter: "cursor",
    });
    expect(binding.deltaCursorRef?.value).toEqual({
      kind: "parameter",
      operationId: "listWidgets",
      parameter: "since",
    });
  });
});

describe("deriveResourceBindings — deltaDeletionRef (RB-1 crit 6)", () => {
  it("derives deltaDeletionRef from a deletion-marker field iff supportsDeltaQuery", async () => {
    const ir = await buildIr(widgetsSpec({ collectionParams: ["page"], fields: ["deletedAt"] }));

    const withDelta = bindingFor(
      deriveResourceBindings(ir, capabilities({ supportsDeltaQuery: true }), "spec-widgets"),
      "widgets",
    );
    expect(withDelta.deltaDeletionRef?.value).toEqual({ kind: "field", path: "deletedAt" });
    expect(withDelta.deltaDeletionRef?.confirmedBy).toBeNull();

    const withoutDelta = bindingFor(
      deriveResourceBindings(ir, capabilities({ supportsDeltaQuery: false }), "spec-widgets"),
      "widgets",
    );
    expect(withoutDelta.deltaDeletionRef).toBeUndefined();
  });
});
