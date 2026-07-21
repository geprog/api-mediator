import type { ValidateTokenResult } from "@mediator/credentials";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedConsumerApp } from "./consumer-app-resolver.js";
import {
  createTokenConsumerAppResolver,
  type AdapterTokenValidator,
} from "./token-consumer-app-resolver.js";

/**
 * Unit coverage for the Auth Gateway resolver: it extracts the `Authorization:
 * Bearer` token, delegates validation to the injected validator, and maps the
 * result to a resolved consumer app (+ credential id) or `undefined`. Driven
 * through a real Fastify request so header handling is the real thing, with a fake
 * validator standing in for the token store.
 */

/** A validator returning a scripted result, capturing the raw token it was handed. */
class FakeValidator implements AdapterTokenValidator {
  public lastToken: string | undefined;
  public constructor(private readonly result: ValidateTokenResult) {}
  public validate(rawToken: string): Promise<ValidateTokenResult> {
    this.lastToken = rawToken;
    return Promise.resolve(this.result);
  }
}

/** Build a probe app that runs the resolver and echoes its outcome. */
function buildProbe(validator: AdapterTokenValidator): FastifyInstance {
  const resolver = createTokenConsumerAppResolver(validator);
  const app = Fastify();
  app.get("/probe", async (request): Promise<{ resolved: ResolvedConsumerApp | null }> => {
    const resolution = await resolver(request);
    return { resolved: resolution ?? null };
  });
  return app;
}

describe("createTokenConsumerAppResolver", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("resolves a valid Bearer token to its consumer app + credential id", async () => {
    const validator = new FakeValidator({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: "cred-1",
    });
    app = buildProbe(validator);

    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: "Bearer amt.00000000-0000-4000-8000-000000000001.deadbeef" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ resolved: ResolvedConsumerApp | null }>().resolved).toStrictEqual({
      consumerAppId: "app-1",
      credentialId: "cred-1",
    });
    expect(validator.lastToken).toBe("amt.00000000-0000-4000-8000-000000000001.deadbeef");
  });

  it("returns undefined for a rejected token (a clean 401 upstream, never a serve)", async () => {
    const validator = new FakeValidator({ outcome: "rejected", reason: "secret-mismatch" });
    app = buildProbe(validator);

    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: "Bearer amt.00000000-0000-4000-8000-000000000001.deadbeef" },
    });

    expect(response.json<{ resolved: ResolvedConsumerApp | null }>().resolved).toBeNull();
  });

  it("returns undefined without calling the validator when no Bearer header is present", async () => {
    const validator = new FakeValidator({
      outcome: "resolved",
      consumerAppId: "app-1",
      credentialId: "cred-1",
    });
    app = buildProbe(validator);

    const missing = await app.inject({ method: "GET", url: "/probe" });
    expect(missing.json<{ resolved: ResolvedConsumerApp | null }>().resolved).toBeNull();

    // A non-Bearer scheme (e.g. Basic, the operator surface's scheme) is ignored.
    const basic = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(basic.json<{ resolved: ResolvedConsumerApp | null }>().resolved).toBeNull();
    expect(validator.lastToken).toBeUndefined();
  });
});
