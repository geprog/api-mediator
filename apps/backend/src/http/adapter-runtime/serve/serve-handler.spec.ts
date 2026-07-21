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
