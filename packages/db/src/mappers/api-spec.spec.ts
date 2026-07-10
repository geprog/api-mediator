import type { ApiSpec, Ir } from "@mediator/domain";
import { describe, expect, it } from "vitest";

import { mapApiSpecRow, toApiSpecInsert, type ApiSpecRow } from "./api-spec.js";

const ir: Ir = [
  {
    resourceRef: "issues",
    name: "Issues",
    operations: [
      {
        operationId: "listIssues",
        method: "get",
        path: "/issues",
        parameters: [],
      },
    ],
    schemas: [{ name: "Issue", fields: [{ name: "id", type: "integer", required: true }] }],
    crossResourceRefs: [],
  },
];
const createdAt = new Date("2026-07-10T00:00:00.000Z");

function baseRow(): ApiSpecRow {
  return {
    id: "spec-1",
    appId: "app-1",
    role: "PROVIDER",
    rawDocument: { openapi: "3.1.0" },
    parsedIr: ir,
    analysisExclusions: ["webhooks"],
    version: 1,
    contentHash: "sha256:abc",
    status: "active",
    createdAt,
  };
}

describe("mapApiSpecRow / toApiSpecInsert", () => {
  it("maps a row to a domain ApiSpec, bridging parsed_ir → parsedIR", () => {
    const spec = mapApiSpecRow(baseRow());

    expect(spec).toStrictEqual({
      id: "spec-1",
      appId: "app-1",
      role: "PROVIDER",
      rawDocument: { openapi: "3.1.0" },
      parsedIR: ir,
      analysisExclusions: ["webhooks"],
      version: 1,
      contentHash: "sha256:abc",
      status: "active",
      createdAt,
    });
  });

  it("round-trips row → domain → insert without losing the IR or exclusions", () => {
    const spec: ApiSpec = mapApiSpecRow(baseRow());
    const insert = toApiSpecInsert(spec);

    expect(insert.parsedIr).toStrictEqual(ir);
    expect(insert.analysisExclusions).toStrictEqual(["webhooks"]);
    expect(insert.rawDocument).toStrictEqual({ openapi: "3.1.0" });
  });
});
