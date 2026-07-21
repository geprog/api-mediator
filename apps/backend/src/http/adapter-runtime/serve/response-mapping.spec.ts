import type { FieldMapping } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { mapBackendResponseToConsumer } from "./response-mapping.js";

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

const todoFromTask: readonly FieldMapping[] = [
  rename("fm-id", "tasks/task_id", "todos/id"),
  rename("fm-title", "tasks/task_title", "todos/title"),
  rename("fm-done", "tasks/completed", "todos/done"),
];

describe("mapBackendResponseToConsumer — TE-4", () => {
  it("maps a single backend object into the consumer shape", () => {
    const result = mapBackendResponseToConsumer(todoFromTask, {
      task_id: "7",
      task_title: "Ship it",
      completed: true,
    });
    expect(result).toEqual({ ok: true, payload: { id: "7", title: "Ship it", done: true } });
  });

  it("maps a collection response per row", () => {
    const result = mapBackendResponseToConsumer(todoFromTask, [
      { task_id: "1", task_title: "a", completed: false },
      { task_id: "2", task_title: "b", completed: true },
    ]);
    expect(result).toEqual({
      ok: true,
      payload: [
        { id: "1", title: "a", done: false },
        { id: "2", title: "b", done: true },
      ],
    });
  });

  it("passes the backend body through when no response-phase mappings are composed", () => {
    expect(mapBackendResponseToConsumer([], { raw: 1 })).toEqual({ ok: true, payload: { raw: 1 } });
  });

  it("reports a transform failure as a mediator-side defect (never a partial payload)", () => {
    const result = mapBackendResponseToConsumer(todoFromTask, { task_id: "7" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("response transform");
  });
});
