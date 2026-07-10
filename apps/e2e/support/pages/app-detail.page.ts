import type { Locator, Page } from "@playwright/test";

/**
 * Page object for app detail (AR-2): the app metadata card plus the specs table,
 * each spec linking to its IR + `ResourceBinding` view.
 */
export class AppDetailPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  public get card(): Locator {
    return this.#page.getByTestId("app-detail-card");
  }

  public get specsTable(): Locator {
    return this.#page.getByTestId("app-specs-table");
  }

  /** Open the spec's IR + bindings view via its "View" link (single-spec app). */
  public async openOnlySpec(): Promise<void> {
    await this.#page.getByRole("link", { name: "View" }).click();
  }
}
