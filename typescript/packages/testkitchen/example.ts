import { expect, test } from "@playwright/test";

test.describe("Counter Management Interface", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`http://localhost:5173/`);
  });

  test("should be able to add new counters", async ({ page }) => {
    const initialCounters = await page.locator("li").count();
    await page.click("button#add");
    await expect(page.locator("li")).toHaveCount(initialCounters + 1);
    await expect(page.locator("li").last()).toContainText("item 1 - 0");
  });

  test("should increment individual counters", async ({ page }) => {
    await page.click("button#add");
    const incrementButton = page
      .locator("li")
      .first()
      .locator("button.increment");
    await incrementButton.click();
    await expect(page.locator("li").first()).toContainText("item 1 - 1");
  });

  test("should remove specific counters", async ({ page }) => {
    // Add two counters
    await page.click("button#add");
    await page.click("button#add");
    const initialCounters = await page.locator("li").count();

    // Remove the first counter
    await page.locator("li").first().locator("button.remove").click();
    await expect(page.locator("li")).toHaveCount(initialCounters - 1);
  });

  test("should randomly increment counters", async ({ page }) => {
    // Add multiple counters
    await page.click("button#add");
    await page.click("button#add");
    await page.click("button#add");

    // Store initial values
    const initialValues = await Promise.all(
      (await page.locator("li").all()).map(async (li) =>
        parseInt(((await li.textContent()) || "").match(/\d+$/)?.[0] || "0")
      ),
    );

    // Click random increment button
    await page.click("button#randomIncrement");

    // Get new values
    const newValues = await Promise.all(
      (await page.locator("li").all()).map(async (li) =>
        parseInt(((await li.textContent()) || "").match(/\d+$/)?.[0] || "0")
      ),
    );

    // Verify that exactly one counter was incremented
    const incrementedCount = newValues.reduce(
      (acc, val, idx) => acc + (val > initialValues[idx] ? 1 : 0),
      0,
    );
    expect(incrementedCount).toBe(1);
  });

  test("should maintain accurate total", async ({ page }) => {
    // Add two counters
    await page.click("button#add");
    await page.click("button#add");

    // Increment first counter twice
    const firstIncrement = page
      .locator("li")
      .first()
      .locator("button.increment");
    await firstIncrement.click();
    await firstIncrement.click();

    // Increment second counter once
    await page.locator("li").nth(1).locator("button.increment").click();

    // Total should be 3
    await expect(page.locator("p").filter({ hasText: "Total:" })).toContainText(
      "Total: 3",
    );
  });

  test("should edit collection title", async ({ page }) => {
    const titleInput = page.locator("common-input#title");
    await titleInput.click();
    await titleInput.fill("My Custom Counters");
    await titleInput.press("Enter");

    // Verify the title was updated
    // Note: You might need to adjust this based on how your app displays the title
    await expect(page.locator("common-input#title")).toHaveValue(
      "My Custom Counters",
    );
  });

  test("should handle multiple operations in sequence", async ({ page }) => {
    // Add three counters
    await page.click("button#add");
    await page.click("button#add");
    await page.click("button#add");

    // Increment various counters
    await page.locator("li").nth(0).locator("button.increment").click();
    await page.locator("li").nth(1).locator("button.increment").click();
    await page.locator("li").nth(1).locator("button.increment").click();
    await page.locator("li").nth(2).locator("button.increment").click();

    // Remove middle counter
    await page.locator("li").nth(1).locator("button.remove").click();

    // Verify we have 2 counters remaining
    await expect(page.locator("li")).toHaveCount(2);

    // Verify total is correct (should be 2: 1 from first counter + 1 from last counter)
    await expect(page.locator("p").filter({ hasText: "Total:" })).toContainText(
      "Total: 2",
    );
  });
});
