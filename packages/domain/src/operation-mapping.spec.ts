import { describe, expect, it } from "vitest";

import {
  type OperationMapping,
  operationMappingSchema,
  type ParameterMapping,
  parameterMappingSchema,
} from "./index.js";

function updateOperation(): OperationMapping {
  return {
    id: "op-1",
    mappingId: "am-1",
    sourceOperationRef: "issues/updateIssue",
    targetOperationRef: "tasks/updateTask",
    action: "update",
  };
}

describe("OperationMapping schema", () => {
  it("accepts an update operation carrying a targetIdParamRef", () => {
    const result = operationMappingSchema.safeParse({
      ...updateOperation(),
      targetIdParamRef: "tasks/updateTask#taskId",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a delete operation carrying a targetIdParamRef", () => {
    const result = operationMappingSchema.safeParse({
      ...updateOperation(),
      action: "delete",
      targetIdParamRef: "tasks/deleteTask#taskId",
    });
    expect(result.success).toBe(true);
  });

  it("accepts create/read operations with no targetIdParamRef", () => {
    expect(
      operationMappingSchema.safeParse({ ...updateOperation(), action: "create" }).success,
    ).toBe(true);
    expect(operationMappingSchema.safeParse({ ...updateOperation(), action: "read" }).success).toBe(
      true,
    );
  });

  it("rejects a targetIdParamRef on an action = create operation", () => {
    const result = operationMappingSchema.safeParse({
      ...updateOperation(),
      action: "create",
      targetIdParamRef: "tasks/createTask#id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a targetIdParamRef on an action = read operation", () => {
    const result = operationMappingSchema.safeParse({
      ...updateOperation(),
      action: "read",
      targetIdParamRef: "tasks/getTask#id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid action", () => {
    const result = operationMappingSchema.safeParse({ ...updateOperation(), action: "list" });
    expect(result.success).toBe(false);
  });
});

function parameterMapping(): ParameterMapping {
  return {
    id: "pm-1",
    operationMappingId: "op-1",
    sourceParamRef: "search/searchIssues#owner",
    targetParamRef: "list/listTasks#project",
  };
}

describe("ParameterMapping schema (consumer-provider only)", () => {
  it("accepts a pass-through parameter with no transform", () => {
    expect(parameterMappingSchema.safeParse(parameterMapping()).success).toBe(true);
  });

  it("accepts a parameter with an optional transform + transformConfig", () => {
    const result = parameterMappingSchema.safeParse({
      ...parameterMapping(),
      transform: "coerce",
      transformConfig: { additionalInputPaths: [] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown transform", () => {
    const result = parameterMappingSchema.safeParse({
      ...parameterMapping(),
      transform: "concat",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing targetParamRef", () => {
    const withoutTarget: Record<string, unknown> = { ...parameterMapping() };
    delete withoutTarget["targetParamRef"];
    expect(parameterMappingSchema.safeParse(withoutTarget).success).toBe(false);
  });
});
