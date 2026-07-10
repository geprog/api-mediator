import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the app list (AR-2). Rows link to app detail; the list is
 * unpaginated at Phase-1 scale, so a test scopes to its own app by id rather than
 * asserting on the whole table.
 */
export class AppListPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Navigate to the app list via the primary nav. */
  public async open(): Promise<void> {
    await this.#page.getByTestId("nav-apps").click();
  }

  public get table(): Locator {
    return this.#page.getByTestId("app-list-table");
  }

  public appLink(appId: string): Locator {
    return this.#page.getByTestId(`app-link-${appId}`);
  }

  public async openApp(appId: string): Promise<void> {
    await this.appLink(appId).click();
  }
}
