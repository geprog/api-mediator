import { describe, expect, it } from "vitest";

import {
  FetchRestProtocolClient,
  OutboundTransportError,
  type HttpFetch,
  type HttpFetchInit,
  type HttpFetchResponse,
} from "./rest-protocol-client.js";

/** A fake `HttpFetchResponse` over a plain header record + text body. */
function fakeResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
): HttpFetchResponse {
  return {
    status,
    headers: {
      get: (name): string | null => headers[name.toLowerCase()] ?? null,
      forEach: (cb): void => {
        for (const [key, value] of Object.entries(headers)) {
          cb(value, key);
        }
      },
    },
    text: (): Promise<string> => Promise.resolve(body),
  };
}

describe("FetchRestProtocolClient", () => {
  it("serializes a JSON body with content-type and passes method + headers through", async () => {
    const seen: { url: string; init: HttpFetchInit }[] = [];
    const fetchFn: HttpFetch = (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(fakeResponse(201, { "x-y": "z" }, JSON.stringify({ id: "new-1" })));
    };
    const client = new FetchRestProtocolClient({ fetch: fetchFn });

    const response = await client.send({
      method: "POST",
      url: "https://api.test/customers",
      headers: { authorization: "Bearer secret-token", "idempotency-key": "K" },
      body: { name: "Ada" },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.test/customers");
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.init.headers["idempotency-key"]).toBe("K");
    expect(seen[0]?.init.body).toBe(JSON.stringify({ name: "Ada" }));

    expect(response.status).toBe(201);
    expect(response.headers["x-y"]).toBe("z");
    expect(response.body).toStrictEqual({ id: "new-1" });
  });

  it("sends no body for a bodyless call and tolerates an empty response", async () => {
    let sentInit: HttpFetchInit | undefined;
    const fetchFn: HttpFetch = (_url, init) => {
      sentInit = init;
      return Promise.resolve(fakeResponse(204, {}, ""));
    };
    const client = new FetchRestProtocolClient({ fetch: fetchFn });

    const response = await client.send({
      method: "DELETE",
      url: "https://api.test/customers/7",
      headers: {},
      body: undefined,
    });

    expect(sentInit?.body).toBeUndefined();
    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
  });

  it("throws an OutboundTransportError (never a secret) when the transport rejects", async () => {
    const fetchFn: HttpFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const client = new FetchRestProtocolClient({ fetch: fetchFn });

    await expect(
      client.send({
        method: "PUT",
        url: "https://api.test/customers/7",
        headers: { authorization: "Bearer secret-token" },
        body: { name: "Ada" },
      }),
    ).rejects.toBeInstanceOf(OutboundTransportError);
  });
});
