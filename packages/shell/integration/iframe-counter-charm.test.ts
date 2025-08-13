/**
 * Integration test for iframe counter recipe.
 *
 * This test uses coordinate-based clicking due to iframe sandbox restrictions
 * that prevent direct DOM access. The counter recipe has a full-screen layout
 * divided into three sections:
 * - Left third: Decrement area (red)
 * - Center third: Count display
 * - Right third: Increment area (green)
 *
 * State verification is done through the charm controller API rather than
 * DOM inspection, as the iframe content is not directly accessible.
 */

import { env, Page } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import type { ElementHandle } from "@astral/astral";
import { Identity } from "@commontools/identity";

const { API_URL, FRONTEND_URL } = env;

// Helper functions for coordinate-based clicking on the iframe
// These click specific regions of the iframe since we cannot access
// the actual buttons due to sandbox restrictions
async function clickIncrementBtn(counterIframe: ElementHandle): Promise<void> {
  const box = await counterIframe.boundingBox();
  assert(box, "Should get iframe bounding box");

  // Click the right third of the iframe where the increment area is located
  await counterIframe.click({
    offset: {
      x: box.width * 0.83, // Right third of the screen
      y: box.height * 0.5, // Middle vertically
    },
  });
}

async function clickDecrementBtn(counterIframe: ElementHandle): Promise<void> {
  const box = await counterIframe.boundingBox();
  assert(box, "Should get iframe bounding box");

  // Click the left third of the iframe where the decrement area is located
  await counterIframe.click({
    offset: {
      x: box.width * 0.17, // Left third of the screen
      y: box.height * 0.5, // Middle vertically
    },
  });
}

// Helper function to get the active charm's result from the app
async function getCharmResult(page: Page): Promise<any> {
  // First get the app view element using pierce selector
  const appView = await page.$("x-app-view", { strategy: "pierce" });
  if (!appView) {
    throw new Error("Could not find x-app-view element");
  }

  // Use the element handle to evaluate in its context
  return await appView.evaluate((element: any) => {
    // Access the private _activeCharm property
    const activeCharmTask = element._activeCharm;

    if (!activeCharmTask) {
      throw new Error("No _activeCharm property found on element");
    }

    if (!activeCharmTask.value) {
      throw new Error("No active charm value found");
    }

    // Get the charm controller from the Task's value
    const charmController = activeCharmTask.value;

    // Get the result from the charm controller
    const result = charmController.getResult();

    return result;
  });
}

describe("shell iframe counter tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can increment 5 times, decrement 3 times, and verify count is 2", async () => {
    const page = shell.page();
    const identity = await Identity.generate({ implementation: "noble" });
    const spaceName = globalThis.crypto.randomUUID();

    // Register the iframe counter recipe as a charm
    const charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "integration",
          "iframe-counter-recipe.tsx",
        ),
      ),
    });

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName,
      charmId,
      identity,
    });

    // Wait for iframe content to load
    // The charm uses nested iframes with sandbox restrictions, requiring coordinate-based interaction
    await sleep(5000);

    // Get the iframe element using pierce selector to traverse shadow DOM
    const counterIframe = await page.$("iframe", { strategy: "pierce" });
    assert(counterIframe, "Outer iframe should be found");

    // Click the right third of the iframe 5 times to increment (starting from 0)
    console.log("Clicking increment area 5 times...");
    for (let i = 0; i < 5; i++) {
      await clickIncrementBtn(counterIframe);
      await sleep(300);
    }

    await sleep(1000);

    // Click the left third of the iframe 3 times to decrement (5 - 3 = 2)
    console.log("Clicking decrement area 3 times...");
    for (let i = 0; i < 3; i++) {
      await clickDecrementBtn(counterIframe);
      await sleep(300);
    }

    await sleep(1000);

    // Get the charm's result and verify the count
    console.log("Getting charm result to verify count...");
    const charmResult = await getCharmResult(page);
    console.log("Charm result:", charmResult);

    // Verify the count is 2
    assertEquals(
      charmResult.count,
      2,
      "Count should be 2 after 5 increments and 3 decrements",
    );
    console.log("✅ Successfully verified count is 2");

    // Reload the page to test persistence
    console.log("\nReloading page to test persistence...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName,
      charmId,
      identity,
    });

    // Wait for the page and iframe to load
    await sleep(5000);

    // Get the iframe again after reload
    const counterIframeAfterReload = await page.$("iframe", {
      strategy: "pierce",
    });
    assert(
      counterIframeAfterReload,
      "Outer iframe should be found after reload",
    );

    // Click the right third of the iframe 4 times to increment
    console.log("Clicking increment area 4 times after reload...");
    for (let i = 0; i < 4; i++) {
      await clickIncrementBtn(counterIframeAfterReload);
      await sleep(300);
    }

    await sleep(1000);

    // Get the charm's result and verify the count is now 6
    console.log("Getting charm result after reload and increments...");
    const charmResultAfterReload = await getCharmResult(page);
    console.log("Charm result after reload:", charmResultAfterReload);

    // Verify the count is 6 (2 + 4)
    assertEquals(
      charmResultAfterReload.count,
      6,
      "Count should be 6 after reload (2 + 4 increments)",
    );
    console.log("✅ Successfully verified count persistence and is now 6");
  });
});
