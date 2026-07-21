import { describe, expect, it } from "vitest";

import {
  auditFieldsFor,
  causeTokenOf,
  renderHttpResponse,
  CAUSE_HEADER,
  DEGRADED_HEADER,
  CONTRIBUTING_BACKENDS_HEADER,
  type AdapterResult,
} from "./outcome-http.js";

describe("renderHttpResponse — status + machine-readable cause token (RT-3.5)", () => {
  it("not-yet-mapped → 501 with the cause token in body and header", () => {
    const response = renderHttpResponse({ kind: "not-yet-mapped", endpointId: undefined });
    expect(response.status).toBe(501);
    expect(response.headers[CAUSE_HEADER]).toBe("not-yet-mapped");
    expect(response.body).toMatchObject({ cause: "not-yet-mapped" });
  });

  it("endpoint-disabled → 503 with its cause token", () => {
    const response = renderHttpResponse({ kind: "endpoint-disabled", endpointId: "e1" });
    expect(response.status).toBe(503);
    expect(response.headers[CAUSE_HEADER]).toBe("endpoint-disabled");
  });

  it("serving-not-implemented → distinct cause token (never not-yet-mapped)", () => {
    const response = renderHttpResponse({
      kind: "serving-not-implemented",
      endpointId: "e1",
      bindingId: "b1",
    });
    expect(response.headers[CAUSE_HEADER]).toBe("serving-not-implemented");
    expect(response.body).toMatchObject({ cause: "serving-not-implemented" });
  });

  it("serve-failed maps each cause to its suggested status", () => {
    const cases: Array<[AdapterResult, number]> = [
      [
        { kind: "serve-failed", endpointId: "e", bindingId: undefined, cause: "mapping-stale" },
        503,
      ],
      [
        { kind: "serve-failed", endpointId: "e", bindingId: undefined, cause: "backend-disabled" },
        503,
      ],
      [
        {
          kind: "serve-failed",
          endpointId: "e",
          bindingId: undefined,
          cause: "mediator-transform-error",
        },
        500,
      ],
      [
        { kind: "serve-failed", endpointId: "e", bindingId: undefined, cause: "upstream-error" },
        502,
      ],
    ];
    for (const [result, status] of cases) {
      expect(renderHttpResponse(result).status).toBe(status);
    }
  });

  it("request-rejected → 400 with the RP-2 reason token in header + body (client error, distinct)", () => {
    const response = renderHttpResponse({
      kind: "request-rejected",
      endpointId: "e1",
      reason: "unmapped-consumer-input",
      detail: "consumer parameter 'assignee' has no configured mapping to a backend",
    });
    expect(response.status).toBe(400);
    expect(response.headers[CAUSE_HEADER]).toBe("unmapped-consumer-input");
    expect(response.body).toMatchObject({
      cause: "unmapped-consumer-input",
      message: "consumer parameter 'assignee' has no configured mapping to a backend",
    });
  });

  it("served → 200 with the body and degradation/provenance out-of-band in headers (never the body)", () => {
    const response = renderHttpResponse({
      kind: "served",
      endpointId: "e1",
      bindingId: "b1",
      body: { items: [] },
      degraded: true,
      contributingBackendAppIds: ["backend-a", "backend-b"],
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(response.headers[DEGRADED_HEADER]).toBe("true");
    expect(response.headers[CONTRIBUTING_BACKENDS_HEADER]).toBe("backend-a,backend-b");
    // No cause header on a clean/degraded serve; degradation is out-of-band only.
    expect(response.headers[CAUSE_HEADER]).toBeUndefined();
  });
});

describe("causeTokenOf", () => {
  it("is the taxonomy cause for failures and undefined for a served response", () => {
    expect(causeTokenOf({ kind: "not-yet-mapped", endpointId: undefined })).toBe("not-yet-mapped");
    expect(causeTokenOf({ kind: "endpoint-disabled", endpointId: "e" })).toBe("endpoint-disabled");
    expect(
      causeTokenOf({
        kind: "serve-failed",
        endpointId: "e",
        bindingId: undefined,
        cause: "upstream-error",
      }),
    ).toBe("upstream-error");
    expect(
      causeTokenOf({
        kind: "served",
        endpointId: "e",
        bindingId: "b",
        body: {},
        degraded: false,
        contributingBackendAppIds: [],
      }),
    ).toBeUndefined();
  });
});

describe("auditFieldsFor — metadata only (RT-5)", () => {
  it("not-yet-mapped → failure + cause, endpoint id only when an endpoint exists", () => {
    expect(auditFieldsFor({ kind: "not-yet-mapped", endpointId: undefined })).toEqual({
      status: "failure",
      cause: "not-yet-mapped",
    });
    expect(auditFieldsFor({ kind: "not-yet-mapped", endpointId: "e1" })).toEqual({
      status: "failure",
      cause: "not-yet-mapped",
      endpointId: "e1",
    });
  });

  it("served → success, carrying endpoint + binding + degraded only when degraded", () => {
    expect(
      auditFieldsFor({
        kind: "served",
        endpointId: "e1",
        bindingId: "b1",
        body: {},
        degraded: false,
        contributingBackendAppIds: [],
      }),
    ).toEqual({ status: "success", endpointId: "e1", bindingId: "b1" });

    expect(
      auditFieldsFor({
        kind: "served",
        endpointId: "e1",
        bindingId: "b1",
        body: {},
        degraded: true,
        contributingBackendAppIds: [],
      }),
    ).toEqual({ status: "success", endpointId: "e1", bindingId: "b1", degraded: true });
  });

  it("request-rejected → failure with a details note and NO taxonomy cause (RP-2 client error)", () => {
    const fields = auditFieldsFor({
      kind: "request-rejected",
      endpointId: "e1",
      reason: "invalid-request",
      detail: "missing required path parameter 'todoId'",
    });
    expect(fields.status).toBe("failure");
    expect(fields.cause).toBeUndefined();
    expect(fields.endpointId).toBe("e1");
    expect(fields.details).toContain("invalid-request");
  });

  it("serving-not-implemented → failure with a details note and NO taxonomy cause", () => {
    const fields = auditFieldsFor({
      kind: "serving-not-implemented",
      endpointId: "e1",
      bindingId: "b1",
    });
    expect(fields.status).toBe("failure");
    expect(fields.cause).toBeUndefined();
    expect(fields.details).toContain("serving-not-implemented");
  });
});
