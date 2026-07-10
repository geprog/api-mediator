import { appListResponseSchema } from "@mediator/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "./client";
import { ApiError } from "./errors";

interface FetchStub {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

function stubFetch(result: FetchStub | Error): void {
  vi.stubGlobal(
    "fetch",
    result instanceof Error
      ? vi.fn(() => Promise.reject(result))
      : vi.fn(() => Promise.resolve(result)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiRequest", () => {
  it("validates and returns a well-formed response", async () => {
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ apps: [] }) });
    const result = await apiRequest("/api/apps", { method: "GET" }, appListResponseSchema);
    expect(result).toEqual({ apps: [] });
  });

  it("throws a typed ApiError carrying the server's ErrorResponse issues", async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          statusCode: 400,
          error: "Bad Request",
          message: "Validation failed",
          issues: [{ path: "name", message: "required" }],
        }),
    });

    await expect(
      apiRequest("/api/apps", { method: "GET" }, appListResponseSchema),
    ).rejects.toMatchObject({
      statusCode: 400,
      issues: [{ path: "name", message: "required" }],
    });
  });

  it("throws a Malformed Response error when the body does not match the schema", async () => {
    stubFetch({ ok: true, status: 200, json: () => Promise.resolve({ wrong: true }) });
    await expect(
      apiRequest("/api/apps", { method: "GET" }, appListResponseSchema),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("folds a transport failure into an ApiError", async () => {
    stubFetch(new Error("connection refused"));
    await expect(
      apiRequest("/api/apps", { method: "GET" }, appListResponseSchema),
    ).rejects.toMatchObject({ reason: "Network Error" });
  });
});
