import type { FastifyRequest } from "fastify";

/**
 * **The `consumerAppId` seam the Auth Gateway (AT) fills** (RT-2.3, README open
 * question 1 — token-derived routing). Every adapter request is resolved *within*
 * the consumer app the caller is identified as, so identical paths in two consumer
 * specs can never be confused. Producing that identity from the caller's
 * mediator-issued adapter token is AT's job (the next slice); this RT slice threads
 * the seam so routing/resolution can be built and tested behind it.
 *
 * A resolver returns the `consumerAppId`, or `undefined` when it cannot attribute
 * the request (which this slice answers `401`, without an audit row — an
 * unattributable request never became an adapter request).
 */
export type ConsumerAppResolver = (request: FastifyRequest) => string | undefined;

/** The header the {@link headerConsumerAppResolver} reads the consumer app id from. */
export const CONSUMER_APP_HEADER = "x-mediator-consumer-app-id";

/**
 * The default RT-slice resolver: read the consumer app id from a request header.
 * This is a deliberate **stand-in** for AT's token validation — it performs no
 * authentication and trusts the header — so it is only ever appropriate behind AT
 * (or in tests that inject the header directly). AT replaces it with a resolver
 * that validates the adapter token and derives the app id from it, and nothing else
 * in the runtime changes.
 */
export const headerConsumerAppResolver: ConsumerAppResolver = (request) => {
  const header = request.headers[CONSUMER_APP_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && value.length > 0 ? value : undefined;
};
