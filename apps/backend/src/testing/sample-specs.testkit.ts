/**
 * Tiny inline OpenAPI documents for the operator-API unit tests — small enough
 * to read, real enough that `@mediator/ir`'s `buildIr` produces a resource group
 * with derivable `ResourceBinding` refs (`nativeIdRef=id`, a collection read,
 * `changeTimestampRef=updated`).
 */

/** A minimal, valid OpenAPI 3.0 provider document with one `issue` resource. */
export function providerSpecDocument(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Sample Provider", version: "1.0.0" },
    paths: {
      "/issues": {
        get: {
          operationId: "listIssues",
          tags: ["issue"],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Issue" } },
                },
              },
            },
          },
        },
      },
      "/issues/{id}": {
        get: {
          operationId: "getIssue",
          tags: ["issue"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Issue" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Issue: {
          type: "object",
          properties: {
            id: { type: "integer" },
            title: { type: "string" },
            updated: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
  };
}

/** A document that is not a recognizable OpenAPI spec — `buildIr` rejects it. */
export function malformedDocument(): Record<string, unknown> {
  return { not: "an-openapi-document" };
}
