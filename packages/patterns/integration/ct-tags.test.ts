import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-tags integration test", () => {
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
          "ct-tags.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the ct-tags charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });
    await page.waitForSelector("ct-tags", { strategy: "pierce" });
  });

  it("should add tags to the list", async () => {
    const page = shell.page();

    // Helper function to add a tag
    const addTag = async (tagText: string) => {
      // Find the add tag button
      const addTagButton = await page.waitForSelector(".add-tag", {
        strategy: "pierce",
      });

      // Click using evaluate to ensure it works
      await addTagButton.evaluate((el: HTMLElement) => {
        el.click();
      });
      await sleep(100); // Wait for input to appear

      const addInput = await page.waitForSelector(".add-tag-input", {
        strategy: "pierce",
      });
      await addInput.type(tagText);
      await page.keyboard.press("Enter");
      await sleep(100); // Wait for DOM update
    };

    // Add first tag
    await addTag("frontend");

    // Add second tag
    await addTag("javascript");

    // Add third tag
    await addTag("testing");

    // Verify tags were added
    const tags = await page.$$(".tag", { strategy: "pierce" });
    assertEquals(tags.length, 3, "Should have 3 tags");

    // Debug: Log the structure of tags
    console.log("Tag structure:");
    for (let i = 0; i < tags.length; i++) {
      const tagInfo = await tags[i].evaluate(
        (el: HTMLElement, idx: number) => {
          const tagText = el.querySelector(".tag-text");
          const removeButton = el.querySelector(".tag-remove");
          return {
            index: idx,
            className: el.className,
            tagText: tagText?.textContent || "no text",
            hasRemoveButton: !!removeButton,
          };
        },
        { args: [i] } as any,
      );
      console.log(`Tag ${i}:`, tagInfo);
    }

    // Verify tag content
    const firstTagText = await tags[0].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });
    assertEquals(firstTagText?.trim(), "frontend");

    const secondTagText = await tags[1].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });
    assertEquals(secondTagText?.trim(), "javascript");

    const thirdTagText = await tags[2].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });
    assertEquals(thirdTagText?.trim(), "testing");
  });

  it("should not add duplicate tags", async () => {
    const page = shell.page();

    // Helper function to add a tag
    const addTag = async (tagText: string) => {
      const addTagButton = await page.waitForSelector(".add-tag", {
        strategy: "pierce",
      });

      await addTagButton.evaluate((el: HTMLElement) => {
        el.click();
      });
      await sleep(100);

      const addInput = await page.waitForSelector(".add-tag-input", {
        strategy: "pierce",
      });
      await addInput.type(tagText);
      await page.keyboard.press("Enter");
      await sleep(100);
    };

    // Try to add a duplicate tag
    await addTag("frontend"); // This already exists

    // Should still have 3 tags, not 4
    const tags = await page.$$(".tag", { strategy: "pierce" });
    assertEquals(tags.length, 3, "Should still have 3 tags (no duplicates)");
  });

  it("should edit tags", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

    // Get initial tags
    const initialTags = await page.$$(".tag", { strategy: "pierce" });
    const initialCount = initialTags.length;
    console.log(`Initial tag count: ${initialCount}`);
    assert(initialCount > 0, "Should have tags to edit");

    // Click on the first tag to edit it
    await initialTags[0].click();
    console.log("Clicked on first tag");

    // Wait for edit mode to activate
    await page.waitForSelector(".tag.editing", { strategy: "pierce" });
    console.log("Edit mode activated - found .tag.editing");

    // Look for the tag input field that appears during editing
    const editInput = await page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });
    assert(editInput, "Should find .tag-input field during editing");

    // Clear and type new text
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select(); // Select all text
    });
    const newText = "backend";
    await editInput.type(newText);
    console.log(`Typed new text: "${newText}"`);

    // Press Enter to confirm the edit
    await page.keyboard.press("Enter");
    console.log("Pressed Enter to confirm edit");

    // Wait for the edit to be processed
    await sleep(200);

    // Verify the tag was edited
    const updatedTags = await page.$$(".tag", { strategy: "pierce" });
    assertEquals(
      updatedTags.length,
      initialCount,
      "Should have same number of tags after edit",
    );

    // Check that the first tag's text has been updated
    const updatedText = await updatedTags[0].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });
    console.log(`Updated text of first tag: "${updatedText?.trim()}"`);

    assertEquals(
      updatedText?.trim(),
      newText,
      "First tag should have updated text",
    );
  });

  it("should remove tags", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

    // Get initial count
    const initialTags = await page.$$(".tag", { strategy: "pierce" });
    const initialCount = initialTags.length;
    console.log(`Initial tag count: ${initialCount}`);
    assert(initialCount > 0, "Should have tags to remove");

    // Hover over the first tag to make the remove button visible
    await initialTags[0].evaluate((el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await sleep(100); // Wait for hover effect

    // Find and click the first remove button
    const removeButtons = await page.$$(".tag-remove", {
      strategy: "pierce",
    });
    console.log(`Found ${removeButtons.length} remove buttons`);
    assert(removeButtons.length > 0, "Should find remove buttons");

    // Debug: check what we're about to click
    const buttonInfo = await removeButtons[0].evaluate((el: HTMLElement) => {
      return {
        className: el.className,
        title: el.title,
        innerText: el.innerText,
        parentText: el.parentElement?.innerText || "no parent",
      };
    });
    console.log("About to click remove button:", buttonInfo);

    // Click the remove button
    await removeButtons[0].evaluate((button: HTMLElement) => {
      console.log("About to dispatch click event on remove button:", button);
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
    console.log("Dispatched click event on first remove button");

    // Wait for DOM to update after removal
    await sleep(200);

    // Verify tag was removed
    const remainingTags = await page.$$(".tag", { strategy: "pierce" });
    console.log(`After removal, found ${remainingTags.length} tags`);

    assertEquals(
      remainingTags.length,
      initialCount - 1,
      "Should have one less tag after removal",
    );

    // Verify the first tag is now what was the second tag
    if (remainingTags.length > 0) {
      const firstRemainingText = await remainingTags[0].evaluate(
        (el: HTMLElement) => {
          const tagText = el.querySelector(".tag-text");
          return tagText?.textContent || el.textContent;
        },
      );
      assertEquals(
        firstRemainingText?.trim(),
        "javascript",
        "First tag should now be the second tag",
      );
    }
  });

  it("should cancel tag editing with Escape key", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

    // Helper function to add a tag if needed
    const addTag = async (tagText: string) => {
      const addTagButton = await page.waitForSelector(".add-tag", {
        strategy: "pierce",
      });

      await addTagButton.evaluate((el: HTMLElement) => {
        el.click();
      });
      await sleep(100);

      const addInput = await page.waitForSelector(".add-tag-input", {
        strategy: "pierce",
      });
      await addInput.type(tagText);
      await page.keyboard.press("Enter");
      await sleep(100);
    };

    let tags = await page.$$(".tag", { strategy: "pierce" });

    // Add a tag if none exist
    if (tags.length === 0) {
      await addTag("test-tag");
      tags = await page.$$(".tag", { strategy: "pierce" });
    }

    assert(tags.length > 0, "Should have tags to test escape behavior");

    // Get the original text of the first tag
    const originalText = await tags[0].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });

    // Click on the first tag to edit it
    await tags[0].click();

    // Wait for edit mode
    await page.waitForSelector(".tag.editing", { strategy: "pierce" });

    // Find the edit input and type some text
    const editInput = await page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select();
    });
    await editInput.type("should-be-cancelled");

    // Press Escape to cancel
    await page.keyboard.press("Escape");
    await sleep(100);

    // Verify the edit was cancelled and original text is preserved
    const updatedTags = await page.$$(".tag", { strategy: "pierce" });
    const currentText = await updatedTags[0].evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });

    assertEquals(
      currentText?.trim(),
      originalText?.trim(),
      "Tag text should be unchanged after Escape",
    );
  });

  it("should delete empty tags when backspacing", async () => {
    const page = shell.page();

    console.log("Waiting for component to stabilize...");
    await sleep(500);

    // Helper function to add a tag if needed
    const addTag = async (tagText: string) => {
      const addTagButton = await page.waitForSelector(".add-tag", {
        strategy: "pierce",
      });

      await addTagButton.evaluate((el: HTMLElement) => {
        el.click();
      });
      await sleep(100);

      const addInput = await page.waitForSelector(".add-tag-input", {
        strategy: "pierce",
      });
      await addInput.type(tagText);
      await page.keyboard.press("Enter");
      await sleep(100);
    };

    // Get initial count
    let initialTags = await page.$$(".tag", { strategy: "pierce" });

    // Add a tag if none exist
    if (initialTags.length === 0) {
      await addTag("test-tag");
      initialTags = await page.$$(".tag", { strategy: "pierce" });
    }

    const initialCount = initialTags.length;

    // Click on the first tag to edit it
    await initialTags[0].click();

    // Wait for edit mode
    await page.waitForSelector(".tag.editing", { strategy: "pierce" });

    // Find the edit input and clear all text using keyboard
    const editInput = await page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });

    // Select all text and delete it
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select();
    });
    await page.keyboard.press("Delete");
    await sleep(50); // Wait for input to be cleared

    // Press Backspace on empty input
    await page.keyboard.press("Backspace");
    await sleep(200);

    // Verify the tag was removed
    const remainingTags = await page.$$(".tag", { strategy: "pierce" });
    assertEquals(
      remainingTags.length,
      initialCount - 1,
      "Should have one less tag after backspacing empty tag",
    );
  });
});
