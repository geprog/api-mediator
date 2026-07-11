import type { OperatorAccount, OperatorRole } from "@mediator/config";
import { hashSecret } from "@mediator/credentials";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";

/**
 * Shared operator-auth fixtures for the backend tests (Phase-3 OA-1..OA-3).
 *
 * Retrofitting authentication onto the existing routes means every functional
 * test must present an identity. These helpers provide the two roles as Basic
 * `Authorization` headers, plus the seeded {@link OperatorAccount}s (with real
 * salted scrypt hashes, computed once) that {@link buildTestServer}'s provider
 * verifies against — so the tests exercise the *real* auth path, not a bypass.
 *
 * A `*.testkit.ts` file: type-checked, excluded from `dist`, never collected as
 * a Vitest suite.
 */

/** A test account: the plaintext password lives only here, in test code. */
export interface TestAccount {
  readonly username: string;
  readonly password: string;
  readonly role: OperatorRole;
}

/** Default operator identity used by the existing functional tests. */
export const TEST_OPERATOR: TestAccount = {
  username: "operator",
  password: "operator-test-password",
  role: "operator",
};

/** A second operator, to prove attribution follows the authenticated identity. */
export const TEST_OPERATOR_ALICE: TestAccount = {
  username: "alice",
  password: "alice-test-password",
  role: "operator",
};

/** A viewer, for the read-allowed / mutation-forbidden gating tests. */
export const TEST_VIEWER: TestAccount = {
  username: "viewer",
  password: "viewer-test-password",
  role: "viewer",
};

const TEST_ACCOUNTS: readonly TestAccount[] = [TEST_OPERATOR, TEST_OPERATOR_ALICE, TEST_VIEWER];

/**
 * The seeded accounts the test provider authenticates against — real salted
 * scrypt hashes computed once at module load (top-level await), never plaintext.
 */
export const TEST_OPERATOR_ACCOUNTS: readonly OperatorAccount[] = await Promise.all(
  TEST_ACCOUNTS.map(async (account): Promise<OperatorAccount> => ({
    username: account.username,
    role: account.role,
    passwordHash: await hashSecret(account.password),
  })),
);

/** The Basic `Authorization` header value for `account`. */
export function basicAuthValue(account: TestAccount): string {
  const encoded = Buffer.from(`${account.username}:${account.password}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/** Inject headers authenticating as `account`. */
export function authHeaders(account: TestAccount): { authorization: string } {
  return { authorization: basicAuthValue(account) };
}

/** Inject headers authenticating as the default operator. */
export function operatorHeaders(): { authorization: string } {
  return authHeaders(TEST_OPERATOR);
}

/** Inject headers authenticating as the viewer. */
export function viewerHeaders(): { authorization: string } {
  return authHeaders(TEST_VIEWER);
}

/**
 * `app.inject(...)` authenticated as `account`: merges the Basic header in,
 * letting an explicit `options.headers` still override. The convenience the
 * existing route tests use so each call presents an identity through the real
 * auth path.
 */
export function injectAs(
  app: FastifyInstance,
  account: TestAccount,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  return app.inject({ ...options, headers: { ...authHeaders(account), ...options.headers } });
}

/**
 * The `OPERATOR_ACCOUNTS` env string seeding the same accounts, for integration
 * tests that build config through `loadConfig`.
 */
export function operatorAccountsEnv(): string {
  return TEST_OPERATOR_ACCOUNTS.map(
    (account) => `${account.username}:${account.role}:${account.passwordHash}`,
  ).join(",");
}
