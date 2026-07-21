import type { AdapterRequest } from "@mediator/adapter-engine";
import type {
  ChainInput,
  FieldMapping,
  IrOperation,
  IrParameter,
  ParameterMapping,
} from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  buildConsumerParamSource,
  mapRequestToBackend,
  mappedConsumerParamNames,
  paramRefBareName,
  resolveChainInputs,
} from "./request-mapping.js";

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
};

const backendGetTask: IrOperation = {
  operationId: "getTask",
  method: "get",
  path: "/tasks/{taskId}",
  parameters: [param({ name: "taskId", location: "path", required: true })],
};

function paramMapping(overrides: Partial<ParameterMapping> = {}): ParameterMapping {
  return {
    id: "pm-1",
    operationMappingId: "om-1",
    sourceParamRef: "todos/getTodo#todoId",
    targetParamRef: "tasks/getTask#taskId",
    ...overrides,
  };
}

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    consumerAppId: "consumer-app",
    operationKey: "todos/getTodo",
    pathParameters: {},
    query: {},
    headers: {},
    body: undefined,
    ...overrides,
  };
}

describe("paramRefBareName", () => {
  it("extracts the bare parameter name / operation id", () => {
    expect(paramRefBareName("todos/getTodo#todoId")).toBe("todoId");
    expect(paramRefBareName("tasks/getTask")).toBe("getTask");
    expect(paramRefBareName("bare")).toBe("bare");
  });
});

describe("mappedConsumerParamNames", () => {
  it("collects source parameters + additional transform inputs", () => {
    const names = mappedConsumerParamNames([
      paramMapping(),
      paramMapping({
        id: "pm-2",
        sourceParamRef: "todos/getTodo#a",
        targetParamRef: "tasks/getTask#b",
        transformConfig: { additionalInputPaths: ["todos/getTodo#c"] },
      }),
    ]);
    expect([...names].sort()).toEqual(["a", "c", "todoId"]);
  });
});

describe("buildConsumerParamSource", () => {
  it("keys supplied parameter values by bare name (absent params omitted)", () => {
    const source = buildConsumerParamSource(
      consumerGetTodo,
      request({ pathParameters: { todoId: "42" } }),
    );
    expect(source).toEqual({ todoId: "42" });
  });
});

describe("mapRequestToBackend — TE-1", () => {
  it("fills a backend path parameter from a rename ParameterMapping", () => {
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetTask,
      parameterMappings: [paramMapping()],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.pathParams).toEqual({ taskId: "42" });
    expect(result.request.body).toBeUndefined();
  });

  it("TE-1.3: refuses the call when a required backend parameter has no mapping", () => {
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetTask,
      parameterMappings: [],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("missing required backend parameter 'taskId'");
  });

  it("leaves a backend parameter unfilled when its optional consumer source is absent", () => {
    const backendWithOptionalQuery: IrOperation = {
      ...backendGetTask,
      parameters: [
        param({ name: "taskId", location: "path", required: true }),
        param({ name: "expand", location: "query", required: false }),
      ],
    };
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: {
        ...consumerGetTodo,
        parameters: [
          param({ name: "todoId", location: "path", required: true }),
          param({ name: "expand", location: "query", required: false }),
        ],
      },
      backendOperation: backendWithOptionalQuery,
      parameterMappings: [
        paramMapping(),
        paramMapping({
          id: "pm-2",
          sourceParamRef: "todos/getTodo#expand",
          targetParamRef: "tasks/getTask#expand",
        }),
      ],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.pathParams).toEqual({ taskId: "42" });
    expect(result.request.queryParams).toEqual([]);
  });

  it("rejects a ParameterMapping whose target the backend operation does not declare", () => {
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetTask,
      parameterMappings: [
        paramMapping({ targetParamRef: "tasks/getTask#nonexistent" }),
        paramMapping({ id: "pm-2", targetParamRef: "tasks/getTask#taskId" }),
      ],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("not declared");
  });

  it("builds the backend body from request-phase field mappings", () => {
    const consumerCreate: IrOperation = {
      operationId: "createTodo",
      method: "post",
      path: "/todos",
      parameters: [],
    };
    const backendCreate: IrOperation = {
      operationId: "createTask",
      method: "post",
      path: "/tasks",
      parameters: [],
    };
    const requestPhase: FieldMapping[] = [
      {
        id: "fm-1",
        mappingId: "mapping-1",
        sourcePath: "todos/title",
        targetPath: "tasks/task_title",
        transform: "rename",
        phase: "request",
      },
    ];
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerCreate,
      backendOperation: backendCreate,
      parameterMappings: [],
      requestPhaseFieldMappings: requestPhase,
      request: request({ body: { title: "Buy milk" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({ task_title: "Buy milk" });
  });

  const consumerCreate: IrOperation = {
    operationId: "createTodo",
    method: "post",
    path: "/todos",
    parameters: [],
  };
  const backendCreate: IrOperation = {
    operationId: "createTask",
    method: "post",
    path: "/tasks",
    parameters: [],
  };
  function requestBodyRename(id: string, source: string, target: string): FieldMapping {
    return {
      id,
      mappingId: "mapping-1",
      sourcePath: source,
      targetPath: target,
      transform: "rename",
      phase: "request",
    };
  }

  it("Bug 1: a read gated to no request-phase field mappings builds NO backend body (bodyless)", () => {
    // serve-context empties `requestPhaseFieldMappings` for a read (Bug 1), so a bodyless
    // GET never inherits a co-located write's body mappings. At the request-mapping boundary
    // the gate's output (`[]`) then yields NO body — `undefined`, a truly bodyless call.
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetTask,
      parameterMappings: [paramMapping()],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toBeUndefined();
  });

  it("Bug 1: why the gate is needed — a co-located write's body mappings on a bodyless read build {} not undefined", () => {
    // An UNGATED read would inherit the write's request-phase field mappings. Post-Bug-2
    // that no longer 500s (missing-input is tolerated), but it would still produce an EMPTY
    // OBJECT `{}` — not a bodyless call — which is wrong for a GET. This pins exactly why
    // Bug 1 must empty the list at the serve-context seam so the read stays `undefined`.
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetTask,
      parameterMappings: [paramMapping()],
      requestPhaseFieldMappings: [requestBodyRename("fm-write", "todos/title", "tasks/task_title")],
      request: request({ pathParameters: { todoId: "42" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({});
  });

  it("Bug 2: a write omitting an OPTIONAL consumer body field omits that backend field and succeeds", () => {
    // The consumer supplies only `title`; `description` is an OPTIONAL field it omitted
    // (RP-2 already rejected a missing REQUIRED field before this point). The absent source
    // must OMIT its backend field, never fail the whole build.
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerCreate,
      backendOperation: backendCreate,
      parameterMappings: [],
      requestPhaseFieldMappings: [
        requestBodyRename("fm-title", "todos/title", "tasks/task_title"),
        requestBodyRename("fm-desc", "todos/description", "tasks/task_description"),
      ],
      request: request({ body: { title: "Buy milk" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({ task_title: "Buy milk" });
  });

  it("Bug 2 regression: a full-body write still maps EVERY field", () => {
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerCreate,
      backendOperation: backendCreate,
      parameterMappings: [],
      requestPhaseFieldMappings: [
        requestBodyRename("fm-title", "todos/title", "tasks/task_title"),
        requestBodyRename("fm-desc", "todos/description", "tasks/task_description"),
      ],
      request: request({ body: { title: "Buy milk", description: "2 percent" } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({
      task_title: "Buy milk",
      task_description: "2 percent",
    });
  });

  it("Bug 2: a write whose consumer body omits every optional field builds an empty object (still not a 500)", () => {
    // Every mapped source is absent (all optional) — the build succeeds with an empty
    // object body (a real create with no fields), distinct from a bodyless `undefined`.
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerCreate,
      backendOperation: backendCreate,
      parameterMappings: [],
      requestPhaseFieldMappings: [requestBodyRename("fm-title", "todos/title", "tasks/task_title")],
      request: request({ body: {} }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body).toEqual({});
  });

  it("Bug 2 regression: a genuine (non-missing-input) transform error still fails loud as a transform error", () => {
    // The source IS present (not missing-input) but is not coercible to a number →
    // impossible-coercion, which must refuse the whole build, never a partial body.
    const result = mapRequestToBackend({
      mappingId: "mapping-1",
      consumerOperation: consumerCreate,
      backendOperation: backendCreate,
      parameterMappings: [],
      requestPhaseFieldMappings: [
        {
          id: "fm-coerce",
          mappingId: "mapping-1",
          sourcePath: "todos/count",
          targetPath: "tasks/count",
          transform: "coerce",
          transformConfig: { coerce: { to: "number", from: "string" } },
          phase: "request",
        },
      ],
      request: request({ body: { count: "not-a-number" } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("request body transform");
    expect(result.detail).toContain("impossible-coercion");
  });

  it("TE-3: a chained parameter fills a required backend parameter no ParameterMapping covers", () => {
    const backendGetWorkspace: IrOperation = {
      operationId: "getWorkspace",
      method: "get",
      path: "/workspaces/{workspaceId}",
      parameters: [param({ name: "workspaceId", location: "path", required: true })],
    };
    const result = mapRequestToBackend({
      mappingId: "mapping-2",
      consumerOperation: consumerGetTodo,
      backendOperation: backendGetWorkspace,
      parameterMappings: [],
      requestPhaseFieldMappings: [],
      request: request({ pathParameters: { todoId: "42" } }),
      chainedParams: new Map([["workspaceId", "ws-7"]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.pathParams).toEqual({ workspaceId: "ws-7" });
  });
});

describe("resolveChainInputs — TE-3", () => {
  function chainInput(overrides: Partial<ChainInput> = {}): ChainInput {
    return {
      upstreamFieldPath: "todos/id",
      targetParamRef: "workspaces/getWorkspace#workspaceId",
      ...overrides,
    };
  }

  it("TE-3.2/3.3: reads the upstream CONSUMER-shape field and fills the named target param", () => {
    // The upstream is already consumer-shape (`id`), never the backend-native shape (`ws_id`).
    const result = resolveChainInputs("mapping-2", [chainInput()], { id: "ws-7", ws_id: "native" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.params]).toEqual([["workspaceId", "ws-7"]]);
  });

  it("TE-3.4: an ABSENT upstream field refuses the call as a missing chain input, named", () => {
    const result = resolveChainInputs("mapping-2", [chainInput()], { other: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing-chain-input");
    expect(result.detail).toContain("todos/id");
  });

  it("TE-3.4: a NULL upstream field is treated as absent (refused, never a guessed value)", () => {
    const result = resolveChainInputs("mapping-2", [chainInput()], { id: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("missing-chain-input");
  });

  it("TE-3.3: applies the input's optional transform in the sandbox", () => {
    const result = resolveChainInputs(
      "mapping-2",
      [
        chainInput({
          transform: "coerce",
          transformConfig: { coerce: { to: "string", from: "number" } },
        }),
      ],
      { id: 7 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.params]).toEqual([["workspaceId", "7"]]);
  });

  it("a non-scalar chained value is a defect (never a fabricated parameter)", () => {
    const result = resolveChainInputs("mapping-2", [chainInput()], { id: { nested: true } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("defect");
  });
});
