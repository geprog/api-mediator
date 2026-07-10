import type { Locator, Page } from "@playwright/test";

/** The two spec roles the registration form offers (AR-1/AR-3). */
export type SpecRole = "PROVIDER" | "CONSUMER";

/** App-detail URL shape the form navigates to on a successful registration. */
const APP_DETAIL_URL = /\/apps\/[0-9a-fA-F-]{36}$/;

/**
 * Page object for the registration form (AR-3): all navigation/actions, no
 * assertions (those stay in the spec). Exposes the locators a test asserts on
 * (`form`, `issues`, the resource-group toggles) so the spec never reaches for a
 * CSS selector.
 */
export class RegisterAppPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Open the app, then navigate to the registration form via the nav link. */
  public async open(): Promise<void> {
    await this.#page.goto("/");
    await this.#page.getByTestId("nav-register").click();
  }

  public get form(): Locator {
    return this.#page.getByTestId("registration-form");
  }

  /** The inline field-level validation summary (only present when submit fails). */
  public get issues(): Locator {
    return this.#page.getByTestId("reg-issues");
  }

  public async fillName(name: string): Promise<void> {
    await this.#page.getByTestId("reg-name").fill(name);
  }

  public async fillBaseUrl(baseUrl: string): Promise<void> {
    await this.#page.getByTestId("reg-base-url").fill(baseUrl);
  }

  public async selectRole(specIndex: number, role: SpecRole): Promise<void> {
    await this.#page.getByTestId(`spec-role-${String(specIndex)}`).selectOption(role);
  }

  /** Upload an OpenAPI document into the given spec slot (triggers preview-parse). */
  public async uploadSpec(specIndex: number, absoluteFilePath: string): Promise<void> {
    await this.#page.getByTestId(`spec-file-${String(specIndex)}`).setInputFiles(absoluteFilePath);
  }

  /** The exclusion toggle label for a previewed resource group. */
  public groupToggle(specIndex: number, resourceRef: string): Locator {
    return this.#page.getByTestId(`spec-group-${String(specIndex)}-${resourceRef}`);
  }

  /** Check a resource group's exclusion box (adds it to `analysisExclusions`). */
  public async excludeGroup(specIndex: number, resourceRef: string): Promise<void> {
    await this.#page.getByTestId(`spec-exclude-${String(specIndex)}-${resourceRef}`).check();
  }

  /**
   * Submit the form and wait for the success navigation to the created app,
   * returning its `id` parsed from the URL.
   */
  public async submitAndOpenApp(): Promise<string> {
    await this.#page.getByTestId("reg-submit").click();
    await this.#page.waitForURL(APP_DETAIL_URL);
    const appId = this.#page.url().split("/").pop();
    if (appId === undefined || appId === "") {
      throw new Error("registration did not navigate to an app-detail URL");
    }
    return appId;
  }
}
