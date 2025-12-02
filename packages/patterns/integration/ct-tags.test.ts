import { env, Page, waitFor } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";
import { ElementHandle } from "@astral/astral";

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
      { start: false },
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
      view: {
        spaceName: SPACE_NAME,
        charmId,
      },
      identity,
    });
    await page.waitForSelector("ct-tags", { strategy: "pierce" });
  });

  it("should add tags to the list", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    await tags.addTag("frontend");
    await tags.waitForTagCount(1);
    await tags.addTag("javascript");
    await tags.waitForTagCount(2);
    await tags.addTag("testing");
    await tags.waitForTagCount(3);
    assertEquals(await tags.getTagsText(), [
      "frontend",
      "javascript",
      "testing",
    ]);
  });

  it("should not add duplicate tags", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    assertEquals((await tags.getTags()).length, 3);

    // Try to add a duplicate tag
    await tags.addTag("frontend");
    await tags.waitForTagCount(3);
    assertEquals(await tags.getTagsText(), [
      "frontend",
      "javascript",
      "testing",
    ]);
  });

  it("should edit tags", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    assertEquals(
      (await tags.getTags()).length,
      3,
      "Should still have 3 tags (no duplicates)",
    );

    const newText = "backend";
    const tagEls = await tags.getTags();
    await tags.editTag(tagEls[0], newText);
    await waitFor(() =>
      tags.getTags().then((els) => tags.getTagText(els[0])).then((text) =>
        text === newText
      )
    );
    assertEquals(await tags.getTagsText(), [
      "backend",
      "javascript",
      "testing",
    ]);
  });

  it("should remove tags", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    assertEquals((await tags.getTags()).length, 3);
    const elements = await tags.getTags();
    await tags.removeTag(elements[0]);
    await tags.waitForTagCount(2);
    assertEquals(await tags.getTagsText(), [
      "javascript",
      "testing",
    ]);
  });

  it("should cancel tag editing with Escape key", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    assertEquals((await tags.getTags()).length, 2);
    const originalTexts = await tags.getTagsText();

    const elements = await tags.getTags();
    const element = elements[0];
    await element.click();
    await page.waitForSelector(".tag.editing", { strategy: "pierce" });
    const editInput = await page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });
    await editInput.evaluate((el: HTMLInputElement) => el.select());
    await editInput.type("should-be-cancelled");
    await page.keyboard.press("Escape");
    await sleep(100);
    assertEquals(await tags.getTagsText(), originalTexts);
  });

  it("should delete empty tags when backspacing", async () => {
    const page = shell.page();
    const tags = new Tags(page);
    assertEquals((await tags.getTags()).length, 2);

    const elements = await tags.getTags();
    const element = elements[0];
    await element.click();
    await page.waitForSelector(".tag.editing", { strategy: "pierce" });
    const editInput = await page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });
    await editInput.evaluate((el: HTMLInputElement) => el.select());
    await page.keyboard.press("Delete");
    await sleep(50); // Wait for input to be cleared
    // Press Backspace on empty input
    await page.keyboard.press("Backspace");
    await sleep(200);

    await tags.waitForTagCount(1);
  });
});

class Tags {
  #page: Page;
  constructor(page: Page) {
    this.#page = page;
  }

  getTags(): Promise<ElementHandle[]> {
    return this.#page.$$(".tag", { strategy: "pierce" });
  }

  async getTagsText(): Promise<Array<string | undefined>> {
    const elements = await this.getTags();
    return Promise.all(elements.map((el) => this.getTagText(el)));
  }

  async editTag(element: ElementHandle, newText: string) {
    await element.click();
    await this.#page.waitForSelector(".tag.editing", { strategy: "pierce" });
    // Look for the tag input field that appears during editing
    const editInput = await this.#page.waitForSelector(".tag-input", {
      strategy: "pierce",
    });

    // Clear and type new text
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select(); // Select all text
    });
    await editInput.type(newText);
    await this.#page.keyboard.press("Enter");
    await sleep(100);
  }

  async waitForTagCount(expected: number): Promise<void> {
    await waitFor(() => this.getTags().then((els) => els.length === expected));
  }

  async waitForTagText(element: ElementHandle, text: string): Promise<void> {
    await waitFor(() =>
      element.evaluate((el: HTMLInputElement) => el.value).then((value) =>
        value === text
      )
    );
  }

  async getTagText(element: ElementHandle): Promise<string | undefined> {
    return await element.evaluate((el: HTMLElement) => {
      const tagText = el.querySelector(".tag-text");
      return tagText?.textContent || el.textContent;
    });
  }

  async addTag(text: string) {
    const addTagButton = await this.#page.waitForSelector(".add-tag", {
      strategy: "pierce",
    });
    await addTagButton.click();
    const addInput = await this.#page.waitForSelector(".add-tag-input", {
      strategy: "pierce",
    });
    await addInput.type(text);
    await this.#page.keyboard.press("Enter");
    await sleep(100);
  }

  async removeTag(element: ElementHandle): Promise<void> {
    // Hover over the first tag to make the remove button visible
    await element.evaluate((el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    // Find and click the first remove button
    const removeButtons = await this.#page.waitForSelector(".tag-remove", {
      strategy: "pierce",
    });
    await removeButtons.evaluate((button: HTMLElement) => {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
  }
}
