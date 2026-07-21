import type { IrOperation } from "@mediator/domain";
import type { RestPaginationConvention } from "@mediator/outbound";
import type { JsonValue } from "@mediator/transform";
import { describe, expect, it } from "vitest";

import type { BackendCallInput, BackendCallResult, BackendCaller } from "./backend-call.js";
import type { MappedBackendRequest } from "./request-mapping.js";
import { RestUnionCollectionReader, type UnionCollectionReadInput } from "./union-fetch.js";

/** A fake caller returning a scripted body per successive page call (record inputs for assertions). */
class ScriptedCaller implements BackendCaller {
  public readonly calls: BackendCallInput[] = [];
  public constructor(private readonly bodies: readonly (JsonValue | undefined)[]) {}
  public call(input: BackendCallInput): Promise<BackendCallResult> {
    this.calls.push(input);
    const body = this.bodies[this.calls.length - 1];
    return Promise.resolve({ ok: true, body });
  }
}

class FailingCaller implements BackendCaller {
  public constructor(private readonly result: BackendCallResult) {}
  public call(): Promise<BackendCallResult> {
    return Promise.resolve(this.result);
  }
}

const listOp: IrOperation = { operationId: "list", method: "get", path: "/tasks", parameters: [] };

function emptyMapped(): MappedBackendRequest {
  return { pathParams: {}, queryParams: [], headerParams: [], body: undefined };
}

function input(
  overrides: Partial<UnionCollectionReadInput> & Pick<UnionCollectionReadInput, "pagination">,
): UnionCollectionReadInput {
  return {
    backendAppId: "backend-a",
    baseUrl: "http://backend.example",
    operation: listOp,
    baseRequest: emptyMapped(),
    recordsPath: undefined,
    nativeIdFieldPath: "id",
    rowCeiling: 100,
    ...overrides,
  };
}

const offsetPagination: RestPaginationConvention = {
  kind: "offset",
  offsetParam: "offset",
  limitParam: "limit",
  pageSize: 2,
};

describe("RestUnionCollectionReader — AG-5 bounded paged fetch", () => {
  it("pages to exhaustion (an EMPTY page ends it), accumulating rows + native-id provenance", async () => {
    const caller = new ScriptedCaller([[{ id: "1" }, { id: "2" }], [{ id: "3" }], []]);
    const read = await new RestUnionCollectionReader(caller).read(
      input({ pagination: offsetPagination }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.rows).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(read.nativeIds).toEqual(["1", "2", "3"]);
    // 3 calls: two non-empty pages + the terminating empty page.
    expect(caller.calls).toHaveLength(3);
    // Offset advances by the ACTUAL received count (0 → 2 → 3), never by pageSize.
    expect(
      caller.calls.map((c) => c.mapped.queryParams.find((p) => p.name === "offset")?.value),
    ).toEqual(["0", "2", "3"]);
  });

  it("AG-5.2 fails loud (never truncates) when the row ceiling is exceeded", async () => {
    const caller = new ScriptedCaller([[{ id: "1" }, { id: "2" }, { id: "3" }]]);
    const read = await new RestUnionCollectionReader(caller).read(
      input({ pagination: offsetPagination, rowCeiling: 2 }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("ceiling-exceeded");
    expect(read.detail).toContain("backend-a");
    expect(read.detail).toContain("2");
  });

  it("single-page: one call, no pagination params sent", async () => {
    const caller = new ScriptedCaller([[{ id: "1" }]]);
    const read = await new RestUnionCollectionReader(caller).read(
      input({ pagination: { kind: "single-page" } }),
    );
    expect(read.ok && read.rows).toEqual([{ id: "1" }]);
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]?.mapped.queryParams).toEqual([]);
  });

  it("a live upstream failure surfaces as `upstream-error` (a droppable contributor)", async () => {
    const read = await new RestUnionCollectionReader(
      new FailingCaller({ ok: false, kind: "upstream-error", detail: "HTTP 503" }),
    ).read(input({ pagination: { kind: "single-page" } }));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("upstream-error");
  });

  it("extracts rows from a wrapper `recordsPath` and omits provenance when nativeIdFieldPath is absent", async () => {
    const caller = new ScriptedCaller([{ data: [{ id: "1" }, { id: "2" }] }, { data: [] }]);
    const read = await new RestUnionCollectionReader(caller).read(
      input({ pagination: offsetPagination, recordsPath: "data", nativeIdFieldPath: undefined }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.rows).toEqual([{ id: "1" }, { id: "2" }]);
    expect(read.nativeIds).toEqual([undefined, undefined]);
  });

  it("a malformed (non-array) collection body is a defect, never a silently-empty page", async () => {
    const read = await new RestUnionCollectionReader(
      new ScriptedCaller([{ not: "an array" }]),
    ).read(input({ pagination: { kind: "single-page" } }));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.kind).toBe("defect");
  });
});
