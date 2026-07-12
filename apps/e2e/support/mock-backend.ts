import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A tiny recording HTTP server standing in for a registered app's real backend.
 * The RU-5 fixture registers both apps with this server's URL as their `baseUrl`,
 * so it is the observable for "nothing executed before approval" (AS-6 crit 4):
 * the mediator makes outbound calls **only** from the Sync/Adapter engines, which
 * do not run in Phase 3, so a correct system contacts this server **zero** times
 * across the whole review→approve journey. Any recorded request is a real bug — an
 * outbound call fired where none should.
 */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
}

export class MockBackend {
  #server: Server | undefined;
  readonly #requests: RecordedRequest[] = [];

  /** Start listening on an ephemeral loopback port; returns nothing (URL via {@link url}). */
  public async start(): Promise<void> {
    this.#server = createServer((request: IncomingMessage, response: ServerResponse) => {
      this.#requests.push({ method: request.method ?? "", url: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, "127.0.0.1", resolve);
    });
  }

  /** The base URL to register apps under, e.g. `http://127.0.0.1:54321`. */
  public url(): string {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("mock backend is not listening on a TCP port");
    }
    return `http://127.0.0.1:${String(address.port)}`;
  }

  /** Every request the server received so far (a snapshot copy). */
  public requests(): readonly RecordedRequest[] {
    return [...this.#requests];
  }

  /** Stop listening. */
  public async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.#server = undefined;
  }
}
