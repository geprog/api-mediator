import { expect, test } from "@playwright/test";

/**
 * Toolchain smoke test: proves Playwright + Chromium run end-to-end without a
 * server by rendering an inline `data:` document and asserting on it.
 */
test("renders a static data URL without a running server", async ({ page }) => {
  await page.goto(
    "data:text/html,<!doctype html><title>Mediator smoke</title><h1 id=marker>ok</h1>",
  );

  await expect(page).toHaveTitle("Mediator smoke");
  await expect(page.locator("#marker")).toHaveText("ok");
});
