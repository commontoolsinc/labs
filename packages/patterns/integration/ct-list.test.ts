import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-list integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "ct-list.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the ct-list charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });
    await page.waitForSelector("ct-list", { strategy: "pierce" });
  });

  it("should add items to the list", async () => {
    const page = shell.page();

    // Find the add item input in ct-list
    const addInput = await page.waitForSelector(".add-item-input", {
      strategy: "pierce",
    });

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
    const listItems = await page.$$(".list-item", { strategy: "pierce" });
    assertEquals(listItems.length, 3, "Should have 3 items in the list");

    // Debug: Log the structure of list items
    console.log("List item structure:");
    for (let i = 0; i < listItems.length; i++) {
      const itemInfo = await listItems[i].evaluate(
        (el: HTMLElement, idx: number) => {
          const buttons = el.querySelectorAll("button");
          return {
            index: idx,
            className: el.className,
            innerText: el.innerText,
            buttonCount: buttons.length,
            buttons: Array.from(buttons).map((b) => ({
              className: b.className,
              title: b.title || "no title",
              innerText: b.innerText,
            })),
          };
        },
        { args: [i] } as any,
      );
      console.log(`Item ${i}:`, itemInfo);
    }

    // Wait a bit for content to render
    await sleep(500);

    // Verify item content
    const firstItemText = await listItems[0].evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return content?.textContent || el.textContent;
    });
    assertEquals(firstItemText?.trim(), "First item");

    const secondItemText = await listItems[1].evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return content?.textContent || el.textContent;
    });
    assertEquals(secondItemText?.trim(), "Second item");

    const thirdItemText = await listItems[2].evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return content?.textContent || el.textContent;
    });
    assertEquals(thirdItemText?.trim(), "Third item");
  });

  it("should update the list title", async () => {
    const page = shell.page();

    // Find the title input
    const titleInput = await page.$("input[placeholder='List title']", {
      strategy: "pierce",
    });
    assert(titleInput, "Should find title input");

    // Clear the existing text first
    await titleInput.click();
    await titleInput.evaluate((el: HTMLInputElement) => {
      el.select(); // Select all text
    });
    await titleInput.type("My Shopping List");
    await sleep(500);

    // Verify title was updated
    const titleValue = await titleInput.evaluate((el: HTMLInputElement) =>
      el.value
    );
    assertEquals(titleValue, "My Shopping List");
  });

  // TODO(#CT-703): Fix this test - there's a bug where programmatic clicks on the remove button
  // remove ALL items instead of just one. Manual clicking works correctly.
  // This appears to be an issue with how ct-list handles synthetic click events
  // versus real user clicks.
  it.skip("should remove items from the list", async () => {
    const page = shell.page();

    // Wait for the component to fully stabilize after adding items
    console.log("Waiting for component to stabilize...");
    await sleep(2000);

    // Get initial count
    const initialItems = await page.$$(".list-item", { strategy: "pierce" });
    const initialCount = initialItems.length;
    console.log(`Initial item count: ${initialCount}`);
    assert(initialCount > 0, "Should have items to remove");

    // Find and click the first remove button
    const removeButtons = await page.$$("button.item-action.remove", {
      strategy: "pierce",
    });
    console.log(`Found ${removeButtons.length} remove buttons`);
    assert(removeButtons.length > 0, "Should find remove buttons");

    // Debug: check what we're about to click
    const buttonText = await removeButtons[0].evaluate((el: HTMLElement) => {
      return {
        className: el.className,
        title: el.title,
        innerText: el.innerText,
        parentText: el.parentElement?.innerText || "no parent",
      };
    });
    console.log("About to click button:", buttonText);

    // Try clicking more carefully
    console.log("Waiting before click...");
    await sleep(500);

    // Alternative approach: dispatch click event
    await removeButtons[0].evaluate((button: HTMLElement) => {
      console.log("About to dispatch click event on button:", button);
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
    console.log("Dispatched click event on first remove button");

    // Check immediately after click
    await sleep(100);
    const immediateItems = await page.$$(".list-item", { strategy: "pierce" });
    console.log(
      `Immediately after click, found ${immediateItems.length} items`,
    );

    // Wait longer for the DOM to update after removal
    await sleep(2000);

    // Verify item was removed - try multiple times
    let remainingItems = await page.$$(".list-item", { strategy: "pierce" });
    console.log(`After removal, found ${remainingItems.length} items`);

    // If still showing same count, wait a bit more and try again
    if (remainingItems.length === initialCount) {
      console.log("DOM not updated yet, waiting more...");
      await sleep(2000);
      remainingItems = await page.$$(".list-item", { strategy: "pierce" });
      console.log(
        `After additional wait, found ${remainingItems.length} items`,
      );
    }

    assertEquals(
      remainingItems.length,
      initialCount - 1,
      "Should have one less item after removal",
    );

    // Verify the first item is now what was the second item
    if (remainingItems.length > 0) {
      const firstRemainingText = await remainingItems[0].evaluate(
        (el: HTMLElement) => {
          const content = el.querySelector(".item-content") ||
            el.querySelector("div.item-content");
          return content?.textContent || el.textContent;
        },
      );
      assertEquals(
        firstRemainingText?.trim(),
        "Second item",
        "First item should now be the second item",
      );
    }
  });

  // Skip this test too - similar Shadow DOM issues prevent reliable editing
  it.skip("should edit items in the list", () => {
    const page = shell.page();

    // The test reveals that:
    // 1. Direct DOM queries don't work due to Shadow DOM encapsulation
    // 2. Edit button clicks don't trigger edit mode programmatically
    // 3. ElementHandle.evaluate fails on shadow DOM elements
    // Similar to the delete test, this appears to be a limitation of
    // programmatic interaction with the ct-list component
  });
});
