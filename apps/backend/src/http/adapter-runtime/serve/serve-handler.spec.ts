import type { ServeInput } from "@mediator/adapter-engine";
import type {
  AdapterBinding,
  AdapterBindingRole,
  AdapterEndpoint,
  ApprovedMappingStatus,
  FieldMapping,
  IrOperation,
  IrParameter,
  ParameterMapping,
  RegisteredAppStatus,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import type { BackendCallInput, BackendCallResult, BackendCaller } from "./backend-call.js";
import { AdapterServeHandler, type ServeLogger } from "./serve-handler.js";
import type { LoadedBinding, ServeContext, ServeContextLoader } from "./serve-context.js";

function param(
  overrides: Partial<IrParameter> & Pick<IrParameter, "name" | "location">,
): IrParameter {
  return { required: false, ...overrides };
}

const consumerGetTodo: IrOperation = {
  operationId: "getTodo",
  method: "get",
  path: "/todos/{todoId}",
  parameters: [param({ name: "todoId", location: "path", required: true })],
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
  parameters: [param({ name: "taskId", location: "path", required: true })],
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

const fullResponsePhase: readonly FieldMapping[] = [
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

function binding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: "binding-1",
    adapterEndpointId: "endpoint-1",
    backendAppId: "backend-app",
    backendOperationId: "tasks/getTask",
    approvedMappingId: "mapping-1",
    role: "primary",
    status: "active",
    ...overrides,
  };
}

function endpoint(): AdapterEndpoint {
  return {
    id: "endpoint-1",
    consumerAppId: "consumer-app",
    consumerOperationId: "todos/getTodo",
    status: "active",
  };
}

function loadedBinding(overrides: Partial<LoadedBinding> = {}): LoadedBinding {
  return {
    binding: binding(),
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [todoIdParamMapping],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: fullResponsePhase,
    backendBaseUrl: "http://backend.example",
    backendOperation: backendGetTask,
    ...overrides,
  };
}

function context(loaded: LoadedBinding): ServeContext {
  return { consumerOperation: consumerGetTodo, bindings: [loaded] };
}

function serveInput(todoId: string | null = "42"): ServeInput {
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "todos/getTodo",
      pathParameters: todoId === null ? {} : { todoId },
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: endpoint(),
    activeBindings: [binding()],
  };
}

class FakeBackendCaller implements BackendCaller {
  public calls = 0;
  public lastInput: BackendCallInput | undefined;
  public constructor(private readonly result: BackendCallResult) {}
  public call(input: BackendCallInput): Promise<BackendCallResult> {
    this.calls += 1;
    this.lastInput = input;
    return Promise.resolve(this.result);
  }
}

class RecordingLogger implements ServeLogger {
  public readonly warnings: {
    readonly fields: Record<string, unknown>;
    readonly message: string;
  }[] = [];
  public warn(fields: Record<string, unknown>, message: string): void {
    this.warnings.push({ fields, message });
  }
}

function fakeLoader(ctx: ServeContext): ServeContextLoader {
  return { load: () => Promise.resolve(ctx) };
}

function handlerFor(
  ctx: ServeContext,
  caller: FakeBackendCaller,
  logger: ServeLogger = new RecordingLogger(),
): AdapterServeHandler {
  return new AdapterServeHandler({ loader: fakeLoader(ctx), backendCaller: caller, logger });
}

const okBody: BackendCallResult = {
  ok: true,
  body: { task_id: "42", task_title: "Ship it", completed: true },
};

describe("AdapterServeHandler — the single-binding serve pipeline", () => {
  it("serves a healthy request, transformed to the consumer shape and schema-validated", async () => {
    const caller = new FakeBackendCaller(okBody);
    const outcome = await handlerFor(context(loadedBinding()), caller).serve(serveInput());
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "42", title: "Ship it", done: true },
      degraded: false,
      contributingBackendAppIds: ["backend-app"],
    });
    // TE-1 filled the backend path param from the consumer request.
    expect(caller.calls).toBe(1);
    expect(caller.lastInput?.mapped.pathParams).toEqual({ taskId: "42" });
  });

  it("RP-3.3: a stale mapping fails as mapping-stale with NO backend call", async () => {
    const caller = new FakeBackendCaller(okBody);
    const outcome = await handlerFor(
      context(loadedBinding({ mappingStatus: "stale" })),
      caller,
    ).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "mapping-stale" });
    expect(caller.calls).toBe(0);
  });

  it("RP-3.4: a suspended mapping fails as mapping-suspended with NO backend call", async () => {
    const caller = new FakeBackendCaller(okBody);
    const outcome = await handlerFor(
      context(loadedBinding({ mappingStatus: "suspended" as ApprovedMappingStatus })),
      caller,
    ).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "mapping-suspended" });
    expect(caller.calls).toBe(0);
  });

  it("RP-3.5: a disabled backend fails as backend-disabled with NO backend call", async () => {
    const caller = new FakeBackendCaller(okBody);
    const outcome = await handlerFor(
      context(loadedBinding({ backendStatus: "disabled" as RegisteredAppStatus })),
      caller,
    ).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "backend-disabled" });
    expect(caller.calls).toBe(0);
  });

  it("RP-2: a request missing a required consumer parameter is rejected (invalid-request), no backend call", async () => {
    const caller = new FakeBackendCaller(okBody);
    const outcome = await handlerFor(context(loadedBinding()), caller).serve(serveInput(null));
    expect(outcome).toEqual({
      kind: "rejected",
      reason: "invalid-request",
      detail: "missing required path parameter 'todoId'",
    });
    expect(caller.calls).toBe(0);
  });

  it("AG-7: a response the mapping cannot make schema-valid fails as mediator-transform-error (never the raw body)", async () => {
    const caller = new FakeBackendCaller(okBody);
    const logger = new RecordingLogger();
    // Response phase omits `done`, which the consumer schema requires.
    const outcome = await handlerFor(
      context(
        loadedBinding({
          responsePhaseFieldMappings: [
            rename("fm-id", "tasks/task_id", "todos/id"),
            rename("fm-title", "tasks/task_title", "todos/title"),
          ],
        }),
      ),
      caller,
      logger,
    ).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    // The transform succeeded but the aggregate was withheld — no served body escaped.
    expect(logger.warnings.some((w) => w.fields["cause"] === "mediator-transform-error")).toBe(
      true,
    );
  });

  it("a live backend failure surfaces as upstream-error naming the backend", async () => {
    const caller = new FakeBackendCaller({
      ok: false,
      kind: "upstream-error",
      detail: "backend app backend-app returned HTTP 503",
    });
    const outcome = await handlerFor(context(loadedBinding()), caller).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
  });

  it("TE-1.3: an unmapped required backend parameter refuses the call as a mediator defect", async () => {
    const caller = new FakeBackendCaller(okBody);
    // taskId is mapped (RP-2 passes), but the backend also requires `workspace`, which
    // no ParameterMapping fills — TE-1.3 refuses rather than calling with a hole.
    const backendWithExtraRequired: IrOperation = {
      ...backendGetTask,
      parameters: [
        param({ name: "taskId", location: "path", required: true }),
        param({ name: "workspace", location: "query", required: true }),
      ],
    };
    const outcome = await handlerFor(
      context(loadedBinding({ backendOperation: backendWithExtraRequired })),
      caller,
    ).serve(serveInput());
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    expect(caller.calls).toBe(0);
  });
});

// ── fanout-merge (AG-2) + chaining (TE-3) orchestration ──────────────────────

/** The consumer operation aggregated from two backends; `plan` is OPTIONAL (degradable). */
function consumerGetProfile(planRequired: boolean): IrOperation {
  return {
    operationId: "getProfile",
    method: "get",
    path: "/profiles/{userId}",
    parameters: [param({ name: "userId", location: "path", required: true })],
    responseSchema: {
      name: "Profile",
      fields: [
        { name: "id", type: "string", required: true },
        { name: "name", type: "string", required: true },
        { name: "plan", type: "string", required: planRequired },
      ],
    },
  };
}

const backendGetUser: IrOperation = {
  operationId: "getUser",
  method: "get",
  path: "/users/{userId}",
  parameters: [param({ name: "userId", location: "path", required: true })],
};
const backendGetEntitlement: IrOperation = {
  operationId: "getEntitlement",
  method: "get",
  path: "/entitlements/{userId}",
  parameters: [param({ name: "userId", location: "path", required: true })],
};

const userIdToUser: ParameterMapping = {
  id: "pm-user",
  operationMappingId: "om-user",
  sourceParamRef: "profiles/getProfile#userId",
  targetParamRef: "users/getUser#userId",
};
const userIdToEntitlement: ParameterMapping = {
  id: "pm-ent",
  operationMappingId: "om-ent",
  sourceParamRef: "profiles/getProfile#userId",
  targetParamRef: "entitlements/getEntitlement#userId",
};

/** Route backend calls + record order/inputs per backend app so orchestration is assertable. */
class MultiBackendCaller implements BackendCaller {
  public readonly order: string[] = [];
  public readonly inputsByApp = new Map<string, BackendCallInput[]>();
  public constructor(private readonly results: Map<string, BackendCallResult>) {}
  public call(input: BackendCallInput): Promise<BackendCallResult> {
    this.order.push(input.targetAppId);
    const list = this.inputsByApp.get(input.targetAppId) ?? [];
    list.push(input);
    this.inputsByApp.set(input.targetAppId, list);
    return Promise.resolve(
      this.results.get(input.targetAppId) ?? {
        ok: false,
        kind: "upstream-error",
        detail: `no stub for ${input.targetAppId}`,
      },
    );
  }
}

function primaryBinding(): AdapterBinding {
  return {
    id: "p",
    adapterEndpointId: "endpoint-1",
    backendAppId: "crm",
    backendOperationId: "users/getUser",
    approvedMappingId: "mapping-1",
    role: "primary",
    status: "active",
    executionOrder: 0,
  };
}
function supplementBinding(chained: boolean): AdapterBinding {
  return {
    id: "s",
    adapterEndpointId: "endpoint-1",
    backendAppId: "billing",
    backendOperationId: "entitlements/getEntitlement",
    approvedMappingId: "mapping-1",
    role: "supplement",
    status: "active",
    executionOrder: 1,
    ...(chained
      ? {
          dependsOnBindingId: "p",
          chainInputs: [
            { upstreamFieldPath: "id", targetParamRef: "entitlements/getEntitlement#userId" },
          ],
        }
      : {}),
  };
}

function loadedPrimary(): LoadedBinding {
  return {
    binding: primaryBinding(),
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [userIdToUser],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [
      rename("fm-uid", "users/user_id", "profiles/id"),
      rename("fm-uname", "users/user_name", "profiles/name"),
    ],
    backendBaseUrl: "http://crm.example",
    backendOperation: backendGetUser,
  };
}
function loadedSupplement(chained: boolean): LoadedBinding {
  return {
    binding: supplementBinding(chained),
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    // A chained supplement fills `userId` from the upstream response, not a ParameterMapping.
    parameterMappings: chained ? [] : [userIdToEntitlement],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: [rename("fm-plan", "entitlements/tier", "profiles/plan")],
    backendBaseUrl: "http://billing.example",
    backendOperation: backendGetEntitlement,
  };
}

function fanoutContext(planRequired: boolean, chained: boolean): ServeContext {
  return {
    consumerOperation: consumerGetProfile(planRequired),
    bindings: [loadedPrimary(), loadedSupplement(chained)],
  };
}

function fanoutEndpoint(strictness: "strict" | "degraded" = "degraded"): AdapterEndpoint {
  return {
    id: "endpoint-1",
    consumerAppId: "consumer-app",
    consumerOperationId: "profiles/getProfile",
    status: "active",
    aggregationStrategy: "fanout-merge",
    strictness,
  };
}

function fanoutInput(chained: boolean, strictness: "strict" | "degraded" = "degraded"): ServeInput {
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "profiles/getProfile",
      pathParameters: { userId: "u-9" },
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: fanoutEndpoint(strictness),
    activeBindings: [primaryBinding(), supplementBinding(chained)],
  };
}

const userOk: BackendCallResult = { ok: true, body: { user_id: "u-9", user_name: "Ada" } };
const entitlementOk: BackendCallResult = { ok: true, body: { tier: "pro" } };

function multiHandler(ctx: ServeContext, caller: MultiBackendCaller): AdapterServeHandler {
  return new AdapterServeHandler({
    loader: fakeLoader(ctx),
    backendCaller: caller,
    logger: new RecordingLogger(),
  });
}

describe("AdapterServeHandler — fanout-merge (AG-2)", () => {
  it("AG-2.1/2.6: assembles the primary base + supplement fields, both backends called", async () => {
    const caller = new MultiBackendCaller(
      new Map([
        ["crm", userOk],
        ["billing", entitlementOk],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, false), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "u-9", name: "Ada", plan: "pro" },
      degraded: false,
      contributingBackendAppIds: ["crm", "billing"],
    });
    expect(caller.order.sort()).toEqual(["billing", "crm"]);
  });

  it("AG-2.3: a failed supplement whose field is OPTIONAL degrades — field omitted, backend named", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", userOk],
        ["billing", { ok: false, kind: "upstream-error", detail: "HTTP 503" }],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, false), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "u-9", name: "Ada" },
      degraded: true,
      contributingBackendAppIds: ["crm"],
      degradedBackendAppIds: ["billing"],
    });
  });

  it("AG-2.4: a failed supplement whose field is REQUIRED fails the whole request even non-strict", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", userOk],
        ["billing", { ok: false, kind: "upstream-error", detail: "HTTP 503" }],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(true, false), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
  });

  it("AG-2.5: strict mode fails the whole request on a supplement failure (optional field notwithstanding)", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", userOk],
        ["billing", { ok: false, kind: "upstream-error", detail: "HTTP 503" }],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, false), caller).serve(
      fanoutInput(false, "strict"),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
  });

  it("AG-2.2: a failed primary fails the whole request (no degradation)", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", { ok: false, kind: "upstream-error", detail: "HTTP 500" }],
        ["billing", entitlementOk],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, false), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
  });
});

/**
 * **AL-1.2 — a disabled backend app follows the endpoint's NORMAL role/strictness
 * semantics.** The planner eliminates such a binding with the distinct
 * `backend-disabled` cause (RP-3.5) and the aggregator then treats it exactly like any
 * other contributor failure — no special-casing: a `supplement` supplying an optional
 * consumer field degrades the response, a `supplement` supplying a REQUIRED one fails the
 * request, `strict` fails on any of them, and a `primary` failure always fails.
 */
describe("AdapterServeHandler — a disabled backend under fanout-merge (AL-1.2)", () => {
  /** The fanout context with one side's backing app `disabled` (nothing else changed). */
  function disabledBackendContext(
    planRequired: boolean,
    disabled: "primary" | "supplement",
  ): ServeContext {
    const primary: LoadedBinding =
      disabled === "primary" ? { ...loadedPrimary(), backendStatus: "disabled" } : loadedPrimary();
    const supplement: LoadedBinding =
      disabled === "supplement"
        ? { ...loadedSupplement(false), backendStatus: "disabled" }
        : loadedSupplement(false);
    return { consumerOperation: consumerGetProfile(planRequired), bindings: [primary, supplement] };
  }

  const bothOk = new Map([
    ["crm", userOk],
    ["billing", entitlementOk],
  ]);

  it("a disabled SUPPLEMENT backend degrades the response under `degraded` — its optional field omitted, and it is never called", async () => {
    const caller = new MultiBackendCaller(bothOk);
    const outcome = await multiHandler(disabledBackendContext(false, "supplement"), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "u-9", name: "Ada" },
      degraded: true,
      contributingBackendAppIds: ["crm"],
      degradedBackendAppIds: ["billing"],
    });
    // Eliminated before dispatch: the disabled backend is never called.
    expect(caller.inputsByApp.has("billing")).toBe(false);
  });

  it("a disabled SUPPLEMENT backend supplying a REQUIRED field fails the request as backend-disabled", async () => {
    const caller = new MultiBackendCaller(bothOk);
    const outcome = await multiHandler(disabledBackendContext(true, "supplement"), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "backend-disabled" });
  });

  it("under `strict` a disabled supplement backend fails the whole request (optional field notwithstanding)", async () => {
    const caller = new MultiBackendCaller(bothOk);
    const outcome = await multiHandler(disabledBackendContext(false, "supplement"), caller).serve(
      fanoutInput(false, "strict"),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "backend-disabled" });
  });

  it("a disabled PRIMARY backend fails the whole request (no degradation), with no call at all", async () => {
    const caller = new MultiBackendCaller(bothOk);
    const outcome = await multiHandler(disabledBackendContext(false, "primary"), caller).serve(
      fanoutInput(false),
    );
    expect(outcome).toEqual({ kind: "failed", cause: "backend-disabled" });
    expect(caller.inputsByApp.has("crm")).toBe(false);
  });
});

describe("AdapterServeHandler — chained bindings (TE-3)", () => {
  it("TE-3.1/3.2: the chained supplement is called with a param filled from the upstream consumer shape", async () => {
    const caller = new MultiBackendCaller(
      new Map([
        ["crm", userOk],
        ["billing", entitlementOk],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, true), caller).serve(fanoutInput(true));
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "u-9", name: "Ada", plan: "pro" },
      degraded: false,
      contributingBackendAppIds: ["crm", "billing"],
    });
    // TE-3.1 — the upstream (crm) was called before the dependent (billing).
    expect(caller.order).toEqual(["crm", "billing"]);
    // TE-3.2/3.3 — billing's userId was filled from the upstream's consumer-shape `id` (u-9),
    // never a native backend field or the raw request.
    const billing = caller.inputsByApp.get("billing")?.[0];
    expect(billing?.mapped.pathParams).toEqual({ userId: "u-9" });
  });

  it("TE-3.4: a null upstream chain value fails the dependent (named), the upstream having SUCCEEDED", async () => {
    // The upstream SUCCEEDS but its consumer-shape `id` is null (value-preserving rename),
    // so the chain input is absent → the dependent is refused, never dispatched (TE-3.4).
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", { ok: true, body: { user_id: null, user_name: "Ada" } }],
        ["billing", entitlementOk],
      ]),
    );
    // `plan` is required here so the dependent's failure surfaces as a whole-request failure.
    const outcome = await multiHandler(fanoutContext(true, true), caller).serve(fanoutInput(true));
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    // The dependent backend was never called with a hole.
    expect(caller.inputsByApp.has("billing")).toBe(false);
  });

  it("TE-3.5: when the upstream fails, the dependent is not called (dependent failure)", async () => {
    const caller = new MultiBackendCaller(
      new Map<string, BackendCallResult>([
        ["crm", { ok: false, kind: "upstream-error", detail: "HTTP 500" }],
        ["billing", entitlementOk],
      ]),
    );
    const outcome = await multiHandler(fanoutContext(false, true), caller).serve(fanoutInput(true));
    // The primary failed → whole request fails; the dependent supplement was never called.
    expect(outcome).toEqual({ kind: "failed", cause: "upstream-error" });
    expect(caller.inputsByApp.has("billing")).toBe(false);
  });
});

// ── fanout-first-success (AG-6) ordered fallback ─────────────────────────────

/** A single-object consumer op served by whichever backend answers first. */
const consumerGetThing: IrOperation = {
  operationId: "getThing",
  method: "get",
  path: "/things/{thingId}",
  parameters: [param({ name: "thingId", location: "path", required: true })],
  responseSchema: {
    name: "Thing",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "title", type: "string", required: true },
    ],
  },
};

/** A backend `GET /{resource}/{id}` operation; each alternative backend has its own resource. */
function backendGet(resource: string): IrOperation {
  return {
    operationId: `get_${resource}`,
    method: "get",
    path: `/${resource}/{id}`,
    parameters: [param({ name: "id", location: "path", required: true })],
  };
}

function thingIdParam(resource: string): ParameterMapping {
  return {
    id: `pm-${resource}`,
    operationMappingId: `om-${resource}`,
    sourceParamRef: "things/getThing#thingId",
    targetParamRef: `${resource}/get_${resource}#id`,
  };
}

/** Map a backend's native `{resource}_id`/`{resource}_name` to the consumer `{id,title}` shape. */
function thingResponsePhase(resource: string): readonly FieldMapping[] {
  return [
    rename(`fm-${resource}-id`, `${resource}/${resource}_id`, "things/id"),
    rename(`fm-${resource}-title`, `${resource}/${resource}_name`, "things/title"),
  ];
}

/** A `fanout-first-success` binding: its own backend app + resource, role, and executionOrder. */
function ffsBinding(
  id: string,
  role: AdapterBindingRole,
  backendAppId: string,
  resource: string,
  executionOrder: number,
): AdapterBinding {
  return {
    id,
    adapterEndpointId: "endpoint-ffs",
    backendAppId,
    backendOperationId: `${resource}/get_${resource}`,
    approvedMappingId: "mapping-1",
    role,
    status: "active",
    executionOrder,
  };
}

function ffsLoaded(
  bind: AdapterBinding,
  resource: string,
  overrides: Partial<LoadedBinding> = {},
): LoadedBinding {
  return {
    binding: bind,
    mappingId: "mapping-1",
    mappingStatus: "active",
    backendStatus: "active",
    parameterMappings: [thingIdParam(resource)],
    requestPhaseFieldMappings: [],
    responsePhaseFieldMappings: thingResponsePhase(resource),
    backendBaseUrl: `http://${bind.backendAppId}.example`,
    backendOperation: backendGet(resource),
    ...overrides,
  };
}

function ffsEndpoint(): AdapterEndpoint {
  return {
    id: "endpoint-ffs",
    consumerAppId: "consumer-app",
    consumerOperationId: "things/getThing",
    status: "active",
    aggregationStrategy: "fanout-first-success",
    strictness: "degraded",
  };
}

function ffsInput(activeBindings: readonly AdapterBinding[]): ServeInput {
  return {
    request: {
      consumerAppId: "consumer-app",
      operationKey: "things/getThing",
      pathParameters: { thingId: "1" },
      query: {},
      headers: {},
      body: undefined,
    },
    endpoint: ffsEndpoint(),
    activeBindings,
  };
}

/** A backend success returning a resource-tagged body (so the winner is identifiable). */
function thingOk(resource: string): BackendCallResult {
  return { ok: true, body: { [`${resource}_id`]: "1", [`${resource}_name`]: `from-${resource}` } };
}
const upstream500: BackendCallResult = { ok: false, kind: "upstream-error", detail: "HTTP 500" };

describe("AdapterServeHandler — fanout-first-success (AG-6)", () => {
  it("AG-6.2: a succeeding primary short-circuits — the fallback backend is never called", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const fallback = ffsBinding("f", "fallback", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(primary, "alpha"), ffsLoaded(fallback, "bravo")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", thingOk("alpha")],
        // A success is scripted for the fallback too — proving it is never CALLED, not that it fails.
        ["bravo-app", thingOk("bravo")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, fallback]));
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "1", title: "from-alpha" },
      degraded: false,
      contributingBackendAppIds: ["alpha-app"],
    });
    // AG-6.2 — the load-bearing invariant: only the primary was called.
    expect(caller.order).toEqual(["alpha-app"]);
  });

  it("AG-6.2: a failing primary falls to the first fallback; a later fallback is never called", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const f1 = ffsBinding("f1", "fallback", "bravo-app", "bravo", 1);
    const f2 = ffsBinding("f2", "fallback", "charlie-app", "charlie", 2);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(primary, "alpha"), ffsLoaded(f1, "bravo"), ffsLoaded(f2, "charlie")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", upstream500],
        ["bravo-app", thingOk("bravo")],
        ["charlie-app", thingOk("charlie")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, f1, f2]));
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "1", title: "from-bravo" },
      degraded: false,
      contributingBackendAppIds: ["bravo-app"],
    });
    // Exactly the primary + first fallback were tried; the second fallback never ran.
    expect(caller.order).toEqual(["alpha-app", "bravo-app"]);
  });

  it("AG-6.1: the primary is tried FIRST even when a fallback has a lower executionOrder", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 9);
    const fallback = ffsBinding("f", "fallback", "bravo-app", "bravo", 0);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(primary, "alpha"), ffsLoaded(fallback, "bravo")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", upstream500],
        ["bravo-app", thingOk("bravo")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, fallback]));
    expect(outcome.kind).toBe("served");
    // The primary (order 9) was tried before the fallback (order 0) — order by role, not number.
    expect(caller.order).toEqual(["alpha-app", "bravo-app"]);
  });

  it("AG-6.1: fallbacks are tried in ascending executionOrder", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    // f2 (order 2) is listed BEFORE f1 (order 1); ordering must still try f1 first.
    const f2 = ffsBinding("f2", "fallback", "charlie-app", "charlie", 2);
    const f1 = ffsBinding("f1", "fallback", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(primary, "alpha"), ffsLoaded(f2, "charlie"), ffsLoaded(f1, "bravo")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", upstream500],
        ["bravo-app", upstream500],
        ["charlie-app", thingOk("charlie")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, f2, f1]));
    expect(outcome.kind).toBe("served");
    if (outcome.kind !== "served") return;
    expect(outcome.body).toEqual({ id: "1", title: "from-charlie" });
    expect(caller.order).toEqual(["alpha-app", "bravo-app", "charlie-app"]);
  });

  it("AG-6.3: an eliminated (stale) binding is skipped WITHOUT a call; the next is tried", async () => {
    // The primary's mapping is stale → the planner eliminates it; the walk skips it (no call).
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const fallback = ffsBinding("f", "fallback", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [
        ffsLoaded(primary, "alpha", { mappingStatus: "stale" }),
        ffsLoaded(fallback, "bravo"),
      ],
    };
    const caller = new MultiBackendCaller(new Map([["bravo-app", thingOk("bravo")]]));
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, fallback]));
    expect(outcome).toEqual({
      kind: "served",
      body: { id: "1", title: "from-bravo" },
      degraded: false,
      contributingBackendAppIds: ["bravo-app"],
    });
    // The eliminated primary was never called; only the fallback ran.
    expect(caller.order).toEqual(["bravo-app"]);
  });

  it("AG-6.3: a mix of eliminated + live-failed bindings is walked until one succeeds", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const f1 = ffsBinding("f1", "fallback", "bravo-app", "bravo", 1);
    const f2 = ffsBinding("f2", "fallback", "charlie-app", "charlie", 2);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [
        // primary eliminated (suspended), f1 a live failure, f2 succeeds.
        ffsLoaded(primary, "alpha", { mappingStatus: "suspended" }),
        ffsLoaded(f1, "bravo"),
        ffsLoaded(f2, "charlie"),
      ],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["bravo-app", upstream500],
        ["charlie-app", thingOk("charlie")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, f1, f2]));
    expect(outcome).toMatchObject({ kind: "served", body: { id: "1", title: "from-charlie" } });
    // primary skipped (eliminated), f1 called + failed, f2 called + won.
    expect(caller.order).toEqual(["bravo-app", "charlie-app"]);
  });

  it("AG-6.4: an all-stale chain fails as mapping-stale, calling no backend", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const fallback = ffsBinding("f", "fallback", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [
        ffsLoaded(primary, "alpha", { mappingStatus: "stale" }),
        ffsLoaded(fallback, "bravo", { mappingStatus: "stale" }),
      ],
    };
    const caller = new MultiBackendCaller(new Map());
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, fallback]));
    expect(outcome).toEqual({ kind: "failed", cause: "mapping-stale" });
    expect(caller.order).toEqual([]);
  });

  it("AG-6.4: an exhausted mixed chain reports the primary's cause (never a generic upstream error)", async () => {
    // Primary stale (eliminated), fallback a live upstream failure → the chain reports the
    // primary's mapping-stale, NOT the fallback's upstream-error.
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const fallback = ffsBinding("f", "fallback", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [
        ffsLoaded(primary, "alpha", { mappingStatus: "stale" }),
        ffsLoaded(fallback, "bravo"),
      ],
    };
    const caller = new MultiBackendCaller(new Map([["bravo-app", upstream500]]));
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([primary, fallback]));
    expect(outcome).toEqual({ kind: "failed", cause: "mapping-stale" });
    expect(caller.order).toEqual(["bravo-app"]);
  });

  it("AG-6.1 role defense: a supplement in the set fails loud as mediator-transform-error, no call", async () => {
    const primary = ffsBinding("p", "primary", "alpha-app", "alpha", 0);
    const supplement = ffsBinding("s", "supplement", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(primary, "alpha"), ffsLoaded(supplement, "bravo")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", thingOk("alpha")],
        ["bravo-app", thingOk("bravo")],
      ]),
    );
    const logger = new RecordingLogger();
    const handler = new AdapterServeHandler({
      loader: fakeLoader(ctx),
      backendCaller: caller,
      logger,
    });
    const outcome = await handler.serve(ffsInput([primary, supplement]));
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    // The composition defect is caught before any binding runs.
    expect(caller.order).toEqual([]);
    expect(logger.warnings.some((w) => w.fields["cause"] === "mediator-transform-error")).toBe(
      true,
    );
  });

  it("AG-6.1 role defense: a primary count ≠ 1 (two primaries) fails loud, no call", async () => {
    const p1 = ffsBinding("p1", "primary", "alpha-app", "alpha", 0);
    const p2 = ffsBinding("p2", "primary", "bravo-app", "bravo", 1);
    const ctx: ServeContext = {
      consumerOperation: consumerGetThing,
      bindings: [ffsLoaded(p1, "alpha"), ffsLoaded(p2, "bravo")],
    };
    const caller = new MultiBackendCaller(
      new Map([
        ["alpha-app", thingOk("alpha")],
        ["bravo-app", thingOk("bravo")],
      ]),
    );
    const outcome = await multiHandler(ctx, caller).serve(ffsInput([p1, p2]));
    expect(outcome).toEqual({ kind: "failed", cause: "mediator-transform-error" });
    expect(caller.order).toEqual([]);
  });
});
