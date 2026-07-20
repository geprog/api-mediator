import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the **SS-15.4 scope-identity-key confirmation screen**
 * (`/sync/scope-identity-key?pair=…`, `ScopeIdentityKeyView` + `ScopeIdentityKeyPanel`) —
 * the container-level analog of the RB-3 record identity-key panel, and the deep-link
 * target of the enablement panel's `scope-identity-key` blocker.
 *
 * Navigation + actions only; the spec keeps the assertions. Every invariant it exercises
 * (value-preserving pairings, operator-only confirmation, "no correspondence → 404") is
 * server-enforced — this drives only what the operator sees and clicks.
 */
export class ScopeIdentityKeyPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Open the panel for one resource pair (the `?pair=` query parameter addresses it). */
  public async open(resourcePairRef: string): Promise<void> {
    await this.#page.goto(`/sync/scope-identity-key?pair=${encodeURIComponent(resourcePairRef)}`);
  }

  public get view(): Locator {
    return this.#page.getByTestId("scope-identity-key-view");
  }

  public get panel(): Locator {
    return this.#page.getByTestId("scope-identity-panel");
  }

  /** The `unconfirmed` tag — present exactly while SS-18 has only *proposed* the key. */
  public get unconfirmedTag(): Locator {
    return this.#page.getByTestId("scope-identity-unconfirmed");
  }

  public get confirmedTag(): Locator {
    return this.#page.getByTestId("scope-identity-confirmed");
  }

  /** The target container the correspondence names (`appId` / `resourceRef`). */
  public get targetContainer(): Locator {
    return this.#page.getByTestId("scope-identity-target-container");
  }

  /** One proposed pairing row, keyed by its source `sourceScopeRef` component. */
  public pairing(sourceScopeKey: string): Locator {
    return this.#page.getByTestId(`scope-identity-pairing-${sourceScopeKey}`);
  }

  /** The editable target field path of one pairing (derive-then-**correct**). */
  public targetFieldInput(sourceScopeKey: string): Locator {
    return this.#page.getByTestId(`scope-identity-target-${sourceScopeKey}`);
  }

  public get confirmButton(): Locator {
    return this.#page.getByTestId("scope-identity-confirm");
  }

  public get confirmedOutcome(): Locator {
    return this.#page.getByTestId("scope-identity-confirmed-outcome");
  }

  public get error(): Locator {
    return this.#page.getByTestId("scope-identity-error");
  }
}
