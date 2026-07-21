/**
 * `apps/backend/src/modules/adapter-token` — the Auth Gateway & adapter-token slice
 * (Phase-5 AT-1..AT-4): the operator-facing issue/rotate/cutover service (with
 * operator-attributed audit rows), the per-request token validator the gateway
 * resolver uses, and the consumer-app eligibility reader both share.
 */

export {
  AdapterTokenService,
  buildAdapterTokenValidator,
  type AdapterTokenIssuer,
  type AdapterTokenServiceDeps,
} from "./adapter-token-service.js";
export { DbConsumerAppEligibilityReader } from "./consumer-app-eligibility.js";
