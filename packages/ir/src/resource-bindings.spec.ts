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

describe("deriveResourceBindings — scopePathBindings (SS-2)", () => {
  it("Gitea `issues`: unconfirmed scope entries for owner + repo, NONE for record-id {index} (SS-2 crit 3)", () => {
    const binding = bindingFor(
      deriveResourceBindings(giteaIr, capabilities(), "spec-gitea"),
      "issues",
    );
    const scope = binding.scopePathBindings ?? [];
    expect([...scope.map((entry) => entry.parameterName)].sort()).toStrictEqual(["owner", "repo"]);
    // {index} is the issue's record id (most-specific path param on the by-id and
    // merged action ops), never a scope parameter.
    expect(scope.some((entry) => entry.parameterName === "index")).toBe(false);
    for (const entry of scope) {
      expect(entry.kind).toBe("constant");
      expect(entry.confirmedBy).toBeNull();
      expect(entry.confirmedAt).toBeNull();
      // owner/repo carry no single-value hint in the spec → empty candidate.
      expect(entry.value).toBe("");
    }
  });

  it("Vikunja `tasks`: only the create's container {id} is scope; id-only/param-free ops contribute none (SS-2 crit 4)", () => {
    const binding = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities(), "spec-vikunja"),
      "tasks",
    );
    const scope = binding.scopePathBindings ?? [];
    // `GET /tasks` (param-free) + `/tasks/{id}` (record-id) yield nothing; the
    // create `PUT /projects/{id}/tasks` alone contributes {id} as a scope param —
    // per-operation asymmetric scoping within one resource.
    expect(scope.map((entry) => entry.parameterName)).toStrictEqual(["id"]);
    const [entry] = scope;
    expect(entry?.kind).toBe("constant");
    expect(entry?.confirmedBy).toBeNull();
    expect(entry?.confirmedAt).toBeNull();
  });

  it("leaves EVERY derived scope entry unconfirmed across both real specs (SS-2 crit 5: used nowhere)", () => {
    for (const [ir, specId] of [
      [giteaIr, "spec-gitea"],
      [vikunjaIr, "spec-vikunja"],
    ] as const) {
      for (const binding of deriveResourceBindings(ir, capabilities(), specId)) {
        for (const entry of binding.scopePathBindings ?? []) {
          expect(entry.confirmedBy).toBeNull();
          expect(entry.confirmedAt).toBeNull();
        }
      }
    }
  });

  it("emits an EMPTY scope collection for a resource with no non-record-id path parameter (SS-1 crit 1)", async () => {
    // `/widgets` has query params only — no path parameters, so no scope set.
    const ir = await buildIr(widgetsSpec({ collectionParams: ["page"], fields: [] }));
    const binding = bindingFor(
      deriveResourceBindings(ir, capabilities(), "spec-widgets"),
      "widgets",
    );
    expect(binding.scopePathBindings).toStrictEqual([]);
  });

  it("prefills a heuristic candidate from a single-value enum / default / example, still unconfirmed (SS-2 crit 2)", () => {
    const ir: Ir = [
      {
        resourceRef: "things",
        name: "things",
        operations: [
          {
            operationId: "createThing",
            method: "put",
            path: "/tenants/{tenant}/things",
            parameters: [
              {
                name: "tenant",
                location: "path",
                required: true,
                type: "string",
                enumValues: ["acme"],
              },
            ],
          },
          {
            operationId: "listRegionThings",
            method: "get",
            path: "/regions/{region}/things",
            parameters: [
              { name: "region", location: "path", required: true, type: "string", default: "eu" },
            ],
          },
          {
            operationId: "listZoneThings",
            method: "get",
            path: "/zones/{zone}/things",
            parameters: [
              { name: "zone", location: "path", required: true, type: "string", example: "z1" },
            ],
          },
          {
            operationId: "listBucketThings",
            method: "get",
            path: "/buckets/{bucket}/things",
            // A MULTI-value enum is ambiguous → no candidate (empty value).
            parameters: [
              {
                name: "bucket",
                location: "path",
                required: true,
                type: "string",
                enumValues: ["a", "b"],
              },
            ],
          },
        ],
        schemas: [],
        crossResourceRefs: [],
      },
    ];
    const binding = bindingFor(deriveResourceBindings(ir, capabilities(), "spec-things"), "things");
    const byName = new Map(
      (binding.scopePathBindings ?? []).map((entry) => [entry.parameterName, entry] as const),
    );
    // Layer-1 entries are all `kind: "constant"`, so `value` is present.
    expect(byName.get("tenant")?.value).toBe("acme"); // single-value enum
    expect(byName.get("region")?.value).toBe("eu"); // schema default
    expect(byName.get("zone")?.value).toBe("z1"); // example
    expect(byName.get("bucket")?.value).toBe(""); // multi-value enum → no candidate
    // A prefilled candidate is still only a candidate — never confirmed.
    for (const entry of byName.values()) {
      expect(entry.confirmedBy).toBeNull();
      expect(entry.confirmedAt).toBeNull();
    }
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

describe("deriveResourceBindings — sourceScopeRef (SS-7)", () => {
  it("guesses a multi-component sourceScopeRef from a nested container object (Gitea Issue.repository)", () => {
    const binding = bindingFor(
      deriveResourceBindings(giteaIr, capabilities(), "spec-gitea"),
      "issues",
    );

    // Gitea `Issue` carries `repository → RepositoryMeta { owner, name, full_name, id }`;
    // owner + name are the container identity (composite `full_name`/`id` excluded).
    expect(binding.sourceScopeRef?.components).toStrictEqual([
      { key: "owner", fieldPath: "repository.owner" },
      { key: "name", fieldPath: "repository.name" },
    ]);
    // Unconfirmed — used nowhere until an operator confirms it (SS-7.4).
    expect(binding.sourceScopeRef?.confirmedBy).toBeNull();
    expect(binding.sourceScopeRef?.confirmedAt).toBeNull();
  });

  it("guesses a single-component sourceScopeRef from a <container>_id scalar (Vikunja Task.project_id)", () => {
    const binding = bindingFor(
      deriveResourceBindings(vikunjaIr, capabilities(), "spec-vikunja"),
      "tasks",
    );

    // Vikunja `Task` carries `project_id` (a scalar); the component keys on the
    // container noun (`project`), the id-suffix stripped from the leaf segment.
    expect(binding.sourceScopeRef?.components).toStrictEqual([
      { key: "project", fieldPath: "project_id" },
    ]);
    expect(binding.sourceScopeRef?.confirmedBy).toBeNull();
    expect(binding.sourceScopeRef?.confirmedAt).toBeNull();
  });

  it("is absent for a resource whose records carry no container field (SS-7.3)", async () => {
    // A widget record with only `id` + `title` — no container-noun object field and
    // no `<container>_id` scalar → record-derived scope is unavailable.
    const ir = await buildIr(widgetsSpec({ collectionParams: ["page"], fields: ["title"] }));
    const binding = bindingFor(
      deriveResourceBindings(ir, capabilities(), "spec-widgets"),
      "widgets",
    );
    expect(binding.sourceScopeRef).toBeUndefined();
    expect("sourceScopeRef" in binding).toBe(false);
  });

  it("does not mistake a non-container `<noun>_id` scalar for scope", async () => {
    // `author_id` is an id field but `author` is not a container noun → no guess.
    const ir = await buildIr(widgetsSpec({ collectionParams: ["page"], fields: ["author_id"] }));
    const binding = bindingFor(
      deriveResourceBindings(ir, capabilities(), "spec-widgets"),
      "widgets",
    );
    expect(binding.sourceScopeRef).toBeUndefined();
  });
});
