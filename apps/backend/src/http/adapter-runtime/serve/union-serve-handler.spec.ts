import type { ServeInput } from "@mediator/adapter-engine";
import type {
  AdapterBinding,
  AdapterEndpoint,
  IrOperation,
  ResourceBinding,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { BackendCallResult, BackendCaller } from "./backend-call.js";
import { AdapterServeHandler, type ServeLogger } from "./serve-handler.js";
import type { LoadedBinding, ServeContext, ServeContextLoader } from "./serve-context.js";
import type {
  UnionCollectionReadInput,
  UnionCollectionReadResult,
  UnionCollectionReader,
} from "./union-fetch.js";
import type { UnionLinkResolver } from "./union-links.js";

/**
 * Handler-level orchestration of the `collection-union` serve path (AG-3/4/5): fetch each
 * contributor through the (faked) bounded reader, map to consumer shape, aggregate, and
 * validate (AG-7). Exercises the wiring the pure aggregator/fetch/link unit tests do not:
 * the degraded-header out-of-band signal, the row-ceiling fail-loud + its own telemetry
 * signal (AG-5.5), and record-link dedup collapsing across contributors.
 */

const consumerListTodos: IrOperation = {
  operationId: "listTodos",
  method: "get",
  path: "/todos",
  parameters: [],
  responseSchema: {
    name: "Todo",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "title", type: "string", required: true },
    ],
  },
};

function listOp(resource: string): IrOperation {
  return { operationId: `list_${resource}`, method: "get", path: `/${resource}`, parameters: [] };
}

function backendRb(resource: string): ResourceBinding {
  const now = new Date();
  return {
    id: `rb-${resource}`,
    apiSpecId: "spec",
    resourceRef: resource,
    nativeIdRef: { value: { kind: "field", path: "id" }, confirmedBy: "op", confirmedAt: now },
    collectionReadRef: {
      value: { kind: "operation", operationId: `list_${resource}` },
      confirmedBy: "op",
      confirmedAt: now,
    },
    scopePathBindings: [],
  };
}

function unionBinding(id: string, backendAppId: string, resource: string): AdapterBinding {
  return {
    id,
    adapterEndpointId: "e1",
    backendAppId,
    backendOperationId: `${resource}/list_${resource}`,
    approvedMappingId: "m1",
    role: "supplement",
    status: "active",
    executionOrder: 0,
  };
}

function loaded(binding: AdapterBinding, resource: string): LoadedBinding {
  return {
    binding,
    mappingId: "m1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [],
    backendBaseUrl: "http://backend.example",
    backendOperation: listOp(resource),
    backendResourceBinding: backendRb(resource),
  };
}

function unionEndpoint(overrides: Partial<AdapterEndpoint> = {}): AdapterEndpoint {
  return {
    id: "e1",
    consumerAppId: "consumer",
    consumerOperationId: "todos/listTodos",
    status: "active",
    aggregationStrategy: "collection-union",
    strictness: "degraded",
    ...overrides,
  };
}

function serveInput(endpoint: AdapterEndpoint, bindings: readonly AdapterBinding[]): ServeInput {
  return {
    request: {
      consumerAppId: "consumer",
      operationKey: "todos/listTodos",
      pathParameters: {},
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint,
    activeBindings: bindings,
  };
}

class FakeLoader implements ServeContextLoader {
  public constructor(private readonly ctx: ServeContext) {}
  public load(): Promise<ServeContext> {
    return Promise.resolve(this.ctx);
  }
}

/** A union reader scripted per backend app id. */
class FakeUnionReader implements UnionCollectionReader {
  public constructor(private readonly byApp: Record<string, UnionCollectionReadResult>) {}
  public read(input: UnionCollectionReadInput): Promise<UnionCollectionReadResult> {
    const result = this.byApp[input.backendAppId];
    return Promise.resolve(result ?? { ok: false, kind: "defect", detail: "no script" });
  }
}

class FakeLinkResolver implements UnionLinkResolver {
  public constructor(
    private readonly groups: ReadonlyMap<string, readonly (string | undefined)[]>,
  ) {}
  public resolve(): Promise<ReadonlyMap<string, readonly (string | undefined)[]>> {
    return Promise.resolve(this.groups);
  }
}

class RecordingLogger implements ServeLogger {
  public readonly warnings: { fields: Record<string, unknown>; message: string }[] = [];
  public warn(fields: Record<string, unknown>, message: string): void {
    this.warnings.push({ fields, message });
  }
}

const nullCaller: BackendCaller = {
  call: (): Promise<BackendCallResult> =>
    Promise.resolve({ ok: false, kind: "upstream-error", detail: "unused" }),
};

describe("AdapterServeHandler — collection-union (AG-3/4/5)", () => {
  it("merges two contributors into one consumer-schema-valid list, naming the backends out of band", async () => {
    const a = unionBinding("a", "backend-a", "tasks");
    const b = unionBinding("b", "backend-b", "issues");
    const ctx: ServeContext = {
      consumerOperation: consumerListTodos,
      bindings: [loaded(a, "tasks"), loaded(b, "issues")],
    };
    const reader = new FakeUnionReader({
      "backend-a": { ok: true, rows: [{ id: "1", title: "A" }], nativeIds: ["1"] },
      "backend-b": { ok: true, rows: [{ id: "2", title: "B" }], nativeIds: ["2"] },
    });
    const handler = new AdapterServeHandler({
      loader: new FakeLoader(ctx),
      backendCaller: nullCaller,
      logger: new RecordingLogger(),
      unionCollectionReader: reader,
    });
    const outcome = await handler.serve(serveInput(unionEndpoint(), [a, b]));
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") return;
    expect(outcome.body).toEqual([
      { id: "1", title: "A" },
      { id: "2", title: "B" },
    ]);
    expect(outcome.degraded).toBe(false);
    expect([...outcome.contributingBackendAppIds].sort()).toEqual(["backend-a", "backend-b"]);
  });

  it("AG-3.2 drops a failed contributor (non-strict) and names it via degradedBackendAppIds", async () => {
    const a = unionBinding("a", "backend-a", "tasks");
    const b = unionBinding("b", "backend-b", "issues");
    const ctx: ServeContext = {
      consumerOperation: consumerListTodos,
      bindings: [loaded(a, "tasks"), loaded(b, "issues")],
    };
    const reader = new FakeUnionReader({
      "backend-a": { ok: true, rows: [{ id: "1", title: "A" }], nativeIds: ["1"] },
      "backend-b": { ok: false, kind: "upstream-error", detail: "HTTP 503" },
    });
    const outcome = await new AdapterServeHandler({
      loader: new FakeLoader(ctx),
      backendCaller: nullCaller,
      logger: new RecordingLogger(),
      unionCollectionReader: reader,
    }).serve(serveInput(unionEndpoint(), [a, b]));
    expect(outcome).toMatchObject({
      kind: "served",
      body: [{ id: "1", title: "A" }],
      degraded: true,
      degradedBackendAppIds: ["backend-b"],
    });
  });

  it("AG-5.2/5.5 a row-ceiling breach fails loud (upstream-error) and emits its OWN telemetry signal", async () => {
    const a = unionBinding("a", "backend-a", "tasks");
    const ctx: ServeContext = {
      consumerOperation: consumerListTodos,
      bindings: [loaded(a, "tasks")],
    };
    const reader = new FakeUnionReader({
      "backend-a": {
        ok: false,
        kind: "ceiling-exceeded",
        detail: "backend app backend-a exceeded the union row ceiling of 2",
      },
    });
    const logger = new RecordingLogger();
    const outcome = await new AdapterServeHandler({
      loader: new FakeLoader(ctx),
      backendCaller: nullCaller,
      logger,
      unionCollectionReader: reader,
    }).serve(serveInput(unionEndpoint(), [a]));
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
    const signal = logger.warnings.find((w) => w.fields.signal === "union-row-ceiling-exceeded");
    expect(signal).toBeDefined();
    expect(signal?.fields.backendAppId).toBe("backend-a");
  });

  it("AG-3.3 record-link dedup collapses paired rows across contributors", async () => {
    const a = unionBinding("a", "backend-a", "tasks");
    const b = unionBinding("b", "backend-b", "issues");
    const ctx: ServeContext = {
      consumerOperation: consumerListTodos,
      bindings: [loaded(a, "tasks"), loaded(b, "issues")],
    };
    const reader = new FakeUnionReader({
      "backend-a": { ok: true, rows: [{ id: "A1", title: "from-a" }], nativeIds: ["A1"] },
      "backend-b": { ok: true, rows: [{ id: "B1", title: "from-b" }], nativeIds: ["B1"] },
    });
    const links = new FakeLinkResolver(
      new Map([
        ["a", ["g1"]],
        ["b", ["g1"]],
      ]),
    );
    const outcome = await new AdapterServeHandler({
      loader: new FakeLoader(ctx),
      backendCaller: nullCaller,
      logger: new RecordingLogger(),
      unionCollectionReader: reader,
      unionLinkResolver: links,
    }).serve(serveInput(unionEndpoint({ postMergeDedup: { mode: "record-link" } }), [a, b]));
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") return;
    // The two link-paired rows collapse into one (order-0 tie → binding id `a` wins the fields).
    expect(outcome.body).toEqual([{ id: "A1", title: "from-a" }]);
  });

  it("record-link dedup without a wired link resolver fails loud (a composition-root gap)", async () => {
    const a = unionBinding("a", "backend-a", "tasks");
    const ctx: ServeContext = {
      consumerOperation: consumerListTodos,
      bindings: [loaded(a, "tasks")],
    };
    const reader = new FakeUnionReader({
      "backend-a": { ok: true, rows: [{ id: "1", title: "A" }], nativeIds: ["1"] },
    });
    const outcome = await new AdapterServeHandler({
      loader: new FakeLoader(ctx),
      backendCaller: nullCaller,
      logger: new RecordingLogger(),
      unionCollectionReader: reader,
      // no unionLinkResolver wired
    }).serve(serveInput(unionEndpoint({ postMergeDedup: { mode: "record-link" } }), [a]));
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
  });
});
