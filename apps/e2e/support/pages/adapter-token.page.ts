import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the adapter-token panel (CU-3 / `AdapterTokenPanel.vue`), reached at
 * `/adapter/apps/:appId/token`. It drives the once-only token lifecycle the CU-5.1
 * capstone proves: an operator issues a token, the raw value is revealed **exactly
 * once**, and a reload/reopen never shows it again. A viewer sees no controls and no
 * value (CU-5.9 / OA-2). Navigation + actions live here; assertions stay in the spec.
 */
export class AdapterTokenPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Navigate to a consumer app's token panel. */
  public async open(consumerAppId: string): Promise<void> {
    await this.#page.goto(`/adapter/apps/${consumerAppId}/token`);
  }

  public get panel(): Locator {
    return this.#page.getByTestId("token-panel");
  }

  /** The once-only reveal block (present only immediately after an issue/rotate). */
  public get reveal(): Locator {
    return this.#page.getByTestId("token-reveal");
  }

  /** The raw token value, shown exactly once. */
  public get value(): Locator {
    return this.#page.getByTestId("token-value");
  }

  public get onceWarning(): Locator {
    return this.#page.getByTestId("token-once-warning");
  }

  public get issueButton(): Locator {
    return this.#page.getByTestId("token-issue");
  }

  public get rotateButton(): Locator {
    return this.#page.getByTestId("token-rotate");
  }

  public get readonlyNote(): Locator {
    return this.#page.getByTestId("token-readonly");
  }

  public get actions(): Locator {
    return this.#page.getByTestId("token-actions");
  }

  /** Click "Issue token" and wait for the raw value to be revealed once. */
  public async issue(): Promise<string> {
    await this.issueButton.click();
    await this.value.waitFor({ state: "visible" });
    return (await this.value.textContent())?.trim() ?? "";
  }
}
