import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("list-operations integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: "test-list-ops-fixed",
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    // Use the fixed charm that we already deployed
    charmId = "baedreifm4fxcj2slu5biszmym5sbqivzj6nvnngx2o5g4imxggvf2laxuy";
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the list-operations charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: "test-list-ops-fixed",
      charmId,
      identity,
    });
    
    // Wait for the main list display to appear
    await page.waitForSelector("#main-list", { strategy: "pierce" });
    await sleep(500); // Give component time to fully initialize
    
    // Click reset to populate with initial data
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    assert(resetBtn, "Should find reset button");
    await resetBtn.click();
    await sleep(300); // Wait for the reset operation to complete
    
    // Verify the list populated correctly
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const initialText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(initialText, "A, B, C, D (4)", "Should have A, B, C, D (4) after reset");
  });

  it.skip("should reset the demo to initial state", async () => {
    const page = shell.page();
    
    // Reset to get initial state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    assert(resetBtn, "Should find reset button");
    await resetBtn.click();
    await sleep(300); // Wait for DOM to update
    
    // First, modify the list by deleting an item
    const deleteFirstBtn = await page.$("#delete-first", { strategy: "pierce" });
    assert(deleteFirstBtn, "Should find delete first button");
    await deleteFirstBtn.click();
    
    // Wait for the deletion to take effect
    await page.waitForFunction(() => {
      const mainList = document.querySelector("#main-list");
      return mainList?.textContent?.includes("B, C, D (3)");
    });
    
    // Verify it changed
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const modifiedText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(modifiedText, "B, C, D (3)", "Should have removed first item");
    
    // Now reset again
    await resetBtn.click();
    await sleep(300); // Wait for DOM to update
    
    // Verify reset worked
    const resetText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(resetText, "A, B, C, D (4)", "Should be back to initial state");
  });

  it.skip("should delete first item", async () => {
    const page = shell.page();
    
    // Reset to get initial state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(100);
    
    const deleteFirstBtn = await page.$("#delete-first", { strategy: "pierce" });
    assert(deleteFirstBtn, "Should find delete first button");
    await deleteFirstBtn.click();
    
    // Wait for the delete to take effect
    await page.waitForFunction(() => {
      const mainList = document.querySelector("#main-list");
      return mainList?.textContent?.includes("B, C, D (3)");
    });
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const text = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(text, "B, C, D (3)", "Should have removed A and show B, C, D (3)");
    
    // Check derived lists update accordingly
    const filteredList = await page.$("#filtered-list", { strategy: "pierce" });
    const filteredText = await filteredList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(filteredText, " (0)", "Filtered list should be empty since no items < B");
  });

  it("should delete last item", async () => {
    const page = shell.page();
    
    // Reset first
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(100);
    
    const deleteLastBtn = await page.$("#delete-last", { strategy: "pierce" });
    assert(deleteLastBtn, "Should find delete last button");
    await deleteLastBtn.click();
    await sleep(300);
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const text = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(text, "A, B, C (3)", "Should have removed D and show A, B, C (3)");
  });

  it("should delete all items", async () => {
    const page = shell.page();
    
    const deleteAllBtn = await page.$("#delete-all", { strategy: "pierce" });
    assert(deleteAllBtn, "Should find delete all button");
    await deleteAllBtn.click();
    await sleep(300);
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const text = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(text, " (0)", "Should be empty");
    
    // Check that extended list still shows E, F
    const extendedList = await page.$("#extended-list", { strategy: "pierce" });
    const extendedText = await extendedList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(extendedText, "E, F (2)", "Extended list should still show E, F (2)");
  });

  it("should insert item at start", async () => {
    const page = shell.page();
    
    // Reset to get initial state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(100);
    
    const insertStartBtn = await page.$("#insert-start", { strategy: "pierce" });
    assert(insertStartBtn, "Should find insert start button");
    await insertStartBtn.click();
    await sleep(300);
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const text = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(text, "New Start, A, B, C, D (5)", "Should have New Start at beginning");
  });

  it("should insert item at end", async () => {
    const page = shell.page();
    
    // Reset to get initial state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(100);
    
    const insertEndBtn = await page.$("#insert-end", { strategy: "pierce" });
    assert(insertEndBtn, "Should find insert end button");
    await insertEndBtn.click();
    await sleep(300);
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const text = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(text, "A, B, C, D, New End (5)", "Should have New End at end");
  });

  it.skip("should verify derived list operations", async () => {
    const page = shell.page();
    
    // Reset to known state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(100);
    
    // Check lowercase transformation
    const lowercaseList = await page.$("#lowercase-list", { strategy: "pierce" });
    const lowercaseText = await lowercaseList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(lowercaseText, "a,b,c,d", "Lowercase list should show a,b,c,d");
    
    // Check filtered list (items < "B")
    const filteredList = await page.$("#filtered-list", { strategy: "pierce" });
    const filteredText = await filteredList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(filteredText, "A (1)", "Filtered list should show only A (1)");
    
    // Check extended list (original + E, F)
    const extendedList = await page.$("#extended-list", { strategy: "pierce" });
    const extendedText = await extendedList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(extendedText, "A, B, C, D, E, F (6)", "Extended list should show A, B, C, D, E, F (6)");
    
    // Check combined list (concatenated string)
    const combinedList = await page.$("#combined-list", { strategy: "pierce" });
    const combinedText = await combinedList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(combinedText, "ABCD", "Combined list should show ABCD");
  });

  it("should handle multiple operations in sequence", async () => {
    const page = shell.page();
    
    // Reset to get initial state
    const resetBtn = await page.$("#reset-demo", { strategy: "pierce" });
    await resetBtn!.click();
    await sleep(300);
    
    // Add item at start
    const insertStartBtn = await page.$("#insert-start", { strategy: "pierce" });
    await insertStartBtn!.click();
    await sleep(300);
    
    // Add item at end
    const insertEndBtn = await page.$("#insert-end", { strategy: "pierce" });
    await insertEndBtn!.click();
    await sleep(300);
    
    // Delete first item (should remove "New Start")
    const deleteFirstBtn = await page.$("#delete-first", { strategy: "pierce" });
    await deleteFirstBtn!.click();
    await sleep(300);
    
    const mainList = await page.$("#main-list", { strategy: "pierce" });
    const finalText = await mainList!.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(finalText, "A, B, C, D, New End (5)", "Should show A, B, C, D, New End (5)");
  });

  // Note: We skip testing shuffle as it's inherently non-deterministic
  // The shuffle function works but produces random results that can't be reliably tested
});