/**
 * Tiny inline OpenAPI documents for the operator-API unit tests — small enough
 * to read, real enough that `@mediator/ir`'s `buildIr` produces a resource group
 * with derivable `ResourceBinding` refs (`nativeIdRef=id`, a collection read,
 * `changeTimestampRef=updated`).
 */

/**
 * A minimal, valid OpenAPI 3.0 provider document with one resource. Its `/issues`
 * collection and `/issues/{id}` item read share the path noun `issues`, so
 * `buildIr` groups them under the `issues` resourceRef (noun grouping, not tags).
 */
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

/**
 * A minimal Gitea-shaped **scoped** provider document: its `issues` resource is
 * reached through `/repos/{owner}/{repo}/issues` (list) and
 * `/repos/{owner}/{repo}/issues/{index}` (by-id read). The two non-record-id path
 * parameters `owner` and `repo` are **scope** parameters (they locate the
 * container), while `{index}` is the record id — so `buildIr`'s SS-2 derivation
 * yields two unconfirmed `constant` scope entries (`owner`, `repo`) and none for
 * `{index}`. Used by the SS-3 supply/confirm route tests.
 */
export function scopedProviderSpecDocument(): Record<string, unknown> {
  const ownerParam = { name: "owner", in: "path", required: true, schema: { type: "string" } };
  const repoParam = { name: "repo", in: "path", required: true, schema: { type: "string" } };
  return {
    openapi: "3.0.0",
    info: { title: "Sample Scoped Provider", version: "1.0.0" },
    paths: {
      "/repos/{owner}/{repo}/issues": {
        get: {
          operationId: "listIssues",
          tags: ["issue"],
          parameters: [ownerParam, repoParam],
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
      "/repos/{owner}/{repo}/issues/{index}": {
        get: {
          operationId: "getIssue",
          tags: ["issue"],
          parameters: [
            ownerParam,
            repoParam,
            { name: "index", in: "path", required: true, schema: { type: "integer" } },
          ],
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
