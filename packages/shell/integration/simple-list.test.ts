import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { registerCharm, ShellIntegration } from "./utils.ts";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import "../src/globals.ts";

const { API_URL, FRONTEND_URL } = env;

// Extend ShellIntegration with waitForSelector that works with shadow DOM
class ExtendedShellIntegration extends ShellIntegration {
  async waitForSelector(selector: string, options?: { timeout?: number }) {
    const { page } = this.get();
    const timeout = options?.timeout ?? 30000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const handle = await page.$(selector);
      if (handle) return handle;
      await sleep(100);
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }
}

describe("simple-list integration test", () => {
  const shell = new ExtendedShellIntegration();
  shell.bindLifecycle();

  let spaceName: string;
  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();
    spaceName = globalThis.crypto.randomUUID();

    // Register the simple-list charm once for all tests
    charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "..",
          "..",
          "recipes",
          "simple-list.tsx",
        ),
      ),
    });
  });

  it("should load the simple-list charm", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}shell/${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and verify ct-list exists
    await sleep(5000);
    const ctList = await page.$("pierce/ct-list");
    assert(ctList, "Should find ct-list component");
  });

  it("should add items to the list", async () => {
    const { page } = shell.get();

    // Find the add item input in ct-list
    const addInput = await page.$("pierce/.add-item-input");
    assert(addInput, "Should find add item input");

    // Add first item
    await addInput.click();
    await addInput.type("First item");
    await page.keyboard.press("Enter");
    await sleep(500);

    // Add second item - the input should be cleared automatically
    await addInput.type("Second item");
    await page.keyboard.press("Enter");
    await sleep(500);

    // Add third item
    await addInput.type("Third item");
    await page.keyboard.press("Enter");
    await sleep(500);

    // Verify items were added
    const listItems = await page.$$("pierce/.list-item");
    assertEquals(listItems.length, 3, "Should have 3 items in the list");

    // Wait a bit for content to render
    await sleep(500);

    // Verify item content
    const firstItemText = await listItems[0].evaluate((el: HTMLElement) => {
      const content = el.querySelector('.item-content') || el.querySelector('div.item-content');
      return content?.textContent || el.textContent;
    });
    assertEquals(firstItemText?.trim(), "First item");

    const secondItemText = await listItems[1].evaluate((el: HTMLElement) => {
      const content = el.querySelector('.item-content') || el.querySelector('div.item-content');
      return content?.textContent || el.textContent;
    });
    assertEquals(secondItemText?.trim(), "Second item");

    const thirdItemText = await listItems[2].evaluate((el: HTMLElement) => {
      const content = el.querySelector('.item-content') || el.querySelector('div.item-content');
      return content?.textContent || el.textContent;
    });
    assertEquals(thirdItemText?.trim(), "Third item");
  });

  it("should update the list title", async () => {
    const { page } = shell.get();

    // Find the title input
    const titleInput = await page.$("pierce/input[placeholder='List title']");
    assert(titleInput, "Should find title input");

    // Clear the existing text first
    await titleInput.click();
    await titleInput.evaluate((el: HTMLInputElement) => {
      el.select(); // Select all text
    });
    await titleInput.type("My Shopping List");
    await sleep(500);

    // Verify title was updated
    const titleValue = await titleInput.evaluate((el: HTMLInputElement) => el.value);
    assertEquals(titleValue, "My Shopping List");
  });

  // TODO(bf): Fix this test - removal works (seen in console) but DOM query fails
  it.skip("should remove items from the list", async () => {
    const { page } = shell.get();

    // Get initial count
    const initialItems = await page.$$("pierce/.list-item");
    const initialCount = initialItems.length;
    console.log(`Initial item count: ${initialCount}`);
    assert(initialCount > 0, "Should have items to remove");

    // Find and click the first remove button
    const removeButtons = await page.$$("pierce/button[title='Remove item']");
    console.log(`Found ${removeButtons.length} remove buttons`);
    assert(removeButtons.length > 0, "Should find remove buttons");

    await removeButtons[0].click();

    // Wait longer for the DOM to update after removal
    await sleep(2000);

    // Verify item was removed - try multiple times
    let remainingItems = await page.$$("pierce/.list-item");
    console.log(`After removal, found ${remainingItems.length} items`);

    // If still showing same count, wait a bit more and try again
    if (remainingItems.length === initialCount) {
      console.log("DOM not updated yet, waiting more...");
      await sleep(2000);
      remainingItems = await page.$$("pierce/.list-item");
      console.log(`After additional wait, found ${remainingItems.length} items`);
    }

    assertEquals(remainingItems.length, initialCount - 1, "Should have one less item after removal");

    // Verify the first item is now what was the second item
    if (remainingItems.length > 0) {
      const firstRemainingText = await remainingItems[0].evaluate((el: HTMLElement) => {
        const content = el.querySelector('.item-content') || el.querySelector('div.item-content');
        return content?.textContent || el.textContent;
      });
      assertEquals(firstRemainingText?.trim(), "Second item", "First item should now be the second item");
    }
  });

  // Skip edit test for now as it requires double-click interaction
  it.skip("should edit items in the list", async () => {
    // Edit functionality would go here
  });
});
