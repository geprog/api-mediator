import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the spec view (SI-3 + RB-3): the IR viewer and the
 * `ResourceBinding` confirmation panel. Ref locators are scoped to a single
 * resource's binding card (`binding-resource-<resourceRef>`) so a test can assert
 * on the `issue` resource without colliding with the other groups' bindings.
 */
export class SpecPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  public get bindingPanel(): Locator {
    return this.#page.getByTestId("binding-panel");
  }

  public get irViewer(): Locator {
    return this.#page.getByTestId("ir-viewer");
  }

  public irGroup(resourceRef: string): Locator {
    return this.#page.getByTestId(`ir-group-${resourceRef}`);
  }

  public irOperation(operationId: string): Locator {
    return this.#page.getByTestId(`ir-operation-${operationId}`);
  }

  /**
   * Drill into a schema's `<details>` disclosure within a specific resource group
   * and return it (so its fields become visible). Scoped to the group because a
   * schema name (e.g. `Issue`) can appear in more than one group's IR.
   */
  public async expandSchema(resourceRef: string, schemaName: string): Promise<Locator> {
    const details = this.irGroup(resourceRef).getByTestId(`ir-schema-${schemaName}`);
    await details.locator("summary").click();
    return details;
  }

  public bindingCard(resourceRef: string): Locator {
    return this.#page.getByTestId(`binding-resource-${resourceRef}`);
  }

  public refState(resourceRef: string, refKind: string): Locator {
    return this.bindingCard(resourceRef).getByTestId(`ref-state-${refKind}`);
  }

  public refValue(resourceRef: string, refKind: string): Locator {
    return this.bindingCard(resourceRef).getByTestId(`ref-value-${refKind}`);
  }

  public refRow(resourceRef: string, refKind: string): Locator {
    return this.bindingCard(resourceRef).getByTestId(`ref-row-${refKind}`);
  }

  public refNotApplicable(resourceRef: string, refKind: string): Locator {
    return this.bindingCard(resourceRef).getByTestId(`ref-na-${refKind}`);
  }

  public confirmButton(resourceRef: string, refKind: string): Locator {
    return this.bindingCard(resourceRef).getByTestId(`ref-confirm-${refKind}`);
  }

  /** Confirm a ref's heuristic guess as-is (RB-2). */
  public async confirm(resourceRef: string, refKind: string): Promise<void> {
    await this.confirmButton(resourceRef, refKind).click();
  }

  /** Correct a ref to a different IR operation and confirm it in one action (RB-2). */
  public async correctToOperation(
    resourceRef: string,
    refKind: string,
    operationId: string,
  ): Promise<void> {
    const card = this.bindingCard(resourceRef);
    await card.getByTestId(`ref-correct-${refKind}`).click();
    await card.getByTestId(`ref-kind-select-${refKind}`).selectOption("operation");
    await card.getByTestId(`ref-target-select-${refKind}`).selectOption(`operation:${operationId}`);
    await card.getByTestId(`ref-save-${refKind}`).click();
  }
}
