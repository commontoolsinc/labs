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
  getCharmResult,
  setCharmInput,
  setCharmResult,
} from "@commontools/charm/ops";
import { getCharmInput } from "../../charm/src/ops/cell-operations.ts";

const { API_URL, FRONTEND_URL } = env;

describe("fetchData() test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let spaceName: string;
  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();
    spaceName = globalThis.crypto.randomUUID();

    // Register the counter charm
    charmId = await registerCharm({
      spaceName: spaceName,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "fetch-data.tsx",
        ),
      ),
    });

    // Setup the CharmManager for direct operations
    await shell.setupManager(spaceName, API_URL);
  });

  it("should load the github fetcher charm and verify initial state", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and verify counter exists
    await sleep(5000);
    const counterResult = await page.$("#github-title", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find github title element");

    // Verify initial value is 0
    const initialText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(initialText?.trim(), "next.js");

    // Also verify via direct operations
    const manager = shell.manager!;
    const repoUrl = await getCharmInput(manager, charmId, ["repoUrl"]);
    assertEquals(repoUrl, "https://github.com/vercel/next.js");
  });

  it("should load the github fetcher charm and verify initial state", async () => {
    const { page } = shell.get();
    const manager = shell.manager!;

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, spaceName);
    assertEquals(state.activeCharmId, charmId);

    // Wait for charm to load and verify counter exists
    await sleep(1000);
    await setCharmInput(
      manager,
      charmId,
      ["repoUrl"],
      "https://github.com/commontoolsinc/labs",
    );
    await sleep(1000);

    // Now refresh the page by navigating to the same URL
    console.log("Refreshing the page...");
    await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
    // Need to login again after navigation
    await shell.login();
    await sleep(5000);

    const counterResult = await page.$("#github-title", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find github title element");

    // Verify initial value is 0
    const initialText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(initialText?.trim(), "labs");

    // Also verify via direct operations
    const repoUrl = await getCharmInput(shell.manager!, charmId, ["repoUrl"]);
    assertEquals(repoUrl, "https://github.com/commontoolsinc/labs");
  });
});
