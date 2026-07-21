import type { AdapterRequest } from "@mediator/adapter-engine";
import type { FieldMapping, IrOperation, IrParameter, ParameterMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import {
  buildConsumerParamSource,
  mapRequestToBackend,
  mappedConsumerParamNames,
  paramRefBareName,
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
});
