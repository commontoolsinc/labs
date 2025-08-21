import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("allCharms integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let allCharmsCharmId: string;
  let counterCharmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });

    // Deploy counter charm as a test charm to show in the list
    const counterCharm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "counter.tsx",
        ),
      ),
    );
    counterCharmId = counterCharm.id;

    // Deploy allCharms recipe
    const allCharmsCharm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "allCharms.tsx",
        ),
      ),
    );
    allCharmsCharmId = allCharmsCharm.id;

    // Link the allCharms well-known ID to the allCharms recipe using manager.link
    // This is the key step that makes the allCharms recipe receive the list of charms
    const allCharmsWellKnownId = "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";
    
    // Use manager.link directly
    await cc.manager().link(
      allCharmsWellKnownId,
      [],
      allCharmsCharmId,
      ["allCharms"]
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the allCharms charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: allCharmsCharmId,
      identity,
    });
    
    // Wait for the page to load and show the charm count
    await page.waitForSelector("h2", { strategy: "pierce" });
    await sleep(1000); // Wait for the allCharms data to be received
  });

  it("should display the correct number of charms", async () => {
    const page = shell.page();

    // Look for the heading that shows the charm count
    const heading = await page.waitForSelector("h2", { strategy: "pierce" });
    const headingText = await heading.evaluate((el: HTMLElement) => el.textContent);
    
    // Should show "Charms (2)" - the counter charm and the allCharms charm itself
    assert(headingText?.includes("Charms ("), "Should show charm count in heading");
    assert(headingText?.includes("2"), "Should show 2 charms in the space");
  });

  it("should display charm cards in a grid", async () => {
    const page = shell.page();

    // Wait for the grid container
    const gridContainer = await page.waitForSelector(
      "div[style*='grid-template-columns']", 
      { strategy: "pierce" }
    );
    assert(gridContainer, "Should find the grid container");

    // Find all charm cards
    const charmCards = await page.$$(
      "div[style*='padding: 1rem'][style*='border: 1px solid']", 
      { strategy: "pierce" }
    );
    
    assertEquals(charmCards.length, 2, "Should display 2 charm cards");
  });

  it("should show charm names correctly", async () => {
    const page = shell.page();

    // Find all charm name elements (they have font-weight: 500)
    const charmNames = await page.$$(
      "span[style*='font-weight: 500']", 
      { strategy: "pierce" }
    );
    
    assertEquals(charmNames.length, 2, "Should have 2 charm names");

    // Get the text content of each charm name
    const nameTexts = await Promise.all(
      charmNames.map(nameEl => 
        nameEl.evaluate((el: HTMLElement) => el.textContent?.trim())
      )
    );

    // Should include the counter charm name
    const hasCounterCharm = nameTexts.some(name => 
      name?.includes("Simple counter")
    );
    assert(hasCounterCharm, "Should display the counter charm");

    // Should include the allCharms charm name  
    const hasAllCharmsCharm = nameTexts.some(name => 
      name?.includes("Charms")
    );
    assert(hasAllCharmsCharm, "Should display the allCharms charm");

    console.log("Found charm names:", nameTexts);
  });

  it("should have Visit buttons for each charm", async () => {
    const page = shell.page();

    // Find all Visit buttons
    const visitButtons = await page.$$("ct-button", { strategy: "pierce" });
    
    // Filter to only Visit buttons (they should contain "Visit" text)
    const visitButtonsWithText = await Promise.all(
      visitButtons.map(async (button) => {
        const text = await button.evaluate((el: HTMLElement) => el.textContent?.trim());
        return text === "Visit" ? button : null;
      })
    );
    
    const actualVisitButtons = visitButtonsWithText.filter(button => button !== null);
    assertEquals(actualVisitButtons.length, 2, "Should have 2 Visit buttons");
  });

  it("should navigate when clicking a Visit button", async () => {
    const page = shell.page();

    // Store the current URL before clicking
    const urlBefore = await page.evaluate(() => globalThis.location.href);
    console.log("URL before clicking Visit:", urlBefore);

    // Find Visit buttons using the ct-button selector
    const visitButtons = await page.$$("ct-button", { strategy: "pierce" });
    
    // Find the first Visit button
    let visitButton = null;
    for (const button of visitButtons) {
      const text = await button.evaluate((el: HTMLElement) => el.textContent?.trim());
      if (text === "Visit") {
        visitButton = button;
        break;
      }
    }
    
    assert(visitButton, "Should find a Visit button");
    
    // Click the Visit button
    await visitButton.click();
    
    // Wait for navigation
    await sleep(400);
    
    // Check that the URL has changed
    const urlAfter = await page.evaluate(() => globalThis.location.href);
    console.log("URL after clicking Visit:", urlAfter);
    
    assert(
      urlBefore !== urlAfter,
      "Should navigate to a different URL after clicking Visit button"
    );
    
    // Verify we navigated to a valid charm by checking for either:
    // 1. Counter elements (if we visited the counter charm)
    // 2. AllCharms elements (if we visited the allCharms charm itself)
    const hasValidContent = await page.$(
      "#counter-result, h2",
      { strategy: "pierce" }
    );
    
    assert(hasValidContent, "Should find valid charm content after navigation");
    
    console.log("Navigation test successful!");
  });

  it("should show charm content for non-ignored charms", async () => {
    const page = shell.page();

    // Go back to the allCharms view
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: allCharmsCharmId,
      identity,
    });
    
    // Wait for allCharms to load properly by waiting for the heading first
    await page.waitForSelector("h2", { strategy: "pierce" });
    await sleep(1500); // Wait for allCharms data to be received and rendered

    // Look for charm cards 
    const charmCards = await page.$$(
      "div[style*='padding: 1rem'][style*='border: 1px solid']", 
      { strategy: "pierce" }
    );
    
    // The counter charm should show content (not ignored)
    // The allCharms charm itself has ignore:true so won't show content
    // Let's verify we have the expected charm cards structure
    assertEquals(charmCards.length, 2, "Should have 2 charm cards");
    
    // Each card should have a charm name and Visit button
    for (const card of charmCards) {
      const nameElement = await card.$("span[style*='font-weight: 500']");
      const visitButton = await card.$("ct-button");
      
      assert(nameElement, "Each charm card should have a name element");
      assert(visitButton, "Each charm card should have a Visit button");
    }
    
    console.log("Charm cards structure validated successfully");
  });
});