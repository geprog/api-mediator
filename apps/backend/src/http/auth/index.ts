/**
 * Operator-API authentication & authorization (Phase 3, OA-1..OA-3).
 *
 * The public surface the composition root wires and the Phase-3 approval routes
 * (RA-1..RA-5) will consume unchanged:
 * - {@link Principal} / {@link getPrincipal} — the resolved identity + role, and
 *   the single accessor handlers use for gating and attribution.
 * - {@link AuthProvider} — the pluggable authentication seam;
 *   {@link LocalAccountsAuthProvider} is the Phase-3 implementation.
 * - {@link installAuthentication} — the OA-1 authentication hook installer.
 * - {@link requireOperator} / {@link requireViewer} / {@link requireRole} — the
 *   OA-2 role guards attached per route.
 */
export { installAuthentication } from "./authenticate.js";
export { requireOperator, requireRole, requireViewer } from "./guards.js";
export { LocalAccountsAuthProvider } from "./local-accounts.js";
export { getPrincipal, type Principal } from "./principal.js";
export type { AuthProvider } from "./provider.js";
