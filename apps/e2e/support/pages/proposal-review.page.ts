import type { Locator, Page } from "@playwright/test";

/**
 * Page object for the proposal review screen (RU-1..RU-4 / ProposalReviewView).
 * Navigation + actions only; the spec keeps the assertions. Item-scoped locators
 * key on the seeded item id (`item-card-<id>`), so a test drives one specific
 * correspondence without colliding with the others.
 */
export class ProposalReviewPage {
  readonly #page: Page;

  public constructor(page: Page) {
    this.#page = page;
  }

  /** Open a proposal's review screen directly (a real screen calling RA-1 detail). */
  public async open(proposalId: string): Promise<void> {
    await this.#page.goto(`/proposals/${proposalId}`);
  }

  public get items(): Locator {
    return this.#page.getByTestId("review-items");
  }

  public get readonlyBanner(): Locator {
    return this.#page.getByTestId("review-readonly");
  }

  public get status(): Locator {
    return this.#page.getByTestId("review-status");
  }

  public itemCard(itemId: string): Locator {
    return this.#page.getByTestId(`item-card-${itemId}`);
  }

  public itemState(itemId: string): Locator {
    return this.itemCard(itemId).getByTestId("item-state");
  }

  /** Accept a pending mapped item (RA-2 accept). */
  public async acceptItem(itemId: string): Promise<void> {
    await this.itemCard(itemId).getByTestId("item-accept").click();
  }

  /** Reject a pending item (RA-2 reject — permanent). */
  public async rejectItem(itemId: string): Promise<void> {
    await this.itemCard(itemId).getByTestId("item-reject").click();
  }

  /**
   * Open the inline edit form for a field item, re-point its `targetRef` to
   * `resourceRef`/`path`, and save it (RA-2 edit). The transform keeps the item's
   * suggested value (pre-filled by the draft). Target-IR validation is the server's
   * (AS-3), applied at approve — an unresolvable path is accepted here.
   */
  public async editFieldTarget(itemId: string, resourceRef: string, path: string): Promise<void> {
    const card = this.itemCard(itemId);
    await card.getByTestId("item-edit").click();
    await card.getByTestId("item-edit-resource").fill(resourceRef);
    await card.getByTestId("item-edit-path").fill(path);
    await card.getByTestId("item-save-edit").click();
  }

  // ── Identity-key panel (RU-4) ──────────────────────────────────────────────

  public get identityPanel(): Locator {
    return this.#page.getByTestId("identity-panel");
  }

  public identityCandidate(itemId: string): Locator {
    return this.#page.getByTestId(`identity-candidate-${itemId}`);
  }

  public get identityConfirmButton(): Locator {
    return this.#page.getByTestId("identity-confirm");
  }

  /**
   * Confirm the identity key on `itemId` (RA-3), optionally setting the target
   * lookup parameter. Confirming **also approves** the currently-decided selection.
   */
  public async confirmIdentityKey(itemId: string, targetLookupParamRef?: string): Promise<void> {
    await this.identityCandidate(itemId).check();
    if (targetLookupParamRef !== undefined) {
      await this.#page.getByTestId("identity-lookup-param").fill(targetLookupParamRef);
    }
    await this.identityConfirmButton.click();
  }

  // ── Approve (RU-4 crit 5/6) ────────────────────────────────────────────────

  public get approveSection(): Locator {
    return this.#page.getByTestId("review-approve");
  }

  public get approveButton(): Locator {
    return this.#page.getByTestId("approve-button");
  }

  public get approveError(): Locator {
    return this.#page.getByTestId("approve-error");
  }

  public get approveOutcome(): Locator {
    return this.#page.getByTestId("approve-outcome");
  }

  /** Approve the decided selection (RA-4). */
  public async approve(): Promise<void> {
    await this.approveButton.click();
  }
}
