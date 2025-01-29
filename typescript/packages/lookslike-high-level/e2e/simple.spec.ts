import { test, expect } from '@playwright/test';

test("has title", async ({ page }) => {
  await page.goto("/");

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Trickle/);
});

test("can open complex iframe charm", async ({ page }) => {
  await page.goto("/");

  // Click on the link with text containing "complex iframe"
  await page.getByRole("link", { name: /complex iframe/i }).click();

  // Use frameLocator to locate the iframe and verify the text
  const frame = page.frameLocator('iframe');

  // Wait for the text "Count: 42" to appear within the iframe
  await expect(frame.locator('text=Count: 42')).toBeVisible();
});
