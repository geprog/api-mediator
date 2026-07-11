// Generate a salted scrypt hash for an OPERATOR_ACCOUNTS entry, so an operator
// password is never stored (or typed into `.env`) in plaintext. Uses the same
// `@mediator/credentials` primitive the auth provider verifies against.
//
//   pnpm hash:operator-password '<password>'
//
// then put `username:role:<printed hash>` into OPERATOR_ACCOUNTS (see
// .env.example). Requires the workspace to be built (`pnpm build`).
import { hashSecret } from "@mediator/credentials";

const password = process.argv[2];
if (password === undefined || password.length === 0) {
  console.error("Usage: pnpm hash:operator-password '<password>'");
  process.exit(1);
}

const hash = await hashSecret(password);
console.log(hash);
