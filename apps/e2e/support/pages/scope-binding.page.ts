import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the **scope path-parameter rows** of the RB-3 binding panel
 * (`/specs/:id`, `BindingPanel` → `ScopeBindingRow`) — specifically the SS-9.2 kind
 * selector as SS-18.4 extends it to Layer 3.
 *
 * SS-18.4 deliberately splits the `scope-link` choice into **two** operator actions, and
 * this object keeps them separate so a spec can assert the difference:
 *
 *  - {@link selectScopeLink} — *select* the kind. The entry is written with its derived
 *    `scopeKeyRef` and left **unconfirmed**, so the choice is recorded but used nowhere.
 *  - {@link confirmScopeLink} — *ratify* it, stamping the confirmation pair.
 *
 * `scope-link` is only a selectable option once the resource's pair has a proposed
 * `ScopeCorrespondence`, so this object is also how a spec proves SS-18's authoring step
 * actually unlocked the Layer-3 kind.
 */
export class ScopeBindingPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Open the spec view that hosts the binding panel. */
  public async open(specId: string): Promise<void> {
    await this.#page.goto(`/specs/${specId}`);
  }

  /** The scope rows of one resource's binding card. */
  public scopeSection(resourceRef: string): Locator {
    return this.#page.getByTestId(`scope-bindings-${resourceRef}`);
  }

  /** One scope path-parameter row. */
  public row(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-row-${parameterName}`);
  }

  /** The row's current persisted fill-source kind (`constant` / `record-derived` / `scope-link`). */
  public kindTag(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-kind-${parameterName}`);
  }

  /** The row's confirmation state (`confirmed` / `unconfirmed`). */
  public stateTag(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-state-${parameterName}`);
  }

  public kindSelect(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-kind-select-${parameterName}`);
  }

  /** The `scope-link` option — disabled until the pair has a proposed `ScopeCorrespondence`. */
  public scopeLinkOption(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-kind-option-${parameterName}-scope-link`);
  }

  /** The `scopeKeyRef` input, pre-filled with the mediator's derived candidate. */
  public scopeKeyRefInput(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-keyref-input-${parameterName}`);
  }

  public selectLinkButton(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-select-link-${parameterName}`);
  }

  public confirmButton(parameterName: string): Locator {
    return this.#page.getByTestId(`scope-confirm-${parameterName}`);
  }

  /**
   * Choose a fill-source kind in the row's selector **without** writing anything. The
   * kind-specific input (e.g. the `scopeKeyRef` field, pre-filled with the mediator's derived
   * candidate) only renders once its kind is selected, so a spec that wants to assert on that
   * pre-fill must choose the kind first.
   */
  public async chooseKind(parameterName: string, kind: string): Promise<void> {
    await this.kindSelect(parameterName).selectOption(kind);
  }

  /**
   * Switch a parameter to the `scope-link` kind and **select** it (SS-18.4): the entry is
   * persisted unconfirmed. `scopeKeyRef` overrides the derived candidate when supplied.
   */
  public async selectScopeLink(parameterName: string, scopeKeyRef?: string): Promise<void> {
    await this.kindSelect(parameterName).selectOption("scope-link");
    if (scopeKeyRef !== undefined) {
      await this.scopeKeyRefInput(parameterName).fill(scopeKeyRef);
    }
    await this.selectLinkButton(parameterName).click();
  }

  /** Confirm the already-selected `scope-link` entry (SS-18.4's second, explicit action). */
  public async confirmScopeLink(parameterName: string, scopeKeyRef?: string): Promise<void> {
    await this.kindSelect(parameterName).selectOption("scope-link");
    if (scopeKeyRef !== undefined) {
      await this.scopeKeyRefInput(parameterName).fill(scopeKeyRef);
    }
    await this.confirmButton(parameterName).click();
  }
}
