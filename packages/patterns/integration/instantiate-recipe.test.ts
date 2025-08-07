import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";

const { API_URL, FRONTEND_URL } = env;

describe("instantiate-recipe integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let spaceName: string;
  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();
    spaceName = globalThis.crypto.randomUUID();

    // Register the instantiate-recipe charm
    charmId = await registerCharm({
      spaceName: spaceName,
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
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and render
    await sleep(500);

    // Store the current URL before any action
    const urlBefore = await page.evaluate(() => globalThis.location.href);
    console.log("URL before action:", urlBefore);

    // Find and type in the input using data attribute with pierce strategy
    const input = await page.$("[data-ct-input]", {
      strategy: "pierce",
    });
    assert(input, "Should find input element");
    
    await input.type("New counter");

    // Wait for input to be processed
    await sleep(200);

    // Find and click the button using data attribute with pierce strategy
    const button = await page.$("[data-ct-button]", {
      strategy: "pierce",
    });
    assert(button, "Should find button element");
    
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
    const counterResult = await page.$("#counter-result", {
      strategy: "pierce",
    });
    assert(
      counterResult,
      "Should find counter-result element after navigation",
    );

    await sleep(500);
  });
});
