import type { Locator, Page } from "@playwright/test";

import type { TestAccount } from "../env.js";

/**
 * Page object for the operator login screen (OA-1 / LoginView). Since Phase-3 auth,
 * every operator-API route requires an authenticated identity and the router guard
 * sends an anonymous visitor to `/login`, so a journey signs in here before it can
 * read or mutate anything.
 *
 * The SPA holds the Basic credential **in memory only** — it is deliberately not
 * persisted (a dev-SPA session, see `api/auth-header.ts`), so a full page reload
 * signs the operator out and the guard redirects back to `/login`. A journey that
 * reloads to prove server-side persistence must therefore re-authenticate; that is
 * what {@link reloadAndReauth} is for. All navigation/actions live here; assertions
 * stay in the spec.
 */
export class LoginPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  public get form(): Locator {
    return this.#page.getByTestId("login-form");
  }

  public get error(): Locator {
    return this.#page.getByTestId("login-error");
  }

  /** Navigate straight to the login screen. */
  public async open(): Promise<void> {
    await this.#page.goto("/login");
  }

  /**
   * Fill and submit the login form for `account`, then wait until the app has
   * navigated away from `/login` (the guard/redirect resolved). Assumes the login
   * screen is already showing (either via {@link open} or a guard redirect).
   */
  public async loginAs(account: TestAccount): Promise<void> {
    await this.#page.getByTestId("login-username").fill(account.username);
    await this.#page.getByTestId("login-password").fill(account.password);
    await this.#page.getByTestId("login-submit").click();
    await this.#page.waitForURL((url) => !url.pathname.startsWith("/login"));
  }

  /** Open the login screen and sign in as `account`, landing on `/proposals`. */
  public async openAndLogin(account: TestAccount): Promise<void> {
    await this.open();
    await this.loginAs(account);
  }

  /**
   * Reload the current page and re-authenticate. The reload clears the in-memory
   * session, so the guard redirects to `/login?redirect=<path>`; signing back in
   * returns to the pre-reload path. Use this in place of `page.reload()` in an
   * authenticated journey.
   */
  public async reloadAndReauth(account: TestAccount): Promise<void> {
    await this.#page.reload();
    await this.#page.waitForURL((url) => url.pathname.startsWith("/login"));
    await this.loginAs(account);
  }
}
