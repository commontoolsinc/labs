import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("instantiate-recipe integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();

    // Register the instantiate-recipe charm
    charmId = await registerCharm({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "instantiate-recipe.tsx",
        ),
      ),
    });
  });

  it("should deploy recipe, click button, and navigate to counter", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${SPACE_NAME}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, SPACE_NAME);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and render
    await sleep(1500);

    // Store the current URL before any action
    const urlBefore = await page.evaluate(() => globalThis.location.href);
    console.log("URL before action:", urlBefore);

    const input = await page.waitForSelector("[data-ct-input]", {
      strategy: "pierce",
    });

    await input.type("New counter");

    // Wait for input to be processed
    await sleep(200);

    const button = await page.waitForSelector("[data-ct-button]", {
      strategy: "pierce",
    });

    await button.click();

    // Wait for navigation to complete
    await sleep(500);

    // Check if we navigated to a new counter instance
    const urlAfter = await page.evaluate(() => globalThis.location.href);
    console.log("URL after clicking:", urlAfter);

    // Verify navigation happened (URL should have changed)
    assert(
      urlBefore !== urlAfter,
      "Should navigate to a new URL after clicking Add button",
    );

    // Verify we're now on a counter page by checking for counter-specific elements
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(
      counterResult,
      "Should find counter-result element after navigation",
    );

    await sleep(500);
  });
});
