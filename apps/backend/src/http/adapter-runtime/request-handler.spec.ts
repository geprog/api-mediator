import type { AdapterStore, EndpointState, MountedConsumerApp } from "@mediator/adapter-engine";
import type { AuditLogEntry, Ir } from "@mediator/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { AdapterTelemetry } from "./adapter-telemetry.js";
import type { AdapterAuditWriter } from "./adapter-audit.js";
import { CAUSE_HEADER } from "./outcome-http.js";
import { AdapterRequestHandler } from "./request-handler.js";
import { RestProtocolServer } from "./rest-protocol-server.js";

/**
 * Unit coverage for the {@link AdapterRequestHandler} error-handling paths, which
 * the integration suite (happy paths over a real DB) does not exercise. The real
 * handler is wired to a minimal Fastify app with **fakes** and driven via `inject`,
 * so the request/reply are real Fastify objects but no database is involved.
 */

const CONSUMER = "consumer-1";

const ir: Ir = [
  {
    resourceRef: "todos",
    name: "Todos",
    operations: [{ operationId: "listTodos", method: "get", path: "/todos", parameters: [] }],
    schemas: [],
    crossResourceRefs: [],
  },
];

/** A recording audit writer that captures every entry it is asked to persist. */
class RecordingAuditWriter implements AdapterAuditWriter {
  public readonly recorded: AuditLogEntry[] = [];
  public record(entry: AuditLogEntry): Promise<void> {
    this.recorded.push(entry);
    return Promise.resolve();
  }
}

/** An audit writer that always fails — to prove the best-effort swallow. */
class FailingAuditWriter implements AdapterAuditWriter {
  public record(): Promise<void> {
    return Promise.reject(new Error("audit store unavailable"));
  }
}

function buildApp(store: AdapterStore, auditWriter: AdapterAuditWriter): FastifyInstance {
  const protocolServer = new RestProtocolServer();
  protocolServer.setMountedSurface([{ consumerAppId: CONSUMER, ir } satisfies MountedConsumerApp]);
  const handler = new AdapterRequestHandler({
    protocolServer,
    store,
    resolveConsumerApp: () => CONSUMER,
    auditWriter,
    telemetry: new AdapterTelemetry(),
    newId: () => "audit-id",
  });
  const app = Fastify();
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });
  const bound = handler.handle.bind(handler);
  app.route({ method: ["GET", "POST"], url: "/", handler: bound });
  app.route({ method: ["GET", "POST"], url: "/*", handler: bound });
  return app;
}

describe("AdapterRequestHandler error handling", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("a throwing store yields exactly one internal-error audit row + a generic 500 (no payload/token)", async () => {
    const token = "super-secret-token";
    const audit = new RecordingAuditWriter();
    const throwingStore: AdapterStore = {
      listMountableConsumerApps: () => Promise.resolve([]),
      loadEndpointState: () => Promise.reject(new Error("db is down")),
    };
    app = buildApp(throwingStore, audit);

    const response = await app.inject({
      method: "GET",
      url: "/todos",
      headers: { "x-mediator-consumer-app-id": CONSUMER, authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(500);
    // Generic body — no token, no upstream detail leaked.
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain("db is down");

    // Exactly one audit row, marked internal-error, carrying no cause/endpoint/token.
    expect(audit.recorded).toHaveLength(1);
    const entry = audit.recorded[0];
    expect(entry?.type).toBe("adapter-request");
    expect(entry?.status).toBe("failure");
    expect(entry?.details).toContain("internal-error");
    expect(entry?.cause).toBeUndefined();
    expect(entry?.relatedEndpointId).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it("a failing audit writer is swallowed — the request still gets its correct answer, not a 500", async () => {
    const resolvableStore: AdapterStore = {
      listMountableConsumerApps: () => Promise.resolve([]),
      // An existing operation with no endpoint → not-yet-mapped.
      loadEndpointState: (): Promise<EndpointState> =>
        Promise.resolve({ endpoint: undefined, bindings: [] }),
    };
    app = buildApp(resolvableStore, new FailingAuditWriter());

    const response = await app.inject({
      method: "GET",
      url: "/todos",
      headers: { "x-mediator-consumer-app-id": CONSUMER },
    });

    // The audit write threw, but the caller still gets the correct not-yet-mapped
    // answer — a failed audit never degrades a live response into a 500.
    expect(response.statusCode).toBe(501);
    expect(response.headers[CAUSE_HEADER]).toBe("not-yet-mapped");
  });
});
