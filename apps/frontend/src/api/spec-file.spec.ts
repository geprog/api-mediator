import { describe, expect, it } from "vitest";

import { readOpenApiDocument } from "./spec-file";

function jsonFile(content: string): File {
  return new File([content], "spec.json", { type: "application/json" });
}

describe("readOpenApiDocument", () => {
  it("parses a JSON object document", async () => {
    const document = await readOpenApiDocument(jsonFile('{"openapi":"3.0.0","paths":{}}'));
    expect(document).toEqual({ openapi: "3.0.0", paths: {} });
  });

  it("rejects a non-object JSON top level", async () => {
    await expect(readOpenApiDocument(jsonFile("[1,2,3]"))).rejects.toThrow(/JSON object/);
  });

  it("rejects invalid JSON", async () => {
    await expect(readOpenApiDocument(jsonFile("not json"))).rejects.toThrow(/valid JSON/);
  });
});
