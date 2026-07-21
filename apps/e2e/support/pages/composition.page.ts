import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the adapter endpoint composition screen (CU-1/CU-2,
 * `AdapterEndpointView` + `CompositionForm` + `UnionCompositionPanel`), reached at
 * `/adapter/endpoints/:id`. The CU-5 capstone uses it to prove the operator can reach a
 * union composition (strategy selectable, the union panel appears) and that a **viewer**
 * is blocked from composing it (read-only, no submit — OA-2). Navigation/actions live
 * here; assertions stay in the spec.
 */
export class CompositionPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  public async open(endpointId: string): Promise<void> {
    await this.#page.goto(`/adapter/endpoints/${endpointId}`);
  }

  public get form(): Locator {
    return this.#page.getByTestId("composition-form");
  }

  public get strategySelect(): Locator {
    return this.#page.getByTestId("composition-strategy");
  }

  public get submitButton(): Locator {
    return this.#page.getByTestId("composition-submit");
  }

  public get readonlyNote(): Locator {
    return this.#page.getByTestId("composition-readonly");
  }

  public get unionPanel(): Locator {
    return this.#page.getByTestId("union-panel");
  }

  /** One binding block on the composition form (proves the endpoint's bindings render). */
  public binding(bindingId: string): Locator {
    return this.#page.getByTestId(`composition-binding-${bindingId}`);
  }

  /** Select an aggregation strategy (e.g. `collection-union`). */
  public async selectStrategy(value: string): Promise<void> {
    await this.strategySelect.selectOption(value);
  }
}
