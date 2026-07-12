import type { FieldMapping, TransformConfig } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { applyFieldMapping, applyFieldMappings, collectTouchedFields } from "./executor.js";
import { isTransformError, type TransformErrorKind } from "./errors.js";
import type { JsonRecord } from "./json.js";

/** Build a `FieldMapping` fixture without passing `undefined` optionals. */
function field(spec: {
  id?: string;
  sourcePath: string;
  targetPath: string;
  transform: FieldMapping["transform"];
  transformConfig?: TransformConfig;
}): FieldMapping {
  return {
    id: spec.id ?? "fm-1",
    mappingId: "am-1",
    sourcePath: spec.sourcePath,
    targetPath: spec.targetPath,
    transform: spec.transform,
    ...(spec.transformConfig === undefined ? {} : { transformConfig: spec.transformConfig }),
  };
}

function expectKind(fn: () => unknown, kind: TransformErrorKind, fieldMappingId?: string): void {
  try {
    fn();
    throw new Error(`expected a '${kind}' transform error`);
  } catch (error) {
    expect(isTransformError(error)).toBe(true);
    if (isTransformError(error)) {
      expect(error.kind).toBe(kind);
      if (fieldMappingId !== undefined) {
        expect(error.fieldMappingId).toBe(fieldMappingId);
      }
    }
  }
}

describe("TX-1 — dispatch assembles the target payload from source data", () => {
  it("applies each FieldMapping, reading sourcePath and writing targetPath", () => {
    const source: JsonRecord = { issue: { title: "Bug", state: "open" } };
    const fields = [
      field({ id: "a", sourcePath: "issue.title", targetPath: "task.name", transform: "rename" }),
      field({
        id: "b",
        sourcePath: "issue.state",
        targetPath: "task.done",
        transform: "coerce",
        transformConfig: {
          coerce: { to: "boolean", from: "enum", truthy: ["closed"], falsy: ["open"] },
        },
      }),
    ];
    const { output } = applyFieldMappings(fields, source);
    expect(output).toEqual({ task: { name: "Bug", done: false } });
  });
});

describe("TX-1.2 — rename is value-preserving", () => {
  it("carries the source value unchanged (including null)", () => {
    expect(
      applyFieldMapping(field({ sourcePath: "a", targetPath: "b", transform: "rename" }), {
        a: "keep",
      }).value,
    ).toBe("keep");
    expect(
      applyFieldMapping(field({ sourcePath: "a", targetPath: "b", transform: "rename" }), {
        a: null,
      }).value,
    ).toBe(null);
  });
});

describe("TX-1.4 — determinism (identical inputs → byte-identical output)", () => {
  it("produces byte-identical output for the same mapping applied twice", () => {
    const source: JsonRecord = { user: { first: "ada", last: "Lovelace" }, ms: 1710000000000 };
    const fields = [
      field({
        id: "name",
        sourcePath: "user.first",
        targetPath: "full",
        transform: "expression",
        transformConfig: {
          additionalInputPaths: ["user.last"],
          expression: 'concat(upper(first), " ", last)',
        },
      }),
      field({
        id: "when",
        sourcePath: "ms",
        targetPath: "at",
        transform: "coerce",
        transformConfig: {
          coerce: {
            to: "date",
            from: "date",
            sourceFormat: "epoch-millis",
            targetFormat: "iso-8601",
          },
        },
      }),
    ];
    const first = applyFieldMappings(fields, source);
    const second = applyFieldMappings(fields, source);
    expect(JSON.stringify(first.output)).toBe(JSON.stringify(second.output));
  });
});

describe("TX-1.5 — a transform runs only in its declared direction (never inverted)", () => {
  it("reads sourcePath and writes targetPath, never the reverse", () => {
    const mapping = field({ sourcePath: "a", targetPath: "b", transform: "rename" });
    // Forward: a → b.
    expect(applyFieldMappings([mapping], { a: "v" }).output).toEqual({ b: "v" });
    // A record carrying only the *target* path is not read as an input — proving the
    // executor never inverts the mapping to read `b` and write `a`.
    expectKind(() => applyFieldMappings([mapping], { b: "v" }), "missing-input");
  });
});

describe("TX-2 — aggregate multi-input and the which-fields-touched accounting", () => {
  const aggregate = field({
    id: "full",
    sourcePath: "first",
    targetPath: "fullName",
    transform: "aggregate",
    transformConfig: {
      additionalInputPaths: ["last"],
      aggregate: { strategy: "concat", separator: " ", onMissingInput: "error" },
    },
  });

  it("combines the primary and additional inputs", () => {
    expect(applyFieldMapping(aggregate, { first: "Ada", last: "Lovelace" }).value).toBe(
      "Ada Lovelace",
    );
  });

  it("accounts for every input (primary + additional) and the output", () => {
    const trace = collectTouchedFields([aggregate]);
    expect(trace.inputs).toEqual(["first", "last"]);
    expect(trace.outputs).toEqual(["fullName"]);
    expect(trace.perField[0]).toEqual({
      fieldMappingId: "full",
      inputs: ["first", "last"],
      output: "fullName",
    });
  });

  it("unions inputs and outputs across multiple field mappings, de-duplicated", () => {
    const other = field({
      id: "greet",
      sourcePath: "first",
      targetPath: "greeting",
      transform: "rename",
    });
    const trace = collectTouchedFields([aggregate, other]);
    expect(trace.inputs).toEqual(["first", "last"]);
    expect(trace.outputs).toEqual(["fullName", "greeting"]);
    expect(trace.perField).toHaveLength(2);
  });

  it("resolves a missing additional input deterministically per policy (TX-2.3)", () => {
    const skipping = field({
      id: "full",
      sourcePath: "first",
      targetPath: "fullName",
      transform: "aggregate",
      transformConfig: {
        additionalInputPaths: ["last"],
        aggregate: { strategy: "concat", separator: " ", onMissingInput: "skip" },
      },
    });
    expect(applyFieldMapping(skipping, { first: "Ada" }).value).toBe("Ada");
    expectKind(() => applyFieldMapping(aggregate, { first: "Ada" }), "aggregate-error", "full");
  });
});

describe("TX-3 — expression via the executor", () => {
  it("evaluates an expression over the mapping's inputs", () => {
    const expr = field({
      id: "e",
      sourcePath: "first",
      targetPath: "full",
      transform: "expression",
      transformConfig: { additionalInputPaths: ["last"], expression: 'first + " " + last' },
    });
    expect(applyFieldMapping(expr, { first: "Ada", last: "Lovelace" }).value).toBe("Ada Lovelace");
  });

  it("resolves an absent declared input to the null placeholder (TX-3.4)", () => {
    const expr = field({
      id: "e",
      sourcePath: "first",
      targetPath: "full",
      transform: "expression",
      transformConfig: { additionalInputPaths: ["last"], expression: 'coalesce(last, "?")' },
    });
    expect(applyFieldMapping(expr, { first: "Ada" }).value).toBe("?");
  });

  it("attributes a sandbox rejection to the field id (TX-4.5 / TX-5)", () => {
    const expr = field({
      id: "danger",
      sourcePath: "first",
      targetPath: "full",
      transform: "expression",
      transformConfig: { expression: "first.constructor" },
    });
    expectKind(() => applyFieldMapping(expr, { first: "Ada" }), "expression-rejected", "danger");
  });
});

describe("TX-5 — transform errors surface; never a silent or partial payload", () => {
  it("fails the whole assembly on the first field that cannot produce a value", () => {
    const source: JsonRecord = { a: "keep", n: "not-a-number" };
    const fields = [
      field({ id: "ok", sourcePath: "a", targetPath: "kept", transform: "rename" }),
      field({
        id: "bad",
        sourcePath: "n",
        targetPath: "num",
        transform: "coerce",
        transformConfig: { coerce: { to: "number", from: "string" } },
      }),
    ];
    // The failing field surfaces as a distinct transform error attributed to it —
    // no partial payload is returned (TX-5 criterion 1 & 2).
    expectKind(() => applyFieldMappings(fields, source), "impossible-coercion", "bad");
  });

  it("raises invalid-config when a field's transformConfig does not match its kind", () => {
    expectKind(
      () =>
        applyFieldMapping(field({ sourcePath: "a", targetPath: "b", transform: "coerce" }), {
          a: "x",
        }),
      "invalid-config",
    );
    expectKind(
      () =>
        applyFieldMapping(field({ sourcePath: "a", targetPath: "b", transform: "expression" }), {
          a: "x",
        }),
      "invalid-config",
    );
    expectKind(
      () =>
        applyFieldMapping(
          field({
            sourcePath: "a",
            targetPath: "b",
            transform: "aggregate",
            transformConfig: { aggregate: { strategy: "sum", onMissingInput: "error" } },
          }),
          { a: 1 },
        ),
      "invalid-config",
    );
  });

  it("raises invalid-config when expression input paths collide on a binding name", () => {
    const expr = field({
      sourcePath: "user.name",
      targetPath: "out",
      transform: "expression",
      transformConfig: { additionalInputPaths: ["account.name"], expression: "name" },
    });
    expectKind(
      () => applyFieldMapping(expr, { user: { name: "a" }, account: { name: "b" } }),
      "invalid-config",
    );
  });
});

describe("execution is synchronous and pure (no async I/O, no LLM) — TX-5.4", () => {
  it("returns a plain value synchronously, not a promise", () => {
    const result = applyFieldMapping(
      field({ sourcePath: "a", targetPath: "b", transform: "rename" }),
      { a: 1 },
    );
    expect(result.value).toBe(1);
    expect(result).not.toBeInstanceOf(Promise);
  });
});
