import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import {
  clickShadowElement,
  typeInShadowInput,
} from "./shadow-dom-utils.ts";

const { API_URL, FRONTEND_URL } = env;

// Shadow DOM paths for ct-message-input in CommonTools shell
const CT_MESSAGE_INPUT_PATH = [
  "x-root-view",
  "x-app-view",
  "x-body-view",
  "x-charm-view",
  "common-charm",
  "ct-render",
  "ct-message-input",
  "ct-input",
  "input",
];

const CT_MESSAGE_INPUT_BUTTON_PATH = [
  "x-root-view",
  "x-app-view",
  "x-body-view",
  "x-charm-view",
  "common-charm",
  "ct-render",
  "ct-message-input",
  "ct-button",
];

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
    const urlBefore = await page.evaluate(() => window.location.href);
    console.log("URL before action:", urlBefore);

    // Type in the input field
    await typeInShadowInput(page, CT_MESSAGE_INPUT_PATH, "New counter");

    // Wait for input to be processed
    await sleep(500);

    // Click the send button
    await clickShadowElement(page, CT_MESSAGE_INPUT_BUTTON_PATH);

    // Wait for navigation to complete
    await sleep(500);

    // Check if we navigated to a new counter instance
    const urlAfter = await page.evaluate(() => window.location.href);
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
