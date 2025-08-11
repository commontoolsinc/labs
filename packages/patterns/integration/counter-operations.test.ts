import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import {
  registerCharm,
  ShellIntegration,
} from "@commontools/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { getCharmResult, setCharmResult } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter direct operations test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;

  beforeAll(async () => {
    const { identity } = shell.get();

    // Register the counter charm
    charmId = await registerCharm({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
      source: await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "counter.tsx",
        ),
      ),
    });

    // Setup the CharmManager for direct operations
    await shell.setupManager(SPACE_NAME, API_URL);
  });

  it("should load the counter charm and verify initial state", async () => {
    const { page } = shell.get();

    // Navigate to the charm
    await page.goto(`${FRONTEND_URL}${SPACE_NAME}/${charmId}`);
    await page.applyConsoleFormatter();

    // Login
    const state = await shell.login();
    assertEquals(state.spaceName, SPACE_NAME);
    assertEquals(state.activeCharmId, charmId);

    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element");

    // Verify initial value is 0
    const initialText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(initialText?.trim(), "Counter is the 0th number");

    // Also verify via direct operations
    const manager = shell.manager!;
    const value = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(value, 0);
  });

  // Bug Reproduction for CT-753: Live updates across sessions don't work currently
  // The browser has its own runtime/session that doesn't receive
  // live updates from our test CharmManager's operations
  it.skip("should update counter value via direct operation (live)", async () => {
    const { page } = shell.get();
    const manager = shell.manager!;

    // Get the counter result element
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });

    // Update value to 42 via direct operation
    console.log("Setting counter value to 42 via direct operation");
    await setCharmResult(manager, charmId, ["value"], 42);

    // Wait for the update to propagate
    await sleep(3000);

    // Verify the UI updated
    const updatedText = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      updatedText?.trim(),
      "Counter is the 42th number",
      "UI should update to show 42th",
    );

    // Verify we can also read the value back
    const finalValue = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(finalValue, 42);
  });

  it("should update counter value and verify after page refresh", async () => {
    const { page } = shell.get();
    const manager = shell.manager!;

    // Update value to 42 via direct operation
    console.log("Setting counter value to 42 via direct operation");
    await setCharmResult(manager, charmId, ["value"], 42);

    // Verify we can read the value back via operations
    const updatedValue = await getCharmResult(manager, charmId, ["value"]);
    assertEquals(updatedValue, 42, "Value should be 42 in backend");

    // Now refresh the page by navigating to the same URL
    console.log("Refreshing the page...");
    await page.goto(`${FRONTEND_URL}${SPACE_NAME}/${charmId}`);

    // Need to login again after navigation
    await shell.login();

    // Get the counter result element after refresh
    const counterResult = await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });
    assert(counterResult, "Should find counter-result element after refresh");

    // Check if the UI shows the updated value after refresh
    const textAfterRefresh = await counterResult.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      textAfterRefresh?.trim(),
      "Counter is the 42th number",
      "UI should show persisted value after refresh",
    );
  });
});
