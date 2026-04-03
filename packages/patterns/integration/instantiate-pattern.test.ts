import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { PiecesController } from "@commontools/piece/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

// TODO(CT-1101) Need to re-enable these tests to make them more robust
const ignore = true;

describe("instantiate-pattern integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let pieceId: string;
  let identity: Identity;
  let cc: PiecesController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const piece = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "examples",
          "instantiate-pattern.tsx",
        ),
      ),
      { start: false },
    );
    pieceId = piece.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it({
    name: "should deploy pattern, click button, and navigate to counter",
    ignore,
    fn: async () => {
      const page = shell.page();

      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });

      // Wait for piece to load by waiting for first interactive element
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

      // Wait for page to soft navigate
      await page.waitForFunction((urlBefore) => {
        return globalThis.location.href !== urlBefore;
      }, { args: [urlBefore] });

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
    },
  });
});
