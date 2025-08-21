import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { getCharmInput, setCharmInput } from "@commontools/charm/ops";
import { Identity } from "@commontools/identity";
import { TEST_HTTP } from "./flags.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const ignore = !TEST_HTTP;

// Fetch data tests may require network access and are skipped in CI until we handle external dependencies properly in CI environments.
// This requires either:
// 1. Adding a flag to enable network tests in CI with proper mocking
// 2. Using mock data or fixtures for CI testing
describe("fetch data integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  if (!ignore) {
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
            "fetch-data.tsx",
          ),
        ),
      );
      charmId = charm.id;
    });

    afterAll(async () => {
      if (cc) await cc.dispose();
    });
  }

  it({
    name: "should load the github fetcher charm and verify initial state",
    ignore,
    fn: async () => {
      const page = shell.page();
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        spaceName: SPACE_NAME,
        charmId,
        identity,
      });

      // Wait for charm to load and verify github title exists
      const titleElement = await page.waitForSelector("#github-title", {
        strategy: "pierce",
      });
      assert(titleElement, "Should find github title element");

      // Verify initial value
      const initialText = await titleElement.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(initialText?.trim(), "next.js");

      // Also verify via direct operations
      const manager = cc.manager();
      const repoUrl = await getCharmInput(manager, charmId, ["repoUrl"]);
      assertEquals(repoUrl, "https://github.com/vercel/next.js");
    },
  });

  it({
    name: "should update repo URL and verify data refetches",
    ignore,
    fn: async () => {
      const page = shell.page();
      const manager = cc.manager();

      // Set new repo URL via direct operation
      await setCharmInput(
        manager,
        charmId,
        ["repoUrl"],
        "https://github.com/commontoolsinc/labs",
      );

      await sleep(200);

      // Navigate to the charm to see updated data
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        spaceName: SPACE_NAME,
        charmId,
        identity,
      });

      // Wait for data to load

      const titleElement = await page.waitForSelector("#github-title", {
        strategy: "pierce",
      });
      assert(titleElement, "Should find github title element");

      // Verify updated value
      const updatedText = await titleElement.evaluate((el: HTMLElement) =>
        el.textContent
      );
      assertEquals(updatedText?.trim(), "labs");

      // Also verify via direct operations
      const repoUrl = await getCharmInput(manager, charmId, ["repoUrl"]);
      assertEquals(repoUrl, "https://github.com/commontoolsinc/labs");
    },
  });
});
