import { env, Page, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";
import { ElementHandle } from "@astral/astral";

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
      { start: false },
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
      view: {
        spaceName: SPACE_NAME,
        charmId,
      },
      identity,
    });
    await page.waitForSelector("ct-list", { strategy: "pierce" });
  });

  it("should add items to the list", async () => {
    const page = shell.page();
    const list = new List(page);

    await list.addItem("First item");
    await list.waitForItemCount(1);

    await list.addItem("Second item");
    await list.waitForItemCount(2);

    await list.addItem("Third item");
    await list.waitForItemCount(3);

    assertEquals(await list.getItemsText(), [
      "First item",
      "Second item",
      "Third item",
    ]);
  });

  it("should update the list title", async () => {
    const page = shell.page();
    const list = new List(page);

    await list.setTitle("My Shopping List");
    assertEquals(await list.getTitle(), "My Shopping List");
  });

  // TODO(#CT-703): Fix this test - there's a bug where programmatic clicks on the remove button
  // remove ALL items instead of just one. Manual clicking works correctly.
  // This appears to be an issue with how ct-list handles synthetic click events
  // versus real user clicks.
  it("should remove items from the list", async () => {
    const page = shell.page();
    const list = new List(page);

    const items = await list.getItems();
    assert(items.length > 0, "Should have items to remove");
    const initialCount = items.length;

    await list.removeItem(items[0]);
    await list.waitForItemCount(initialCount - 1);

    assertEquals(await list.getItemsText(), [
      "Second item",
      "Third item",
    ]);
  });

  it("should edit items in the list", async () => {
    const page = shell.page();
    const list = new List(page);

    const items = await list.getItems();
    assert(items.length > 0, "Should have items to edit");

    const newText = "Edited Second Item";
    await list.editItem(items[0], newText);
    await waitFor(() =>
      list.getItems().then((els) => list.getItemText(els[0])).then((text) =>
        text === newText
      )
    );

    assertEquals(await list.getItemsText(), [
      "Edited Second Item",
      "Third item",
    ]);
  });
});

class List {
  #page: Page;
  constructor(page: Page) {
    this.#page = page;
  }

  getItems(): Promise<ElementHandle[]> {
    return this.#page.$$(".list-item", { strategy: "pierce" });
  }

  async getItemsText(): Promise<Array<string | undefined>> {
    const elements = await this.getItems();
    return Promise.all(elements.map((el) => this.getItemText(el)));
  }

  async getItemText(element: ElementHandle): Promise<string | undefined> {
    return await element.evaluate((el: HTMLElement) => {
      const content = el.querySelector(".item-content") ||
        el.querySelector("div.item-content");
      return (content?.textContent || el.textContent)?.trim();
    });
  }

  async waitForItemCount(expected: number): Promise<void> {
    await waitFor(() => this.getItems().then((els) => els.length === expected));
  }

  async addItem(text: string): Promise<void> {
    const addInput = await this.#page.waitForSelector(".add-item-input", {
      strategy: "pierce",
    });
    await addInput.click();
    await addInput.type(text);
    await this.#page.keyboard.press("Enter");
  }

  async removeItem(element: ElementHandle): Promise<void> {
    // Find the remove button within this item
    const removeButton = await element.$("button.item-action.remove");
    assert(removeButton, "Should find remove button in item");

    await removeButton.evaluate((button: HTMLElement) => {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });
  }

  async editItem(element: ElementHandle, newText: string): Promise<void> {
    // Find the edit button within this item
    const editButton = await element.$("button.item-action.edit");
    assert(editButton, "Should find edit button in item");

    await editButton.evaluate((button: HTMLElement) => {
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    });

    // Wait for edit mode to activate
    await this.#page.waitForSelector(".list-item.editing", {
      strategy: "pierce",
    });

    // Find the edit input and type new text
    const editInput = await this.#page.waitForSelector(".edit-input", {
      strategy: "pierce",
    });
    await editInput.evaluate((el: HTMLInputElement) => {
      el.select();
    });
    await editInput.type(newText);
    await this.#page.keyboard.press("Enter");
  }

  async setTitle(title: string): Promise<void> {
    const titleInput = await this.#page.waitForSelector(
      "input[placeholder='List title']",
      { strategy: "pierce" },
    );
    await titleInput.click();
    await titleInput.evaluate((el: HTMLInputElement) => {
      el.select();
    });
    await titleInput.type(title);
  }

  async getTitle(): Promise<string> {
    const titleInput = await this.#page.waitForSelector(
      "input[placeholder='List title']",
      { strategy: "pierce" },
    );
    return await titleInput.evaluate((el: HTMLInputElement) => el.value);
  }
}
