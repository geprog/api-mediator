import type { FastifyRequest } from "fastify";

/**
 * The identity a resolved adapter request binds to: the consumer `RegisteredApp`
 * the caller was authenticated as, plus the `Credential` id that authenticated it.
 *
 * The `credentialId` is threaded so the one `adapter-request` audit row can record
 * **which** adapter token served the request — during a rotation overlap two tokens
 * for the same app are simultaneously valid, and AT-4.3 requires the audit to
 * distinguish which one was used (by id, never by value). The header stand-in below
 * performs no authentication, so it supplies none.
 */
export interface ResolvedConsumerApp {
  readonly consumerAppId: string;
  readonly credentialId?: string;
}

/**
 * **The identity seam the Auth Gateway (AT) fills** (RT-2.3). Every adapter request
 * is resolved *within* the consumer app the caller is identified as, so identical
 * paths in two consumer specs can never be confused. Producing that identity from
 * the caller's mediator-issued adapter token is AT's job — validating the token is
 * async (a constant-time salted-hash comparison), so the resolver is async.
 *
 * A resolver returns the {@link ResolvedConsumerApp}, or `undefined` when it cannot
 * attribute the request — which the runtime answers `401`, **without** an audit row
 * (an unauthenticated / unrecognized / expired / foreign-token request never became
 * an adapter request). AT keeps exactly that behaviour: a recognized-but-invalid
 * token is a clean `401`, never a serve.
 */
export type ConsumerAppResolver = (
  request: FastifyRequest,
) => Promise<ResolvedConsumerApp | undefined>;

/** The header the {@link headerConsumerAppResolver} reads the consumer app id from. */
export const CONSUMER_APP_HEADER = "x-mediator-consumer-app-id";

/**
 * The default RT-slice resolver: read the consumer app id from a request header.
 * This is a deliberate **stand-in** for AT's token validation — it performs no
 * authentication and trusts the header — so it is only ever appropriate behind AT
 * (or in tests that inject the header directly). AT replaces it in the composition
 * root with a resolver that validates the adapter token and derives the app id (and
 * the credential id) from it; nothing else in the runtime changes.
 */
export const headerConsumerAppResolver: ConsumerAppResolver = (request) => {
  const header = request.headers[CONSUMER_APP_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return Promise.resolve(
    value !== undefined && value.length > 0 ? { consumerAppId: value } : undefined,
  );
};
