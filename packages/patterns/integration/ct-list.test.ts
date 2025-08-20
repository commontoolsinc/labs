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
    await sleep(50); // Quick wait for DOM update

    // Add second item - the input should be cleared automatically
    await addInput.type("Second item");
    await page.keyboard.press("Enter");
    await sleep(50); // Quick wait for DOM update

    // Add third item
    await addInput.type("Third item");
    await page.keyboard.press("Enter");
    await sleep(50); // Quick wait for DOM update

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

    // Quick wait for content to render
    await sleep(100);

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

    // Verify title was updated (no wait needed for input value)
    const titleValue = await titleInput.evaluate((el: HTMLInputElement) =>
      el.value
    );
    assertEquals(titleValue, "My Shopping List");
  });

  // TODO(#CT-703): Fix this test - there's a bug where programmatic clicks on the remove button
  // remove ALL items instead of just one. Manual clicking works correctly.
  // This appears to be an issue with how ct-list handles synthetic click events
  // versus real user clicks.
  it("should remove items from the list", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

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
    await sleep(100);

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
    await sleep(50);
    const immediateItems = await page.$$(".list-item", { strategy: "pierce" });
    console.log(
      `Immediately after click, found ${immediateItems.length} items`,
    );

    // Wait for DOM to update after removal using Astral's waitForFunction
    await page.waitForFunction((expectedCount) => {
      const items = document.querySelectorAll(".list-item");
      return items.length !== expectedCount;
    }, { args: [initialCount] });

    // Verify item was removed - try multiple times
    let remainingItems = await page.$$(".list-item", { strategy: "pierce" });
    console.log(`After removal, found ${remainingItems.length} items`);

    // If still showing same count, wait a bit more and try again
    if (remainingItems.length === initialCount) {
      console.log("DOM not updated yet, waiting more...");
      await sleep(500);
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

  it("should edit items in the list", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

    // Get initial items
    const initialItems = await page.$$(".list-item", { strategy: "pierce" });
    const initialCount = initialItems.length;
    console.log(`Initial item count: ${initialCount}`);
    assert(initialCount > 0, "Should have items to edit");

    // Get the initial text of the first item
    const initialText = await initialItems[0].evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return content?.textContent || el.textContent;
    });
    console.log(`Initial text of first item: "${initialText?.trim()}"`);

    // Find and click the first edit button
    const editButtons = await page.$$("button.item-action.edit", {
      strategy: "pierce",
    });
    console.log(`Found ${editButtons.length} edit buttons`);
    assert(editButtons.length > 0, "Should find edit buttons");

    // Debug: check what we're about to click
    const buttonText = await editButtons[0].evaluate((el: HTMLElement) => {
      return {
        className: el.className,
        title: el.title,
        innerText: el.innerText,
        parentText: el.parentElement?.innerText || "no parent",
      };
    });
    console.log("About to click edit button:", buttonText);

    // Click the edit button to enter edit mode
    await editButtons[0].evaluate((button: HTMLElement) => {
      console.log("About to dispatch click event on edit button:", button);
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
    console.log("Dispatched click event on first edit button");

    // Wait for edit mode to activate and look for the editing state
    await page.waitForSelector(".list-item.editing", { strategy: "pierce" });
    console.log("Edit mode activated - found .list-item.editing");

    // Look for the specific edit input field that appears only during editing
    const editInput = await page.$(".edit-input", {
      strategy: "pierce",
    });
    assert(editInput, "Should find .edit-input field during editing");

    // Verify the input is focused (it should have autofocus)
    const isFocused = await editInput.evaluate((el: HTMLInputElement) =>
      document.activeElement === el
    );
    console.log(`Edit input is focused: ${isFocused}`);

    // Clear the existing text and type new text
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select(); // Select all text
    });
    const newText = "Edited First Item";
    await editInput.type(newText);
    console.log(`Typed new text: "${newText}"`);

    // Press Enter to confirm the edit
    await page.keyboard.press("Enter");
    console.log("Pressed Enter to confirm edit");

    // Wait for the edit to be processed
    await sleep(200);

    // Verify the item was edited
    const updatedItems = await page.$$(".list-item", { strategy: "pierce" });
    assertEquals(
      updatedItems.length,
      initialCount,
      "Should have same number of items after edit",
    );

    // Check that the first item's text has been updated
    const updatedText = await updatedItems[0].evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return content?.textContent || el.textContent;
    });
    console.log(`Updated text of first item: "${updatedText?.trim()}"`);

    assertEquals(
      updatedText?.trim(),
      newText,
      "First item should have updated text",
    );
  });
});
