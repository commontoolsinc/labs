import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("instantiate-recipe integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "instantiate-recipe.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should deploy recipe, click button, and navigate to counter", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });

    // Wait for charm to load by waiting for first interactive element
    await page.waitForSelector("[data-ct-input]", { strategy: "pierce" });

    // Store the current URL before any action
    const urlBefore = await page.evaluate(() => globalThis.location.href);
    console.log("URL before action:", urlBefore);

    const input = await page.waitForSelector("[data-ct-input]", {
      strategy: "pierce",
    });

    await input.type("New counter");

    // Quick wait for input processing
    await sleep(100);

    const button = await page.waitForSelector("[data-ct-button]", {
      strategy: "pierce",
    });

    await button.click();

    // Reduced wait for navigation (was 2000ms)
    await sleep(400);

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

    await sleep(200);
  });
});
