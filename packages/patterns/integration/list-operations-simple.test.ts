import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL } = env;

describe("list-operations simple test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: "test-list-ops-fixed",
      apiUrl: new URL(API_URL),
      identity: identity,
    });
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load and interact with the list-operations charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: "test-list-ops-fixed",
      charmId: "baedreifm4fxcj2slu5biszmym5sbqivzj6nvnngx2o5g4imxggvf2laxuy",
      identity,
    });
    
    // Wait for the main list display to appear
    await page.waitForSelector("#main-list", { strategy: "pierce" });
    await sleep(500); // Give component time to fully initialize
    
    // Click reset to populate with initial data
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    assert(resetBtn, "Should find reset button");
    await resetBtn.click();
    await sleep(500); // Wait for the reset operation to complete
    
    // Verify the list populated correctly
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const initialText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(initialText, "A, B, C, D (4)", "Should have A, B, C, D (4) after reset");
    
    // Test delete first item
    const deleteFirstBtn = await page.$("#delete-first", { strategy: "pierce" });
    await deleteFirstBtn!.click();
    await sleep(500);
    
    const afterDeleteText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(afterDeleteText, "B, C, D (3)", "Should have B, C, D (3) after deleting first");
    
    // Test insert at start
    const insertStartBtn = await page.$("#insert-start", { strategy: "pierce" });
    await insertStartBtn!.click();
    await sleep(500);
    
    const afterInsertText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(afterInsertText, "New Start, B, C, D (4)", "Should have New Start at beginning");
  });
});