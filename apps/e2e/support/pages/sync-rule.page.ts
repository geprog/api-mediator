import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the SU-1 rule-enablement panel (`/sync/rules/:id`, SyncRuleView +
 * RuleEnablementPanel). Navigation + actions only; the spec keeps the assertions. Every
 * enablement invariant is server-enforced (BE-1/BE-2, OA-2) — this only drives the gate
 * checklist, the backfill choice, and the enable/disable affordances the operator sees.
 */
export class SyncRulePage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Open a rule's enablement panel directly (the SA-2 detail screen). */
  public async open(ruleId: string): Promise<void> {
    await this.#page.goto(`/sync/rules/${ruleId}`);
  }

  public get panel(): Locator {
    return this.#page.getByTestId("rule-enablement-panel");
  }

  public get status(): Locator {
    return this.#page.getByTestId("rule-status");
  }

  public get pollingState(): Locator {
    return this.#page.getByTestId("rule-polling-state");
  }

  public get readonlyBanner(): Locator {
    return this.#page.getByTestId("rule-readonly");
  }

  public get checklistReady(): Locator {
    return this.#page.getByTestId("enablement-ready");
  }

  /** A specific gate blocker, keyed by its stable checklist key (e.g. `identity-key`). */
  public checklistItem(key: string): Locator {
    return this.#page.getByTestId(`checklist-item-${key}`);
  }

  public get backfillChoice(): Locator {
    return this.#page.getByTestId("backfill-choice");
  }

  public get backfillLinkOnly(): Locator {
    return this.#page.getByTestId("backfill-link-only");
  }

  public get enableButton(): Locator {
    return this.#page.getByTestId("enable-button");
  }

  public get disableButton(): Locator {
    return this.#page.getByTestId("disable-button");
  }

  public get enableOutcome(): Locator {
    return this.#page.getByTestId("enable-outcome");
  }

  public get enableError(): Locator {
    return this.#page.getByTestId("enable-error");
  }

  /** Choose `link-only` backfill and click Enable (SU-1.2/1.5). */
  public async enableLinkOnly(): Promise<void> {
    await this.backfillLinkOnly.check();
    await this.enableButton.click();
  }
}
