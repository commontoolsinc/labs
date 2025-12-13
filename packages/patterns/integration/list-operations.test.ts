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
    // Use waitFor with try/catch to handle unstable box model during page settling
    await clickButton(page, "#reset-demo");

    // Wait for the reset operation to complete by checking the text content
    await waitFor(async () => {
      const initialText = await getMainListText(page);
      return initialText === "A, B, C, D (4)";
    });

    // Test delete first item
    await clickButton(page, "#delete-first");

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
    await clickButton(page, "#insert-start");

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
    await clickButton(page, "#delete-last");

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

// Clicks a button, retrying if the element lacks a stable box model.
// This handles timing issues where the element is found but the page
// is still settling (re-renders, layout shifts, hydration).
function clickButton(page: Page, selector: string): Promise<void> {
  return waitFor(async () => {
    const btn = await page.waitForSelector(selector, { strategy: "pierce" });
    try {
      await btn.click();
      return true;
    } catch (_) {
      return false;
    }
  });
}
