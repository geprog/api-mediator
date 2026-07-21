import type { ServeInput } from "@mediator/adapter-engine";
import type {
  AdapterBinding,
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
