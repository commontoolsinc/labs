import { env, Page, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("list-operations simple test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "list-operations.tsx",
        ),
      ),
      { start: false },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load and interact with the list-operations charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        charmId: charm.id,
      },
      identity,
    });

    // Wait for the main list display to appear
    await page.waitForSelector("#main-list", { strategy: "pierce" });

    // Click reset to populate with initial data
    const resetBtn = await page.waitForSelector("#reset-demo", {
      strategy: "pierce",
    });
    await resetBtn.click();

    // Wait for the reset operation to complete by checking the text content
    await waitFor(async () => {
      const initialText = await getMainListText(page);
      return initialText === "A, B, C, D (4)";
    });

    // Test delete first item
    const deleteFirstBtn = await page.waitForSelector("#delete-first", {
      strategy: "pierce",
    });
    await deleteFirstBtn.click();

    // Wait for delete to complete
    await waitFor(async () => {
      return (await getMainListText(page)) === "B, C, D (3)";
    });

    const afterDeleteText = await getMainListText(page);
    assertEquals(
      afterDeleteText,
      "B, C, D (3)",
      "Should have B, C, D (3) after deleting first",
    );

    // Test insert at start
    const insertStartBtn = await page.waitForSelector("#insert-start", {
      strategy: "pierce",
    });
    await insertStartBtn.click();

    // Wait for insert to complete
    await waitFor(async () => {
      return (await getMainListText(page)) === "New Start, B, C, D (4)";
    });

    const afterInsertText = await getMainListText(page);
    assertEquals(
      afterInsertText,
      "New Start, B, C, D (4)",
      "Should have New Start at beginning",
    );

    // Test one more operation: delete-last to see if it works
    const deleteLastBtn = await page.waitForSelector("#delete-last", {
      strategy: "pierce",
    });
    await deleteLastBtn.click();

    await waitFor(async () => {
      const text = await getMainListText(page);
      return text === "New Start, B, C (3)";
    });

    const finalText = await getMainListText(page);
    assertEquals(
      finalText,
      "New Start, B, C (3)",
      "Should show New Start, B, C (3) after delete-last",
    );
  });
});

// Returns the text content of the #main-list, waiting
// for it to render.
// If a failure occurs, `null` is returned, which could occur
// when the element is found, but then becomes inaccessible.
async function getMainListText(page: Page): Promise<string | null> {
  const mainList = await page.waitForSelector("#main-list", {
    strategy: "pierce",
  });
  try {
    return await mainList.evaluate((el: HTMLElement) => el.textContent || "");
  } catch (_) {
    return null;
  }
}
