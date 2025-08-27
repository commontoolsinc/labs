import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("list-operations simple test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;
  let spaceName: string;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    // Use a unique space name to avoid conflicts between test runs
    spaceName = `${SPACE_NAME}-${Date.now()}-${
      Math.random().toString(36).slice(2)
    }`;
    cc = await CharmsController.initialize({
      spaceName: spaceName,
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
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load and interact with the list-operations charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: spaceName,
      charmId: charm.id,
      identity,
    });

    // Wait for the main list display to appear
    await page.waitForSelector("#main-list", { strategy: "pierce" });

    // Click reset to populate with initial data
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    assert(resetBtn, "Should find reset button");
    await resetBtn.click();

    // Wait for the reset operation to complete by checking the text content
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    assert(mainList, "Should find main list element");

    await waitFor(async () => {
      const initialText = await mainList!.evaluate((el: HTMLElement) =>
        el.textContent || ""
      );
      return initialText === "A, B, C, D (4)";
    });

    // Verify the list populated correctly
    const initialText = await mainList!.evaluate((el: HTMLElement) =>
      el.textContent || ""
    );
    assertEquals(
      initialText,
      "A, B, C, D (4)",
      "Should have A, B, C, D (4) after reset",
    );

    // Test delete first item
    const deleteFirstBtn = await page.$("#delete-first", {
      strategy: "pierce",
    });
    await deleteFirstBtn!.click();

    // Wait for delete to complete
    await waitFor(async () => {
      const currentMainList = await page.$("#main-list", {
        strategy: "pierce",
      });
      const text = await currentMainList!.evaluate((el: HTMLElement) =>
        el.textContent || ""
      );
      return text === "B, C, D (3)";
    });

    const currentMainList = await page.$("#main-list", { strategy: "pierce" });
    const afterDeleteText = await currentMainList!.evaluate((el: HTMLElement) =>
      el.textContent || ""
    );
    assertEquals(
      afterDeleteText,
      "B, C, D (3)",
      "Should have B, C, D (3) after deleting first",
    );

    // Test insert at start
    const insertStartBtn = await page.$("#insert-start", {
      strategy: "pierce",
    });
    await insertStartBtn!.click();

    // Wait for insert to complete
    await waitFor(async () => {
      const insertMainList = await page.$("#main-list", { strategy: "pierce" });
      const text = await insertMainList!.evaluate((el: HTMLElement) =>
        el.textContent || ""
      );
      return text === "New Start, B, C, D (4)";
    });

    const insertMainList = await page.$("#main-list", { strategy: "pierce" });
    const afterInsertText = await insertMainList!.evaluate((el: HTMLElement) =>
      el.textContent || ""
    );
    assertEquals(
      afterInsertText,
      "New Start, B, C, D (4)",
      "Should have New Start at beginning",
    );

    // Test one more operation: delete-last to see if it works
    const deleteLastBtn = await page.$("#delete-last", { strategy: "pierce" });
    await deleteLastBtn!.click();

    await waitFor(async () => {
      const deleteLastMainList = await page.$("#main-list", {
        strategy: "pierce",
      });
      const text = await deleteLastMainList!.evaluate((el: HTMLElement) =>
        el.textContent || ""
      );
      return text === "New Start, B, C (3)";
    });

    const finalMainList = await page.$("#main-list", { strategy: "pierce" });
    const finalText = await finalMainList!.evaluate((el: HTMLElement) =>
      el.textContent || ""
    );
    assertEquals(
      finalText,
      "New Start, B, C (3)",
      "Should show New Start, B, C (3) after delete-last",
    );
  });
});
