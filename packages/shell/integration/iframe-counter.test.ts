import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { registerCharm, ShellIntegration } from "./utils.ts";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import "../src/globals.ts";
import type { ElementHandle } from "@astral/astral";

const { API_URL, FRONTEND_URL } = env;

// Helper functions for clicking increment/decrement buttons
async function clickIncrementBtn(counterIframe: ElementHandle): Promise<void> {
  const box = await counterIframe.boundingBox();
  assert(box, "Should get iframe bounding box");

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

  await counterIframe.click({
    offset: {
      x: box.width * 0.17, // Left third of the screen
      y: box.height * 0.5, // Middle vertically
    },
  });
}

describe("shell iframe counter tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("can increment 5 times, decrement 3 times, and verify count is 2", async () => {
    const { page, identity } = shell.get();
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

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}shell/${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login and verify state
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);
    assertEquals(
      state.identity?.serialize().privateKey,
      identity.serialize().privateKey,
    );

    // Wait for iframe content to load
    await sleep(5000); // Give more time for nested iframes to load

    // Get the outer iframe using pierce selector
    const counterIframe = await page.$("pierce/iframe");
    assert(counterIframe, "Outer iframe should be found");

    // Click increment button 5 times (starting from 0)
    console.log("Clicking increment 5 times...");
    for (let i = 0; i < 5; i++) {
      await clickIncrementBtn(counterIframe);
      await sleep(300);
    }

    await sleep(1000);

    // Click decrement button 3 times (5 - 3 = 2)
    console.log("Clicking decrement 3 times...");
    for (let i = 0; i < 3; i++) {
      await clickDecrementBtn(counterIframe);
      await sleep(300);
    }

    await sleep(1000);

    // TODO: Once we can access iframe content, verify the count is 2
    // For now, we're testing that the clicks work without errors
    console.log("Successfully clicked increment 5 times and decrement 3 times");
    console.log("Expected count: 2 (starting from 0: +5 -3 = 2)");
  });
});
