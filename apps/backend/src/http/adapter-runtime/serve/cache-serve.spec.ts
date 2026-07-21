import type { ServeInput } from "@mediator/adapter-engine";
import type {
  AdapterBinding,
  AdapterEndpoint,
  AdapterWriteOutcome,
  FieldMapping,
  IrOperation,
  ParameterMapping,
  ResourceBinding,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { BackendCallInput, BackendCallResult, BackendCaller } from "./backend-call.js";
import type { CacheInvalidator } from "./cache-invalidator.js";
import {
  InProcessResponseCache,
  type ResponseCache,
  type ResponseCacheEntry,
  type ResponseCacheMetrics,
} from "./response-cache.js";
import { AdapterServeHandler, type ServeLogger } from "./serve-handler.js";
import type { LoadedBinding, ServeContext, ServeContextLoader } from "./serve-context.js";
import type {
  UnionCollectionReadInput,
  UnionCollectionReadResult,
  UnionCollectionReader,
} from "./union-fetch.js";
import type { RecordWriteOutcomeInput, WriteOutcomeStore } from "./write-outcome-store.js";

/**
 * CH-1/CH-2 — the response-cache read path of {@link AdapterServeHandler}: a hit
 * short-circuits every backend call, no `cacheTtl` caches nothing, the normalized key
 * distinguishes values, the TTL is the staleness bound, and only complete/valid responses
 * enter the cache (degraded/failed/write never do). Ordering/encoding-insensitivity of the
 * key itself is unit-tested in `response-cache.spec.ts`; here we assert the handler's
 * observable behavior (backend call counts + hit/miss metric).
 */

// ── single-read fixtures ─────────────────────────────────────────────────────

const consumerGetTodo: IrOperation = {
  operationId: "getTodo",
  method: "get",
  path: "/todos/{todoId}",
  parameters: [{ name: "todoId", location: "path", required: true, type: "string" }],
  responseSchema: {
    name: "Todo",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "done", type: "boolean", required: true },
    ],
  },
};

const backendGetTask: IrOperation = {
  operationId: "getTask",
  method: "get",
  path: "/tasks/{taskId}",
  parameters: [{ name: "taskId", location: "path", required: true, type: "string" }],
};

function rename(id: string, sourcePath: string, targetPath: string): FieldMapping {
  return {
    id,
    mappingId: "mapping-1",
    sourcePath,
    targetPath,
    transform: "rename",
    phase: "response",
  };
}

const responsePhase: readonly FieldMapping[] = [
  rename("fm-id", "tasks/task_id", "todos/id"),
  rename("fm-title", "tasks/task_title", "todos/title"),
  rename("fm-done", "tasks/completed", "todos/done"),
];

const todoIdParamMapping: ParameterMapping = {
  id: "pm-1",
  operationMappingId: "om-1",
  sourceParamRef: "todos/getTodo#todoId",
  targetParamRef: "tasks/getTask#taskId",
};

function binding(): AdapterBinding {
  return {
    id: "binding-1",
    adapterEndpointId: "endpoint-1",
    backendAppId: "backend-app",
    backendOperationId: "tasks/getTask",
    approvedMappingId: "mapping-1",
    role: "primary",
    status: "active",
  };
}

function endpoint(cacheTtl?: number): AdapterEndpoint {
  return {
    id: "endpoint-1",
    consumerAppId: "consumer-app",
    consumerOperationId: "todos/getTodo",
    status: "active",
    aggregationStrategy: "single",
    ...(cacheTtl !== undefined ? { cacheTtl } : {}),
  };
}

function loadedBinding(): LoadedBinding {
  return {
    binding: binding(),
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [todoIdParamMapping],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: responsePhase,
    backendBaseUrl: "http://backend.example",
    backendOperation: backendGetTask,
  };
}

function context(loaded: LoadedBinding = loadedBinding()): ServeContext {
  return { consumerOperation: consumerGetTodo, bindings: [loaded] };
}

function serveInput(todoId: string, cacheTtl?: number): ServeInput {
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "todos/getTodo",
      pathParameters: { todoId },
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: endpoint(cacheTtl),
    activeBindings: [binding()],
  };
}

const okBody: BackendCallResult = {
  ok: true,
  body: { task_id: "42", task_title: "Ship it", completed: true },
};
const servedTodo = { id: "42", title: "Ship it", done: true };

/**
 * A backend body whose mapped consumer shape violates the consumer response schema: `completed`
 * is a string, so the renamed `done` is a string where the schema requires a boolean — an AG-7
 * `mediator-transform-error` (the transform succeeds; validation rejects the shape).
 */
const agSevenBody: BackendCallResult = {
  ok: true,
  body: { task_id: "42", task_title: "Ship it", completed: "not-a-boolean" },
};

// ── fanout-merge fixtures (for the degraded CH-2 case) ───────────────────────

const consumerGetProfile: IrOperation = {
  operationId: "getProfile",
  method: "get",
  path: "/profiles/{userId}",
  parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
  responseSchema: {
    name: "Profile",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "name", type: "string", required: true },
      { name: "plan", type: "string", required: false },
    ],
  },
};
const backendGetUser: IrOperation = {
  operationId: "getUser",
  method: "get",
  path: "/users/{userId}",
  parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
};
const backendGetEntitlement: IrOperation = {
  operationId: "getEntitlement",
  method: "get",
  path: "/entitlements/{userId}",
  parameters: [{ name: "userId", location: "path", required: true, type: "string" }],
};

function fanoutContext(): ServeContext {
  const primary: LoadedBinding = {
    binding: {
      id: "p",
      adapterEndpointId: "endpoint-f",
      backendAppId: "crm",
      backendOperationId: "users/getUser",
      approvedMappingId: "mapping-1",
      role: "primary",
      status: "active",
      executionOrder: 0,
    },
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [
      {
        id: "pm-user",
        operationMappingId: "om-user",
        sourceParamRef: "profiles/getProfile#userId",
        targetParamRef: "users/getUser#userId",
      },
    ],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [
      rename("fm-uid", "users/user_id", "profiles/id"),
      rename("fm-uname", "users/user_name", "profiles/name"),
    ],
    backendBaseUrl: "http://crm.example",
    backendOperation: backendGetUser,
  };
  const supplement: LoadedBinding = {
    binding: {
      id: "s",
      adapterEndpointId: "endpoint-f",
      backendAppId: "billing",
      backendOperationId: "entitlements/getEntitlement",
      approvedMappingId: "mapping-1",
      role: "supplement",
      status: "active",
      executionOrder: 1,
    },
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [
      {
        id: "pm-ent",
        operationMappingId: "om-ent",
        sourceParamRef: "profiles/getProfile#userId",
        targetParamRef: "entitlements/getEntitlement#userId",
      },
    ],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [rename("fm-plan", "entitlements/tier", "profiles/plan")],
    backendBaseUrl: "http://billing.example",
    backendOperation: backendGetEntitlement,
  };
  return { consumerOperation: consumerGetProfile, bindings: [primary, supplement] };
}

function fanoutInput(cacheTtl: number): ServeInput {
  const bindings = fanoutContext().bindings.map((loaded) => loaded.binding);
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "profiles/getProfile",
      pathParameters: { userId: "u-9" },
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: {
      id: "endpoint-f",
      consumerAppId: "consumer-app",
      consumerOperationId: "profiles/getProfile",
      status: "active",
      aggregationStrategy: "fanout-merge",
      strictness: "degraded",
      cacheTtl,
    },
    activeBindings: bindings,
  };
}

// ── write fixtures (for the CH-2 write sanity case) ──────────────────────────

const consumerCreateTodo: IrOperation = {
  operationId: "createTodo",
  method: "post",
  path: "/todos",
  parameters: [],
  requestSchema: { name: "NewTodo", fields: [{ name: "title", type: "string", required: true }] },
  responseSchema: {
    name: "Todo",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "title", type: "string", required: true },
      { name: "done", type: "boolean", required: true },
    ],
  },
};
const backendCreateTask: IrOperation = {
  operationId: "createTask",
  method: "post",
  path: "/tasks",
  parameters: [],
};
const createdTask: BackendCallResult = {
  ok: true,
  body: { task_id: "t-1", task_title: "Ship it", completed: false },
};

function writeContext(): ServeContext {
  return {
    consumerOperation: consumerCreateTodo,
    bindings: [
      {
        binding: {
          id: "binding-w",
          adapterEndpointId: "endpoint-w",
          backendAppId: "backend-app",
          backendOperationId: "tasks/createTask",
          approvedMappingId: "mapping-1",
          role: "primary",
          status: "active",
        },
        mappingId: "mapping-1",
        mappingStatus: "active",
        backendStatus: "active",
        action: "create",
        parameterMappings: [],
        requestPhaseFieldMappings: [],
        responsePhaseFieldMappings: [
          rename("fm-id", "tasks/task_id", "todos/id"),
          rename("fm-title", "tasks/task_title", "todos/title"),
          rename("fm-done", "tasks/completed", "todos/done"),
        ],
        backendBaseUrl: "http://backend.example",
        backendOperation: backendCreateTask,
      },
    ],
  };
}

function writeInput(cacheTtl: number): ServeInput {
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "todos/createTodo",
      pathParameters: {},
      query: {},
      headers: {},
      body: { title: "Ship it" },
    },
    endpoint: {
      id: "endpoint-w",
      consumerAppId: "consumer-app",
      consumerOperationId: "todos/createTodo",
      status: "active",
      aggregationStrategy: "single",
      cacheTtl,
    },
    activeBindings: [
      {
        id: "binding-w",
        adapterEndpointId: "endpoint-w",
        backendAppId: "backend-app",
        backendOperationId: "tasks/createTask",
        approvedMappingId: "mapping-1",
        role: "primary",
        status: "active",
      },
    ],
  };
}

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeBackendCaller implements BackendCaller {
  public calls = 0;
  public constructor(private readonly result: BackendCallResult) {}
  public call(): Promise<BackendCallResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

/** Routes per-backend-app results; a missing stub is an upstream error (a droppable failure). */
class MultiBackendCaller implements BackendCaller {
  public calls = 0;
  public constructor(private readonly results: Map<string, BackendCallResult>) {}
  public call(input: BackendCallInput): Promise<BackendCallResult> {
    this.calls += 1;
    return Promise.resolve(
      this.results.get(input.targetAppId) ?? {
        ok: false,
        kind: "upstream-error",
        detail: `no stub for ${input.targetAppId}`,
      },
    );
  }
}

/** Wraps the REAL in-process cache but records every get/set so CH-2 gating is assertable. */
class RecordingResponseCache implements ResponseCache {
  public getCount = 0;
  public readonly sets: ResponseCacheEntry[] = [];
  readonly #inner = new InProcessResponseCache();
  public get(
    endpointId: string,
    normalizedParams: string,
    now: Date,
  ): ResponseCacheEntry | undefined {
    this.getCount += 1;
    return this.#inner.get(endpointId, normalizedParams, now);
  }
  public set(entry: ResponseCacheEntry, now: Date): void {
    this.sets.push(entry);
    this.#inner.set(entry, now);
  }
  public dropByBackendResource(backendAppId: string, resourceRef: string): void {
    this.#inner.dropByBackendResource(backendAppId, resourceRef);
  }
  public dropByEndpoint(endpointId: string): void {
    this.#inner.dropByEndpoint(endpointId);
  }
}

class RecordingCacheMetrics implements ResponseCacheMetrics {
  public readonly hits: { operationKey: string; endpointId: string }[] = [];
  public readonly misses: { operationKey: string; endpointId: string }[] = [];
  public recordCacheHit(operationKey: string, endpointId: string): void {
    this.hits.push({ operationKey, endpointId });
  }
  public recordCacheMiss(operationKey: string, endpointId: string): void {
    this.misses.push({ operationKey, endpointId });
  }
}

class RecordingLogger implements ServeLogger {
  public readonly warnings: { fields: Record<string, unknown>; message: string }[] = [];
  public warn(fields: Record<string, unknown>, message: string): void {
    this.warnings.push({ fields, message });
  }
}

/** A minimal in-window write-outcome store so a write serves successfully (WR-3 fake). */
class FakeWriteOutcomeStore implements WriteOutcomeStore {
  public lookup(): Promise<AdapterWriteOutcome | undefined> {
    return Promise.resolve(undefined);
  }
  public record(input: RecordWriteOutcomeInput): Promise<AdapterWriteOutcome> {
    const now = new Date(0);
    return Promise.resolve({
      id: "wo-1",
      idempotencyKey: input.idempotencyKey,
      adapterEndpointId: input.adapterEndpointId,
      adapterBindingId: input.adapterBindingId,
      result: input.result,
      executedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
  }
}

function fakeLoader(ctx: ServeContext): ServeContextLoader {
  return { load: () => Promise.resolve(ctx) };
}

interface HandlerOpts {
  readonly ctx: ServeContext;
  readonly caller: BackendCaller;
  readonly cache?: ResponseCache;
  readonly metrics?: ResponseCacheMetrics;
  readonly now?: () => Date;
  readonly writeOutcomeStore?: WriteOutcomeStore;
  readonly unionCollectionReader?: UnionCollectionReader;
  readonly cacheInvalidator?: CacheInvalidator;
}

function buildHandler(opts: HandlerOpts): AdapterServeHandler {
  return new AdapterServeHandler({
    loader: fakeLoader(opts.ctx),
    backendCaller: opts.caller,
    logger: new RecordingLogger(),
    ...(opts.cache !== undefined ? { responseCache: opts.cache } : {}),
    ...(opts.metrics !== undefined ? { cacheMetrics: opts.metrics } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.writeOutcomeStore !== undefined ? { writeOutcomeStore: opts.writeOutcomeStore } : {}),
    ...(opts.unionCollectionReader !== undefined
      ? { unionCollectionReader: opts.unionCollectionReader }
      : {}),
    ...(opts.cacheInvalidator !== undefined ? { cacheInvalidator: opts.cacheInvalidator } : {}),
  });
}

/** Records every `(backendAppId, resourceRef)` the write path invalidates through the seam. */
class SpyCacheInvalidator implements CacheInvalidator {
  public readonly calls: { backendAppId: string; resourceRef: string }[] = [];
  public readonly endpointCalls: string[] = [];
  public invalidateBackendResource(backendAppId: string, resourceRef: string): void {
    this.calls.push({ backendAppId, resourceRef });
  }
  public invalidateEndpoint(endpointId: string): void {
    this.endpointCalls.push(endpointId);
  }
}

// ── collection-union fixtures (for the CH-2.5 dropped-contributor case) ───────

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

function backendListOp(resource: string): IrOperation {
  return { operationId: `list_${resource}`, method: "get", path: `/${resource}`, parameters: [] };
}

/** A minimal confirmed-nothing `ResourceBinding` → single-page paging, no native-id dedup. */
function unionResourceBinding(resource: string): ResourceBinding {
  return { id: `rb-${resource}`, apiSpecId: `spec-${resource}`, resourceRef: resource };
}

function unionSupplement(
  bindingId: string,
  backendAppId: string,
  resource: string,
  idField: string,
  titleField: string,
): LoadedBinding {
  return {
    binding: {
      id: bindingId,
      adapterEndpointId: "endpoint-u",
      backendAppId,
      backendOperationId: `${resource}/list_${resource}`,
      approvedMappingId: "mapping-1",
      role: "supplement",
      status: "active",
      executionOrder: 0,
    },
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [
      rename(`fm-${bindingId}-id`, `${resource}/${idField}`, "todos/id"),
      rename(`fm-${bindingId}-title`, `${resource}/${titleField}`, "todos/title"),
    ],
    backendBaseUrl: `http://${backendAppId}.example`,
    backendOperation: backendListOp(resource),
    backendResourceBinding: unionResourceBinding(resource),
  };
}

function unionContext(): ServeContext {
  return {
    consumerOperation: consumerListTodos,
    bindings: [
      unionSupplement("u-tasks", "tasks-app", "tasks", "task_id", "task_title"),
      unionSupplement("u-issues", "issues-app", "issues", "issue_id", "issue_title"),
    ],
  };
}

function unionInput(cacheTtl: number): ServeInput {
  const bindings = unionContext().bindings.map((loaded) => loaded.binding);
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "todos/listTodos",
      pathParameters: {},
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: {
      id: "endpoint-u",
      consumerAppId: "consumer-app",
      consumerOperationId: "todos/listTodos",
      status: "active",
      aggregationStrategy: "collection-union",
      strictness: "degraded",
      postMergeDedup: { mode: "none" },
      cacheTtl,
    },
    activeBindings: bindings,
  };
}

/** Routes a union contributor's paged read per backend app; a missing stub is an upstream error. */
class FakeUnionCollectionReader implements UnionCollectionReader {
  public constructor(private readonly results: Map<string, UnionCollectionReadResult>) {}
  public read(input: UnionCollectionReadInput): Promise<UnionCollectionReadResult> {
    return Promise.resolve(
      this.results.get(input.backendAppId) ?? {
        ok: false,
        kind: "upstream-error",
        detail: `no stub for ${input.backendAppId}`,
      },
    );
  }
}

// ── CH-1 ─────────────────────────────────────────────────────────────────────

describe("AdapterServeHandler — response cache (CH-1)", () => {
  it("CH-1.1: an equivalent read within the TTL is served from cache with NO 2nd backend call", async () => {
    const caller = new FakeBackendCaller(okBody);
    const cache = new RecordingResponseCache();
    const metrics = new RecordingCacheMetrics();
    const clock = { value: new Date(0) };
    const handler = buildHandler({
      ctx: context(),
      caller,
      cache,
      metrics,
      now: () => clock.value,
    });

    const first = await handler.serve(serveInput("42", 30_000));
    expect(first).toEqual({
      kind: "served",
      body: servedTodo,
      degraded: false,
      contributingBackendAppIds: ["backend-app"],
    });
    expect(caller.calls).toBe(1);
    expect(cache.sets).toHaveLength(1);
    // CH-3/CH-4 forward-wiring — the (backendAppId, resourceRef) set is captured on the entry.
    expect(cache.sets[0]?.contributingBackendResources).toEqual([
      { backendAppId: "backend-app", resourceRef: "tasks" },
    ]);
    expect(metrics.misses).toHaveLength(1);
    expect(metrics.hits).toHaveLength(0);

    clock.value = new Date(10_000); // still inside the 30s TTL
    const second = await handler.serve(serveInput("42", 30_000));
    expect(second).toEqual(first);
    expect(caller.calls).toBe(1); // CH-1.1 — the backend was NOT called again
    expect(metrics.hits).toEqual([{ operationKey: "todos/getTodo", endpointId: "endpoint-1" }]);
  });

  it("CH-1.3: an endpoint with NO cacheTtl caches nothing — the backend is called every time", async () => {
    const caller = new FakeBackendCaller(okBody);
    const cache = new RecordingResponseCache();
    const metrics = new RecordingCacheMetrics();
    const handler = buildHandler({ ctx: context(), caller, cache, metrics });

    await handler.serve(serveInput("42")); // no cacheTtl
    await handler.serve(serveInput("42"));

    expect(caller.calls).toBe(2);
    expect(cache.getCount).toBe(0); // the cache path is skipped entirely
    expect(cache.sets).toHaveLength(0);
    expect(metrics.hits).toHaveLength(0);
    expect(metrics.misses).toHaveLength(0);
  });

  it("CH-1.2: a different path value is a MISS (backend re-called); an identical request is a HIT", async () => {
    const caller = new FakeBackendCaller(okBody);
    const cache = new RecordingResponseCache();
    const handler = buildHandler({ ctx: context(), caller, cache });

    await handler.serve(serveInput("42", 30_000)); // miss → call #1, cached
    await handler.serve(serveInput("42", 30_000)); // hit → still #1
    expect(caller.calls).toBe(1);

    await handler.serve(serveInput("43", 30_000)); // different value → miss → call #2
    expect(caller.calls).toBe(2);
  });

  it("CH-1.4: once the TTL elapses the next request is a miss and re-calls the backend", async () => {
    const caller = new FakeBackendCaller(okBody);
    const cache = new RecordingResponseCache();
    const metrics = new RecordingCacheMetrics();
    const clock = { value: new Date(0) };
    const handler = buildHandler({
      ctx: context(),
      caller,
      cache,
      metrics,
      now: () => clock.value,
    });

    await handler.serve(serveInput("42", 5_000)); // call #1, cached, expires at 5000
    clock.value = new Date(4_999);
    await handler.serve(serveInput("42", 5_000)); // hit
    expect(caller.calls).toBe(1);

    clock.value = new Date(5_000); // exactly at expiry → elapsed
    await handler.serve(serveInput("42", 5_000)); // miss → call #2
    expect(caller.calls).toBe(2);
    expect(metrics.hits).toHaveLength(1);
    expect(metrics.misses).toHaveLength(2);
  });
});

// ── CH-2 ─────────────────────────────────────────────────────────────────────

describe("AdapterServeHandler — only complete, valid responses are cached (CH-2)", () => {
  it("CH-2.2: a degraded response (failed optional supplement) is NOT cached", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", { ok: true, body: { user_id: "u-9", user_name: "Ada" } }],
        ["billing", { ok: false, kind: "upstream-error", detail: "HTTP 503" }],
      ]),
    );
    const cache = new RecordingResponseCache();
    const outcome = await buildHandler({ ctx: fanoutContext(), caller, cache }).serve(
      fanoutInput(30_000),
    );
    expect(outcome).toMatchObject({
      kind: "served",
      degraded: true,
      degradedBackendAppIds: ["billing"],
    });
    // A union response with a DROPPED contributor (AG-3.2) surfaces as degraded too, so it
    // is excluded by this exact same gate.
    expect(cache.sets).toHaveLength(0);
  });

  it("CH-2.3: a failed (upstream-error) response is NOT cached and is not replayed", async () => {
    const caller = new FakeBackendCaller({ ok: false, kind: "upstream-error", detail: "HTTP 500" });
    const cache = new RecordingResponseCache();
    const handler = buildHandler({ ctx: context(), caller, cache });

    const first = await handler.serve(serveInput("42", 30_000));
    expect(first.kind).toBe("failed");
    expect(cache.sets).toHaveLength(0);

    await handler.serve(serveInput("42", 30_000));
    expect(caller.calls).toBe(2); // no frozen failure — the backend is called again
  });

  it("CH-2.4 (sanity): a write is never cached — the cache is neither consulted nor written", async () => {
    const caller = new FakeBackendCaller(createdTask);
    const cache = new RecordingResponseCache();
    const outcome = await buildHandler({
      ctx: writeContext(),
      caller,
      cache,
      writeOutcomeStore: new FakeWriteOutcomeStore(),
    }).serve(writeInput(30_000));

    expect(outcome).toMatchObject({
      kind: "served",
      body: { id: "t-1", title: "Ship it", done: false },
    });
    expect(cache.getCount).toBe(0); // a write never even looks the cache up
    expect(cache.sets).toHaveLength(0); // …and never writes it
  });

  it("CH-2.1: an AG-7 mediator-transform-error response is NOT cached", async () => {
    // The mapped `done` is a string where the consumer schema requires a boolean → AG-7 fails.
    const caller = new FakeBackendCaller(agSevenBody);
    const cache = new RecordingResponseCache();
    const handler = buildHandler({ ctx: context(), caller, cache });

    const first = await handler.serve(serveInput("42", 30_000));
    expect(first).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    expect(cache.sets).toHaveLength(0);

    // Not frozen: the next equivalent read re-runs the (still-defective) backend flow rather
    // than replaying a cached failure.
    await handler.serve(serveInput("42", 30_000));
    expect(caller.calls).toBe(2);
  });

  it("CH-2.5: a collection-union response served with a DROPPED contributor is NOT cached", async () => {
    // `tasks-app` yields a row; `issues-app` has no stub → upstream error → dropped (AG-3.2).
    const reader = new FakeUnionCollectionReader(
      new Map<string, UnionCollectionReadResult>([
        [
          "tasks-app",
          { ok: true, rows: [{ task_id: "t1", task_title: "Alpha" }], nativeIds: [undefined] },
        ],
      ]),
    );
    const cache = new RecordingResponseCache();
    const outcome = await buildHandler({
      ctx: unionContext(),
      caller: new FakeBackendCaller(okBody), // unused: the union reads via the union reader
      cache,
      unionCollectionReader: reader,
    }).serve(unionInput(30_000));

    expect(outcome).toMatchObject({
      kind: "served",
      degraded: true,
      degradedBackendAppIds: ["issues-app"],
      body: [{ id: "t1", title: "Alpha" }],
    });
    // The dropped contributor makes it degraded, so — exactly like a failed supplement — it is
    // excluded from the cache directly (CH-2.5), not merely by the shared CH-2.2 comment.
    expect(cache.sets).toHaveLength(0);
  });
});

// ── CH-4 (adapter-write invalidation seam) ───────────────────────────────────

describe("AdapterServeHandler — successful writes invalidate through the shared seam (CH-4)", () => {
  it("CH-4.1/4.3: a successful write calls the CacheInvalidator with the written (backendAppId, resourceRef)", async () => {
    const invalidator = new SpyCacheInvalidator();
    const outcome = await buildHandler({
      ctx: writeContext(),
      caller: new FakeBackendCaller(createdTask),
      writeOutcomeStore: new FakeWriteOutcomeStore(),
      cacheInvalidator: invalidator,
    }).serve(writeInput(30_000));

    expect(outcome).toMatchObject({ kind: "served" });
    // The write binding is `backend-app`'s `tasks/createTask` → resource ref `tasks`. It routes
    // through the SAME seam the CH-3 SyncEvent consumer uses — never a parallel mechanism.
    expect(invalidator.calls).toEqual([{ backendAppId: "backend-app", resourceRef: "tasks" }]);
  });

  it("CH-4.5/WR-4.5: a FAILED write invalidates nothing", async () => {
    const invalidator = new SpyCacheInvalidator();
    const outcome = await buildHandler({
      ctx: writeContext(),
      caller: new FakeBackendCaller({
        ok: false,
        kind: "upstream-error",
        detail: "HTTP 500",
        reachedBackend: true,
      }),
      writeOutcomeStore: new FakeWriteOutcomeStore(),
      cacheInvalidator: invalidator,
    }).serve(writeInput(30_000));

    expect(outcome.kind).toBe("failed");
    expect(invalidator.calls).toHaveLength(0);
  });
});
